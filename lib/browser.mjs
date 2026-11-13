import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '@rolldown/perf-kit/lib/cdp.mjs';
import { startServer } from '@rolldown/perf-kit/lib/serve.mjs';
import {
  attributeChunks,
  coldAtPaintModules,
  coverageRun,
} from '@rolldown/perf-kit/lib/coverage.mjs';
import { aggregateProfile, profileRun } from '@rolldown/perf-kit/lib/profile.mjs';
import { onInterrupt } from '@rolldown/perf-kit/lib/interrupt.mjs';

export async function withBrowser(dist, run) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-perf-kit-'));
  const server = await startServer(dist);
  let browser;
  const cleanup = async () => {
    try {
      await browser?.close();
    } finally {
      await server.close();
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4 });
    }
  };
  const unregister = onInterrupt(cleanup);
  try {
    browser = await launchBrowser({ profileDir: profile });
    return await run(browser.cdp, server.origin);
  } finally {
    unregister();
    await cleanup();
  }
}

function readChunk(dist, name) {
  const file = path.resolve(dist, name);
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.existsSync(file + '.map'))
    return null;
  const map = JSON.parse(fs.readFileSync(file + '.map', 'utf8'));
  if (!Array.isArray(map.sources) || typeof map.mappings !== 'string') return null;
  return { code: fs.readFileSync(file, 'utf8'), map };
}

export async function collectCoverage(cdp, { dist, origin, throttle, expectedFeatures, sample }) {
  // Pick a same-origin script requested by the document before falling back to
  // a script it loaded indirectly (including a module bootstrap).
  const scripts = sample.resources.filter(
    (r) =>
      r.name.startsWith('/') && !r.name.startsWith('//') && /\.[cm]?js(?:[?#]|$)/i.test(r.name),
  );
  const entry = scripts.find((r) => r.initiatorType === 'script') ?? scripts[0];
  if (!entry) return { status: 'unavailable', reason: 'No same-origin JavaScript request.' };
  const entryName = new URL(entry.name, origin).pathname;
  const { scripts: captured, scriptFetches } = await coverageRun(cdp, {
    origin,
    throttle,
    expectedFeatures,
    entryName,
  });
  const prePaintFetches = new Map(
    scriptFetches
      .filter((row) => row.prePaint)
      .map((row) => [decodeURIComponent(row.pathname).slice(1), row.bytes]),
  );
  const result = attributeChunks({
    scripts: captured,
    entryName,
    prePaintFetches,
    readChunk: (name) => readChunk(dist, name),
  });
  return {
    status: result.chunks.length ? 'collected' : 'unavailable',
    candidates: result.modules.filter(
      (row) => row.source !== '(unmapped)' && row.totalBytes >= 3072 && row.paintRatio < 0.02,
    ),
    coldAtPaint: coldAtPaintModules(result.modules).slice(0, 10),
    ...result,
  };
}

export async function collectProfile(cdp, { dist, origin, throttle }) {
  const profile = await profileRun(cdp, { origin, throttle });
  const summary = aggregateProfile(profile, { origin, readChunk: (name) => readChunk(dist, name) });
  return { profile, summary };
}
