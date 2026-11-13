import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashDist } from '@rolldown/perf-kit/lib/parity/anchor.mjs';

export { hashDist };

export function targetFor(dist) {
  const output = fs.realpathSync(dist);
  const root = path.join(path.dirname(output), '.rspack-perf-kit');
  if (root === output || output === path.dirname(output)) {
    throw new Error('Choose a dedicated build output directory.');
  }
  return { dist: output, root, dir: path.join(root, 'targets', path.basename(output)) };
}

export function ensureState(root) {
  fs.mkdirSync(root, { recursive: true });
  try {
    fs.writeFileSync(path.join(root, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value) + '\n');
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function loadGraph(target, digest = hashDist(target.dist)) {
  const graph = readJson(path.join(target.dir, 'graph.json'));
  if (!graph) throw new Error('Build with RspackPerfKitPlugin to collect the module graph.');
  if (graph.schemaVersion !== 1 || graph.distHash !== digest) {
    throw new Error('The graph does not match this build. Rebuild with RspackPerfKitPlugin.');
  }
  return graph;
}
