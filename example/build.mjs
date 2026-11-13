import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { rspack } from '@rspack/core';
import { RspackPerfKitPlugin } from 'rspack-perf-kit';

const {
  values,
  positionals: [variant = 'eager', out = 'dist'],
} = parseArgs({
  allowPositionals: true,
  options: { 'no-report': { type: 'boolean' } },
});
if (!['eager', 'lazy'].includes(variant)) throw new Error('Expected eager or lazy.');
const context = path.dirname(fileURLToPath(import.meta.url));
const compiler = rspack({
  context,
  mode: 'production',
  entry: './src/' + variant + '.js',
  output: { path: path.resolve(context, out), filename: '[name].[contenthash:8].js', clean: true },
  devtool: 'source-map',
  plugins: [
    new rspack.HtmlRspackPlugin({ title: 'Rspack import experiment' }),
    ...(values['no-report'] ? [] : [new RspackPerfKitPlugin()]),
  ],
});

try {
  const stats = await new Promise((resolve, reject) =>
    compiler.run((err, stats) => (err ? reject(err) : resolve(stats))),
  );
  if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
} finally {
  await new Promise((resolve, reject) => compiler.close((err) => (err ? reject(err) : resolve())));
}
