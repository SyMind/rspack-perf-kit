#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bench } from '../lib/bench.mjs';
import { compareGraphs, explain, summarizeGraph, whatIf } from '../lib/graph.mjs';
import { scan } from '../lib/scan.mjs';
import { loadGraph, readJson, targetFor } from '../lib/state.mjs';

const help = `rspack-perf-kit

  scan [--dist dist] [--runs 3] [--pin] [--coverage] [--profile] [--parity]
       [--feature NAME ...] [--label LABEL]
       Measure a static Rspack app in Chromium. Pin the original before comparing.
  graph [--dist dist]
       List entry assets and the largest statically reachable modules.
  why MODULE [--dist dist]
       Explain the shortest import chain, preferring a fully static path.
  what-if MODULE [--dist dist]
       Estimate the module weight removed by deferring all static imports of MODULE.
  graph-diff [--dist dist] [--against graph.json]
       Compare eager modules and initial asset bytes to the pinned scan or a saved graph.
  bench [--runs 5] [--warmup 1] [--pin] [--label LABEL] -- PROGRAM [ARGS ...]
       Measure wall time of an actual build command in the current directory.

All commands accept --json. Output analysis accepts --app DIR to resolve --dist relative to an app.
Browser runs use CHROME_PATH or a system Chrome.
Design and browser instrumentation: https://github.com/rolldown/rolldown/tree/main/packages/perf-kit`;

const string = { type: 'string' };
const flag = { type: 'boolean' };
const targetOptions = {
  app: { type: 'string', default: '.' },
  dist: { type: 'string', default: 'dist' },
};
const sampling = { runs: string, label: string, pin: flag };
const optionsByCommand = new Map([
  ['graph', targetOptions],
  ['why', targetOptions],
  ['what-if', targetOptions],
  ['graph-diff', { ...targetOptions, against: string }],
  [
    'scan',
    {
      ...targetOptions,
      ...sampling,
      coverage: flag,
      profile: flag,
      parity: flag,
      feature: { type: 'string', multiple: true, default: [] },
    },
  ],
  ['bench', { ...sampling, warmup: string }],
]);

function count(value, min, name) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) {
    throw new Error('--' + name + ' must be an integer >= ' + min + '.');
  }
  return Number(value);
}

