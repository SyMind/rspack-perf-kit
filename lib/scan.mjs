import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_THROTTLE,
  deltaSection,
  summarize,
  timedRun,
} from '@rolldown/perf-kit/lib/measure.mjs';
import { comparePaints } from '@rolldown/perf-kit/lib/paint-diagnostics.mjs';
import { collectCoverage, collectProfile, withBrowser } from './browser.mjs';
import { summarizeGraph } from './graph.mjs';
import { checkParity, pinOriginal } from './parity.mjs';
import { ensureState, hashDist, loadGraph, readJson, writeJson } from './state.mjs';

export async function scan(target, options) {
  if (!fs.statSync(path.join(target.dist, 'index.html'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('scan needs a static build with an index.html in --dist.');
  }
  if (options.pin && options.runs < 3)
    throw new Error('Pin a baseline with at least three measured runs.');
  if (options.parity && !fs.existsSync(path.join(target.dir, 'original/manifest.json'))) {
    throw new Error('Pin the original build with scan --pin before using --parity.');
  }
  ensureState(target.root);
  const digest = hashDist(target.dist);
  const graph = fs.existsSync(path.join(target.dir, 'graph.json'))
    ? loadGraph(target, digest)
    : null;
  const baselineFile = path.join(target.dir, 'baseline.json');
  const baseline = readJson(baselineFile);
  const runsDir = path.join(target.dir, 'scans');
  fs.mkdirSync(runsDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(runsDir, Date.now() + '-'));
  let completed = false;
  try {
    return await withBrowser(target.dist, async (cdp, origin) => {
      const chrome = await cdp.send('Browser.getVersion');
      const expectedFeatures = [...new Set(options.feature)].sort();
      const throttle = DEFAULT_THROTTLE;
      const conditions = {
        chrome: chrome.product,
        platform: os.platform(),
        arch: os.arch(),
        cpu: os.cpus()[0]?.model,
        throttle,
        expectedFeatures,
      };
      const comparable =
        baseline && JSON.stringify(conditions) === JSON.stringify(baseline.conditions);
      const run = () => timedRun(cdp, { url: origin + '/', throttle, expectedFeatures });
      await run(); // Warm the server and browser process; every navigation disables HTTP caching.
      const samples = [];
      for (let i = 0; i < options.runs; i++) samples.push(await run());
      const summary = summarize(samples, expectedFeatures);
      const { metrics, guard, lcpElement } = summary;
      const delta = comparable ? deltaSection(baseline.metrics, metrics) : null;
      const paint = comparePaints(delta, { noiseFloorMs: 30, noiseFloorPct: 2 });
      const guardsPassed =
        guard.allFeaturesReady &&
        guard.fcpObservedInAllRuns &&
        guard.lcpObservedInAllRuns &&
        samples.every((s) => s.load > 0);
      const clsRegression = (delta?.['runtime.cls']?.delta ?? 0) > 0.02;
      const ctx = { dist: target.dist, origin, throttle, expectedFeatures, sample: samples[0] };
      let coverage, profile, parity;
      if (guardsPassed && options.coverage) {
        coverage = await collectCoverage(cdp, ctx);
        writeJson(path.join(dir, 'coverage.json'), coverage);
      }
      if (guardsPassed && options.profile) {
        const collected = await collectProfile(cdp, ctx);
        profile = collected.summary;
        writeJson(path.join(dir, 'startup.cpuprofile'), collected.profile);
        writeJson(path.join(dir, 'profile.json'), profile);
      }
      if (options.parity) {
        parity = await checkParity(cdp, target, path.join(dir, 'parity'), lcpElement);
        writeJson(path.join(dir, 'parity.json'), parity);
      }
      if (hashDist(target.dist) !== digest)
        throw new Error('Build changed during scan. Run again on a stable dist.');
      const passed = guardsPassed && !clsRegression && (!parity || parity.passed);
      let status = 'no-baseline';
      if (!passed) status = 'guard-failed';
      else if (options.runs < 3) status = 'probe';
      else if (baseline) status = comparable ? paint.state : 'incomparable';
      const pinned = Boolean(options.pin && passed);
      const result = {
        schemaVersion: 1,
        label: options.label,
        distHash: digest,
        runs: options.runs,
        conditions,
        status,
        pinned,
        metrics,
        delta,
        paint,
        guard,
        clsRegression,
        graph: graph && summarizeGraph(graph),
        coverage: coverage && {
          status: coverage.status,
          reason: coverage.reason,
          candidates: coverage.candidates?.slice(0, 10),
          coldAtPaint: coverage.coldAtPaint,
          skipped: coverage.skipped,
        },
        profile: profile && {
          ...profile.attribution,
          topSources: profile.rows.filter((row) => row.kind === 'source').slice(0, 10),
        },
        parity: parity && {
          passed: parity.passed,
          pages: parity.pages.map((p) => ({ page: p.page, state: p.state })),
        },
        report: path.join(dir, 'scan.json'),
      };
      writeJson(result.report, { ...result, samples, lcpElement });
      if (pinned) {
        pinOriginal(target, { distHash: digest, lcpElement });
        writeJson(baselineFile, {
          schemaVersion: 1,
          conditions,
          metrics,
          graph,
          report: result.report,
          distHash: digest,
        });
      }
      completed = true;
      return result;
    });
  } finally {
    if (!completed) fs.rmSync(dir, { recursive: true, force: true });
  }
}
