import path from 'node:path';
import { ensureState, hashDist, targetFor, writeJson } from './state.mjs';

const pluginName = 'RspackPerfKitPlugin';

// Keep type, loader, resource query and layer in the key. Workspace packages
// and hoisted dependencies can live above the compiler context.
function relativeIdentifier(identifier, context) {
  return identifier
    .split(/([!|])/)
    .map((part) => {
      if (!path.isAbsolute(part)) return part;
      const suffix = part.search(/[?#]/);
      const file = suffix < 0 ? part : part.slice(0, suffix);
      const relative = path.relative(context, file).replaceAll('\\', '/');
      const request =
        relative.startsWith('../') || path.isAbsolute(relative) ? relative : './' + relative;
      return request + (suffix < 0 ? '' : part.slice(suffix));
    })
    .join('');
}

function captureModules(compilation, modules, context) {
  const graph = compilation.moduleGraph;
  const records = [];
  const indices = new Map();
  for (const module of modules) {
    const identifier = module.identifier();
    indices.set(identifier, records.length);
    records.push({
      id: relativeIdentifier(identifier, context),
      bytes: module.size(),
      imports: [],
      asyncImports: [],
    });
  }

  // Async blocks carry the scheduling boundary, including nested context imports.
  // Eager import() has no such boundary. Avoid guessing from a dependency's name.
  function addDependencies(dependencies, indicesOut) {
    for (const dependency of dependencies) {
      const connection = graph.getConnection(dependency);
      if (!connection || connection.getActiveState(undefined) === false) continue;
      const destination = connection.module;
      const index = destination && indices.get(destination.identifier());
      if (index != null) indicesOut.add(index);
    }
  }
  for (const module of modules) {
    const record = records[indices.get(module.identifier())];
    const sync = new Set();
    const lazy = new Set();
    addDependencies(module.dependencies, sync);
    const blocks = [...module.blocks];
    while (blocks.length) {
      const block = blocks.pop();
      addDependencies(block.dependencies, lazy);
      for (const nested of block.blocks) blocks.push(nested);
    }
    record.imports = [...sync];
    record.asyncImports = [...lazy];
  }
  const entrypoints = [];
  for (const [name, entry] of compilation.entrypoints) {
    const entryModules = compilation.chunkGraph.getChunkEntryModulesIterable(
      entry.getEntrypointChunk(),
    );
    const roots = Array.from(entryModules, (module) => indices.get(module.identifier()));
    if (roots.some((index) => index === undefined))
      throw new Error('Missing entry module for ' + name);
    entrypoints.push({ name, roots });
  }
  return { modules: records, entrypoints };
}

export class RspackPerfKitPlugin {
  apply(compiler) {
    const captures = new WeakMap();
    compiler.hooks.thisCompilation.tap(pluginName, (compilation) => {
      // Capture individual modules after chunk formation, before scope hoisting.
      compilation.hooks.optimizeChunkModules.tap(
        { name: pluginName, stage: -10000 },
        (_chunks, modules) => {
          captures.set(
            compilation,
            captureModules(compilation, Array.from(modules), compiler.context),
          );
        },
      );
    });
    compiler.hooks.done.tap(pluginName, (stats) => {
      if (stats.hasErrors()) return;
      const compilation = stats.compilation;
      const graph = captures.get(compilation);
      if (!graph) throw new Error('Rspack did not expose the module graph.');
      const target = targetFor(compilation.getPath(compilation.outputOptions.path));
      const initialFiles = new Set();
      for (const chunk of compilation.chunks) {
        if (chunk.canBeInitial()) for (const file of chunk.files) initialFiles.add(file);
      }
      for (const entry of graph.entrypoints) {
        entry.files = compilation.entrypoints.get(entry.name).getFiles();
      }
      const assets = compilation.getAssets().map(({ name, source }) => ({
        name,
        bytes: source.size(),
        initial: initialFiles.has(name),
      }));
      ensureState(target.root);
      writeJson(path.join(target.dir, 'graph.json'), {
        schemaVersion: 1,
        distHash: hashDist(target.dist),
        rspackVersion: compiler.rspack.rspackVersion,
        ...graph,
        assets,
      });
    });
  }
}
