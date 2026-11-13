import fs from 'node:fs';
import path from 'node:path';
import { discoverPages, saveAnchor } from '@rolldown/perf-kit/lib/parity/anchor.mjs';
import { compareLcp } from '@rolldown/perf-kit/lib/parity/compare.mjs';
import { runParity } from '@rolldown/perf-kit/lib/parity/run.mjs';
import { hashDist, readJson, writeJson } from './state.mjs';

export function pinOriginal(target, { distHash, lcpElement }) {
  const original = path.join(target.dir, 'original');
  if (fs.existsSync(original)) return;
  const pages = discoverPages(target.dist);
  const temp = fs.mkdtempSync(path.join(target.dir, 'original-'));
  try {
    const manifest = saveAnchor({
      dist: target.dist,
      paths: { anchorDir: temp, anchorDist: path.join(temp, 'dist') },
      pages: [...pages.pages, ...pages.more],
    });
    if (manifest.distHash !== distHash)
      throw new Error('Build changed while pinning the original.');
    writeJson(path.join(temp, 'manifest.json'), { ...manifest, lcpElement });
    try {
      fs.renameSync(temp, original);
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function checkParity(cdp, target, outDir, currentLcp) {
  const dir = path.join(target.dir, 'original');
  const manifest = readJson(path.join(dir, 'manifest.json'));
  if (!manifest)
    throw new Error('Run scan --pin on the original build before comparing rendered pages.');
  const anchorDist = path.join(dir, 'dist');
  if (hashDist(anchorDist) !== manifest.distHash)
    throw new Error('The saved original build has changed.');
  const pages = await runParity({
    cdp,
    anchorDist,
    candidateDist: target.dist,
    pages: manifest.pages.map((page) => page.path),
    masks: [],
    outDir,
    lcpByPage: { '/': compareLcp(manifest.lcpElement, currentLcp) },
  });
  return { passed: pages.length > 0 && pages.every((page) => page.state === 'clear'), pages };
}
