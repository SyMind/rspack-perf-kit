import assert from 'node:assert/strict';
import test from 'node:test';
import { compareGraphs, explain, summarizeGraph, whatIf } from '../lib/graph.mjs';

const graph = {
  entrypoints: [
    { name: 'a', roots: [0], files: ['entry.js'] },
    { name: 'b', roots: [1], files: [] },
  ],
  modules: [
    { id: 'entry-a', imports: [2], asyncImports: [4], bytes: 1 },
    { id: 'entry-b', imports: [3], asyncImports: [], bytes: 2 },
    { id: 'feature', imports: [3, 5], asyncImports: [], bytes: 3 },
    { id: 'shared', imports: [], asyncImports: [], bytes: 4 },
    { id: 'async-feature', imports: [], asyncImports: [], bytes: 5 },
    { id: 'cycle', imports: [2], asyncImports: [], bytes: 6 },
  ],
  assets: [{ name: 'entry.js', bytes: 10, initial: true }],
};

test('cut preserves other entries, shared dependencies and entry roots', () => {
  const cut = whatIf(graph, 'feature');
  assert.equal(cut.removedModuleBytes, 9);
  assert.deepEqual(
    cut.removed.map((row) => row.id),
    ['cycle', 'feature'],
  );
  assert.equal(whatIf(graph, 'entry-a').removedModules, 0);
  assert.equal(whatIf(graph, 'async-feature').removedModules, 0);
});
test('explains async boundaries and rejects ambiguous names', () => {
  assert.deepEqual(
    explain(graph, 'async-feature').chain.map((row) => row.via),
    ['entry', 'async'],
  );
  assert.throws(() => explain(graph, 'entry-'), /Ambiguous/);
  assert.throws(() => explain(graph, 'missing'), /No module/);
});
test('compares eager sets by identifier across builds', () => {
  const after = structuredClone(graph);
  after.modules[0].imports = [];
  after.modules[0].asyncImports.push(2);
  assert.equal(summarizeGraph(graph).initialAssetBytes, 10);
  assert.equal(compareGraphs(graph, after).eagerModuleBytesDelta, -9);
});
