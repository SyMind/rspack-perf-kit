# rspack-perf-kit

Find which modules a Rspack app loads eagerly, test a change to its import graph, and measure what users actually download and see. A separate build benchmark measures the project's build command.

**Design credit.** This project is based on [Rolldown's perf-kit](https://github.com/rolldown/rolldown/tree/main/packages/perf-kit). It directly uses `@rolldown/perf-kit@0.1.0` for Chromium measurements, source-map attribution, paint comparisons and visual parity. The compiler plugin, module graph, build runner and CLI are implemented here for Rspack. See the [upstream source at the package revision](https://github.com/rolldown/rolldown/tree/51419d388cedaa9c7836bd0b58e63b2db96fdc37/packages/perf-kit) and [NOTICE](./NOTICE).

## Try the example

Use Node.js 22.12 or later and a system Chrome or Chromium. Set `CHROME_PATH` to the executable if it is in a custom location. The example builds with Rspack 2.3.2.

```sh
git clone https://github.com/SyMind/rspack-perf-kit.git
cd rspack-perf-kit
npm ci
npm run demo:baseline
node bin/rspack-perf-kit.mjs why src/highlight.js --dist example/dist
node bin/rspack-perf-kit.mjs what-if src/highlight.js --dist example/dist
npm run demo:compare
```

The page displays a code example on the first button click. The first build imports the syntax highlighter at startup. The second loads it on click. Both builds use the same renderer and highlighter. The comparison prints FCP, LCP, initial asset size, modules entering or leaving the eager graph, and the rendered-page check. Run `npm run test:browser` to exercise the button in both versions and check the failure path with a visible regression.

## Use it in a Rspack project

Install from this repository in the app. Add the plugin to the production configuration used to build the static site. Enable external source maps to attribute first-paint coverage and sampled CPU to source modules.

```sh
npm install -D github:SyMind/rspack-perf-kit
```

```js
// rspack.config.mjs
import { RspackPerfKitPlugin } from 'rspack-perf-kit';

export default {
  mode: 'production',
  devtool: 'source-map',
  plugins: [new RspackPerfKitPlugin()],
};
```

For Rsbuild, append the same plugin to the Rspack configuration in `tools.rspack`. The plugin needs a build written to disk. Use a distinct output directory for each compiler.

```sh
npm run build
npx rspack-perf-kit scan --dist dist --coverage --profile --pin --label original
npx rspack-perf-kit graph --dist dist
npx rspack-perf-kit why src/chart.js --dist dist
npx rspack-perf-kit what-if src/chart.js --dist dist

# Change the import site, run the app's functional tests, and rebuild.
npm run build
npx rspack-perf-kit scan --dist dist --coverage --parity --label lazy-chart
npx rspack-perf-kit graph-diff --dist dist
```

Replace `src/chart.js` with a module from your graph. With a built site and a root `index.html`, `scan` also works without installing the plugin. The graph commands require its report. All commands support `--json` for automation and `--help` for usage.

## Read the results

| Command                       | Evidence                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph`                       | Entry files, total initial chunk asset bytes, and the largest statically reachable modules across all entries.                                                                                                              |
| `why MODULE`                  | A shortest static path to the module. If it is only reachable across an async boundary, the chain labels that edge. An ambiguous name lists matches.                                                                        |
| `what-if MODULE`              | Modules that would leave the eager graph if every static import into that module were deferred. Entry modules and dependencies still reachable from other importers remain eager.                                           |
| `graph-diff`                  | Eager modules added or removed since the pinned scan, and the change in emitted initial bytes. Pass `--against saved-graph.json` for a comparison without a browser.                                                        |
| `scan`                        | One warm-up followed by three timed root-page navigations by default. Reports median FCP/LCP, transfer size, individual samples, layout shift and deltas against the pinned build. Use `--runs` to change the sample count. |
| `scan --coverage --profile`   | Separate instrumented navigations collect code executed by the time FCP is observed and sampled startup CPU. Full reports include modules, skipped chunks and unattributed CPU.                                             |
| `scan --parity`               | Re-renders the original and current builds in Chromium, compares discovered HTML entry pages, and saves screenshots and differences.                                                                                        |
| `bench -- PROGRAM [ARGS ...]` | End-to-end wall time of a build command, including process startup and I/O. Reports each sample, the median and the change from the pinned command baseline.                                                                |

**Static estimates.** The plugin reads modules before scope hoisting, follows active Rspack dependency connections, and recognizes asynchronous dependency blocks. Module weights come from `module.size()`; tree shaking, minification, split chunks and compression affect delivered bytes. Initial asset bytes cover the union of files on initial chunks. Browser transfer counts encoded response bodies observed by settle, including the HTML.

**Browser conditions.** Each navigation uses a fresh tab with the HTTP cache disabled and service workers bypassed. The local server compresses text. The default throttle is 150 ms RTT, 1.6 Mbit/s download and 4× CPU slowdown. Compare builds on the same machine. A paint change must reach the greater of 30 ms and 2% of its baseline. A regression in either paint takes precedence. This threshold is a heuristic. Inspect the samples when results are close. Coverage uses generated UTF-16 offsets as a size approximation. The polling interval can include work just after FCP. Use `devtool: 'source-map'` with adjacent `.js.map` files for attribution.

**Correctness.** Both paints and page load must be observed in every measured run. Add repeatable `--feature NAME` options if the app sets `window.__ready[NAME] = true` when it is usable. A failed guard, a CLS increase over 0.02 against a comparable baseline, or a failed requested parity check returns exit code 1. A timing regression is reported in the JSON status. Runs below three are probes. `--pin` requires at least three samples and saves a new timing and graph baseline when the requested checks pass. The original used for visual parity stays fixed across later pins. Exercise interactions with the app's tests.

**Saved reports.** For `path/to/dist`, results live beside the output in `path/to/.rspack-perf-kit/targets/dist/`. The directory contains `graph.json`, the pinned `baseline.json`, a copy of the original build, and one directory per completed scan. The command prints its report path. A content hash prevents a graph from being used with a different build. The state directory ignores itself in Git.

## Benchmark a compiler change

From the application checkout, run the same command before and after changing the installed Rspack version or local binding. Leave the graph plugin out of both measured builds to exclude report creation. Configure the command's cache policy consistently. Warm-ups and samples each launch a new process and reuse whatever disk caches the command maintains.

```sh
npx rspack-perf-kit bench --runs 7 --warmup 1 --pin --label before -- npm run build
# Switch to the candidate Rspack build.
npx rspack-perf-kit bench --runs 7 --warmup 1 --label after -- npm run build
```

Arguments after `--` are passed directly to the program. For shell pipelines, put the command in a project script. Benchmark history lives in `.rspack-perf-kit/bench/` under the working directory and is keyed by the command and its arguments. Failed commands stop the run and preserve the previous baseline.

## Development

```sh
npm ci
npm test
npm run test:browser
```

The standard tests compile both example variants, check graph traversal and stale reports, and exercise the build benchmark CLI. The browser suite also checks source-map attribution, visual parity, on-demand chunk loading and failed-baseline protection.
