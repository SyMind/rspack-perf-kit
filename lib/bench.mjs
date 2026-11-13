import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { median } from '@rolldown/perf-kit/lib/measure.mjs';
import { ensureState, readJson, writeJson } from './state.mjs';

async function timeCommand(command) {
  const start = performance.now();
  const child = spawn(command[0], command.slice(1), {
    stdio: ['inherit', process.stderr, process.stderr],
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error('Build command failed (' + (signal ?? 'exit ' + code) + ').'));
    });
  });
  return performance.now() - start;
}

export async function bench(command, options) {
  if (!command.length) throw new Error('Supply a build command after --.');
  if (options.pin && options.runs < 3)
    throw new Error('Pin a baseline with at least three measured runs.');
  const cwd = fs.realpathSync(process.cwd());
  const root = path.join(cwd, '.rspack-perf-kit');
  const conditions = {
    cwd,
    command,
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    warmup: options.warmup,
  };
  const key = createHash('sha256').update(JSON.stringify(command)).digest('hex').slice(0, 16);
  const dir = path.join(root, 'bench', key);
  const baselineFile = path.join(dir, 'baseline.json');
  const baseline = readJson(baselineFile);
  for (let i = 0; i < options.warmup; i++) await timeCommand(command);
  const samples = [];
  for (let i = 0; i < options.runs; i++) samples.push(await timeCommand(command));
  const medianMs = median(samples);
  const comparable = baseline && JSON.stringify(conditions) === JSON.stringify(baseline.conditions);
  const deltaMs = comparable ? medianMs - baseline.medianMs : null;
  ensureState(root);
  fs.mkdirSync(dir, { recursive: true });
  const report = path.join(fs.mkdtempSync(path.join(dir, Date.now() + '-')), 'bench.json');
  const result = {
    schemaVersion: 1,
    label: options.label,
    conditions,
    samplesMs: samples,
    medianMs,
    comparison: baseline ? (comparable ? 'compared' : 'incomparable') : 'no-baseline',
    deltaMs,
    deltaPct: comparable ? (100 * deltaMs) / baseline.medianMs : null,
    pinned: Boolean(options.pin),
    report,
  };
  writeJson(report, result);
  if (options.pin) writeJson(baselineFile, result);
  return result;
}
