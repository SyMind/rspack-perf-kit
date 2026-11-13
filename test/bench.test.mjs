import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/rspack-perf-kit.mjs', import.meta.url));
test('bench preserves argv, reports samples and only pins successful builds', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-bench-test-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const args = ['--', process.execPath, 'build script.cjs', '--value with space'];
  const sample = (...options) =>
    spawnSync(process.execPath, [cli, 'bench', '--json', '--warmup', '0', ...options, ...args], {
      cwd,
      encoding: 'utf8',
    });
  const script = path.join(cwd, 'build script.cjs');
  fs.writeFileSync(
    script,
    "console.log('build output'); if (process.argv[2] !== '--value with space') process.exit(2);",
  );
  const pin = sample('--runs', '3', '--pin');
  assert.equal(pin.status, 0, pin.stderr);
  const first = JSON.parse(pin.stdout);
  assert.equal(first.samplesMs.length, 3);
  const baseline = path.resolve(path.dirname(first.report), '..', 'baseline.json');
  const original = fs.readFileSync(baseline, 'utf8');
  const repeat = sample('--runs', '1');
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).comparison, 'compared');
  fs.writeFileSync(script, 'process.exit(1);');
  const failed = sample('--runs', '3', '--pin');
  assert.notEqual(failed.status, 0);
  assert.equal(fs.readFileSync(baseline, 'utf8'), original);
});
