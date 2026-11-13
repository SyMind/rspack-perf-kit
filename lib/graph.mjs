function resolveIndex(graph, query) {
  if (!query) throw new Error('Supply a module identifier or unique substring.');
  const exact = graph.modules.findIndex((module) => module.id === query);
  if (exact !== -1) return exact;
  const hits = [];
  for (const [index, module] of graph.modules.entries()) {
    if (module.id.includes(query)) hits.push(index);
  }
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error('No module matches ' + query);
  const names = hits.slice(0, 10).map((index) => graph.modules[index].id);
  throw new Error('Ambiguous module ' + query + '. Matches include:\n' + names.join('\n'));
}

// Breadth-first traversal yields the shortest explanation and handles cycles.
// Blocking incoming edges keeps shared dependencies reachable via their other importers.
function walk(graph, { includeAsync = false, block, until } = {}) {
  const parents = new Map();
  const queue = [];
  for (const entry of graph.entrypoints) {
    for (const root of entry.roots) {
      if (parents.has(root)) continue;
      parents.set(root, { from: null, via: 'entry', entry: entry.name });
      queue.push(root);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i];
    if (from === until) break;
    const visit = (to, via) => {
      if (to === block || parents.has(to)) return;
      parents.set(to, { from, via });
      queue.push(to);
    };
    const module = graph.modules[from];
    for (const to of module.imports) visit(to, 'static');
    if (includeAsync) for (const to of module.asyncImports) visit(to, 'async');
  }
  return parents;
}

function moduleRows(graph, indices) {
  return Array.from(indices, (i) => ({
    id: graph.modules[i].id,
    bytes: graph.modules[i].bytes,
  })).sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
}

const total = (rows) => rows.reduce((sum, row) => sum + row.bytes, 0);

export function summarizeGraph(graph) {
  const rows = moduleRows(graph, walk(graph).keys());
  const initial = graph.assets.filter((asset) => asset.initial);
  return {
    rspackVersion: graph.rspackVersion,
    entries: graph.entrypoints.map((e) => ({ name: e.name, files: e.files })),
    totalModules: graph.modules.length,
    eagerModules: rows.length,
    eagerModuleBytes: total(rows),
    initialAssets: initial.length,
    initialAssetBytes: total(initial),
    largestEagerModules: rows.slice(0, 10),
  };
}

export function explain(graph, query) {
  let index = resolveIndex(graph, query);
  let parents = walk(graph, { until: index });
  if (!parents.has(index)) parents = walk(graph, { includeAsync: true, until: index });
  if (!parents.has(index)) return { module: graph.modules[index].id, reachable: false, chain: [] };
  const chain = [];
  while (index !== null) {
    const { from, via, entry } = parents.get(index);
    chain.push({ id: graph.modules[index].id, via, entry });
    index = from;
  }
  return { module: chain[0].id, reachable: true, chain: chain.reverse() };
}

export function whatIf(graph, query) {
  const index = resolveIndex(graph, query);
  const eager = walk(graph);
  const after = walk(graph, { block: index });
  const removed = moduleRows(
    graph,
    [...eager.keys()].filter((i) => !after.has(i)),
  );
  return {
    module: graph.modules[index].id,
    eager: eager.has(index),
    removedModules: removed.length,
    removedModuleBytes: total(removed),
    removed,
  };
}

export function compareGraphs(before, after) {
  const oldRows = moduleRows(before, walk(before).keys());
  const newRows = moduleRows(after, walk(after).keys());
  const oldIds = new Set(oldRows.map((row) => row.id));
  const newIds = new Set(newRows.map((row) => row.id));
  return {
    entered: newRows.filter((row) => !oldIds.has(row.id)),
    left: oldRows.filter((row) => !newIds.has(row.id)),
    eagerModuleBytesDelta: total(newRows) - total(oldRows),
    initialAssetBytesDelta:
      total(after.assets.filter((a) => a.initial)) - total(before.assets.filter((a) => a.initial)),
  };
}
