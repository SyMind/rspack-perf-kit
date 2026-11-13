import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openPage } from '@rolldown/perf-kit/lib/cdp.mjs';
import { withBrowser } from '../lib/browser.mjs';

const cli = fileURLToPath(new URL('../bin/rspack-perf-kit.mjs', import.meta.url));
const build = fileURLToPath(new URL('../example/build.mjs', import.meta.url));

async function exerciseButton(dist, lazy) {
  await withBrowser(dist, async (cdp, origin) => {
    const page = await openPage(cdp);
    try {
      await page.navigate(origin + '/');
      const result = await page.evaluate(`(async () => {
        if (document.readyState !== 'complete') await new Promise(r => window.addEventListener('load', r, { once: true }));
        const jsCount = () => performance.getEntriesByType('resource').filter(r => new URL(r.name).pathname.endsWith('.js')).length;
        const before = jsCount();
        const button = document.querySelector('button');
        const click = () => new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            observer.disconnect();
            clearTimeout(timer);
            resolve();
          });
          const timer = setTimeout(() => { observer.disconnect(); reject(new Error('button did not toggle')); }, 5000);
          observer.observe(document.querySelector('pre'), { attributes: true, attributeFilter: ['hidden'] });
          button.click();
        });
        await click();
        const highlighted = !!document.querySelector('pre:not([hidden]) .hljs-keyword');
        const after = jsCount();
        await click();
        return { highlighted, closed: document.querySelector('pre').hidden, fetched: after - before };
      })()`);
      assert.ok(result.highlighted && result.closed);
      assert.equal(result.fetched > 0, lazy);
    } finally {
      await page.close();
    }
  });
}

test('pinned scan, lazy build and visible regression in system Chromium', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-browser-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dist = path.join(tmp, 'dist');
  const run = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [cli, 'scan', '--dist', dist, '--json', '--feature', 'page', ...args],
        { encoding: 'utf8' },
      ),
    );
  execFileSync(process.execPath, [build, 'eager', dist]);
  const baseline = run('--pin', '--coverage', '--profile');
  assert.ok(baseline.pinned && baseline.metrics['runtime.lcp_ms'] > 0);
  assert.equal(baseline.coverage.status, 'collected');
  assert.ok(fs.existsSync(path.join(path.dirname(baseline.report), 'startup.cpuprofile')));
  await exerciseButton(dist, false);
  execFileSync(process.execPath, [build, 'lazy', dist]);
  const candidate = run('--parity');
  assert.equal(candidate.parity.passed, true);
  await exerciseButton(dist, true);
  const baselineFile = path.join(tmp, '.rspack-perf-kit', 'targets', 'dist', 'baseline.json');
  const original = fs.readFileSync(baselineFile, 'utf8');
  // Simulate a visually broken build without a graph plugin.
  fs.rmSync(path.join(path.dirname(baselineFile), 'graph.json'));
  const html = path.join(dist, 'index.html');
  fs.writeFileSync(
    html,
    fs.readFileSync(html, 'utf8').replace('</head>', '<style>body{background:#f10}</style></head>'),
  );
  assert.throws(
    () => run('--parity', '--pin'),
    (error) => {
      const result = JSON.parse(error.stdout);
      return error.status === 1 && !result.parity.passed && !result.pinned;
    },
  );
  assert.equal(fs.readFileSync(baselineFile, 'utf8'), original);
});