const kib = (bytes) => (bytes / 1024).toFixed(1) + ' KiB';
const ms = (value) => (value == null ? 'n/a' : value.toFixed(1) + ' ms');
function print(command, result) {
  switch (command) {
    case 'scan':
      console.log(
        'Paint comparison: ' + result.status + (result.pinned ? ' (baseline pinned)' : ''),
      );
      for (const name of ['fcp', 'lcp']) {
        const metric = 'runtime.' + name + '_ms';
        const delta = result.delta?.[metric]?.delta;
        console.log(
          name.toUpperCase() +
            ' ' +
            ms(result.metrics[metric]) +
            (delta == null ? '' : ' (delta ' + ms(delta) + ')'),
        );
      }
      console.log('Transferred by settle: ' + kib(result.metrics['runtime.transfer_bytes']));
      if (result.coverage) {
        console.log(
          'Coverage: ' +
            result.coverage.status +
            (result.coverage.reason ? ' (' + result.coverage.reason + ')' : ''),
        );
        for (const row of result.coverage.coldAtPaint ?? [])
          console.log('  ' + row.source + '  ' + kib(row.coldBytes) + ' cold at paint');
      }
      if (result.profile) {
        console.log('Sampled source CPU: ' + ms(result.profile.sourceMs));
        for (const row of result.profile.topSources)
          console.log('  ' + row.bucket + '  ' + ms(row.ms));
      }
      for (const page of result.parity?.pages ?? [])
        console.log('Parity ' + page.page + '  ' + page.state);
      break;
    case 'bench':
      console.log(
        'Build wall time (median): ' +
          ms(result.medianMs) +
          '  [' +
          result.samplesMs.map(ms).join(', ') +
          ']',
      );
      console.log(
        'Baseline: ' +
          result.comparison +
          (result.deltaMs == null ? '' : ', delta ' + ms(result.deltaMs)) +
          (result.pinned ? ' (pinned)' : ''),
      );
      break;
    case 'graph':
      for (const entry of result.entries) console.log(entry.name + ': ' + entry.files.join(', '));
      console.log(
        result.eagerModules +
          ' statically reachable modules, ' +
          kib(result.eagerModuleBytes) +
          ' module weight',
      );
      console.log('Initial emitted assets: ' + kib(result.initialAssetBytes));
      for (const row of result.largestEagerModules)
        console.log('  ' + kib(row.bytes) + '  ' + row.id);
      break;
    case 'why':
      if (!result.reachable) console.log('No entry path to ' + result.module);
      for (const row of result.chain) console.log((row.entry ?? row.via) + ' -> ' + row.id);
      break;
    case 'what-if':
      console.log(
        result.module +
          ': ' +
          result.removedModules +
          ' modules leave the eager graph (' +
          kib(result.removedModuleBytes) +
          ')',
      );
      for (const row of result.removed.slice(0, 10))
        console.log('  ' + kib(row.bytes) + '  ' + row.id);
      break;
    case 'graph-diff':
      console.log('Initial emitted asset delta: ' + kib(result.initialAssetBytesDelta));
      console.log('Eager module weight delta: ' + kib(result.eagerModuleBytesDelta));
      for (const key of ['entered', 'left']) {
        console.log(result[key].length + ' ' + key);
        for (const row of result[key].slice(0, 10))
          console.log('  ' + kib(row.bytes) + '  ' + row.id);
      }
  }
  if (result.report) console.log('Report: ' + result.report);
}

async function main([command, ...args]) {
  if (!command || ['help', '--help', '-h'].includes(command)) return console.log(help);
  const group = optionsByCommand.get(command);
  if (!group) throw new Error('Unknown command ' + command + '. Run rspack-perf-kit --help.');
  const separator = command === 'bench' ? args.indexOf('--') : -1;
  const { values, positionals } = parseArgs({
    args: separator < 0 ? args : args.slice(0, separator),
    allowPositionals: true,
    options: { ...group, json: flag, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) return console.log(help);
  const needsModule = ['what-if', 'why'].includes(command);
  if (positionals.length !== (needsModule ? 1 : 0)) throw new Error('See usage:\n' + help);
  let result;
  if (command === 'bench') {
    values.runs = count(values.runs ?? '5', 1, 'runs');
    values.warmup = count(values.warmup ?? '1', 0, 'warmup');
    result = await bench(separator < 0 ? [] : args.slice(separator + 1), values);
  } else {
    const target = targetFor(path.resolve(values.app, values.dist));
    if (command === 'scan') {
      values.runs = count(values.runs ?? '3', 1, 'runs');
      result = await scan(target, values);
      if (result.status === 'guard-failed') process.exitCode = 1;
    } else {
      const graph = loadGraph(target);
      if (command === 'graph') result = summarizeGraph(graph);
      if (command === 'why') result = explain(graph, positionals[0]);
      if (command === 'what-if') result = whatIf(graph, positionals[0]);
      if (command === 'graph-diff') {
        const before = values.against
          ? readJson(values.against)
          : readJson(path.join(target.dir, 'baseline.json'))?.graph;
        if (!before || before.schemaVersion !== 1 || !Array.isArray(before.modules)) {
          throw new Error(
            'Pin a scan with RspackPerfKitPlugin or pass --against <saved graph.json>.',
          );
        }
        result = compareGraphs(before, graph);
      }
    }
  }
  if (values.json) console.log(JSON.stringify(result));
  else print(command, result);
}

main(process.argv.slice(2)).catch((error) => {
  console.error('rspack-perf-kit: ' + error.message);
  process.exitCode = 1;
});
