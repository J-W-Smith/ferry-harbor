// Synced from the Ferry app repo by tools/sync-harbor.ts. Do not edit here.
// Tools for Ferry plugin authors and registry reviewers.
//
//   node sdk/ferry-plugin.ts validate <folder>          check a plugin
//   node sdk/ferry-plugin.ts dev <folder> [--port N]    serve it for Ferry desktop's "Developers" install
//   node sdk/ferry-plugin.ts index [crew] [out]         build the Harbor registry (default: crew dist)
//
// A plugin (crew member) folder holds ferry-plugin.json and plugin.js. See the ferry-harbor README.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import vm from 'node:vm';
import { bundleProblems, sha256Hex, type PluginBundle, type IndexEntry, type RegistryIndex } from './index.ts';

function readBundle(dir: string): { bundle: PluginBundle; problems: string[] } {
  const mf = join(dir, 'ferry-plugin.json');
  const code = join(dir, 'plugin.js');
  const problems: string[] = [];
  let manifest: any = null;
  if (!existsSync(mf)) problems.push('ferry-plugin.json is missing');
  else try { manifest = JSON.parse(readFileSync(mf, 'utf8')); } catch (e) { problems.push(`ferry-plugin.json: ${(e as Error).message}`); }
  if (!existsSync(code)) problems.push('plugin.js is missing');
  const bundle = { manifest, code: existsSync(code) ? readFileSync(code, 'utf8') : '' } as PluginBundle;
  if (manifest) problems.push(...bundleProblems(bundle));
  if (bundle.code) {
    try { new vm.Script(`(function (ferry) {\n${bundle.code}\n})`, { filename: 'plugin.js' }); } catch (e) { problems.push(`plugin.js does not parse: ${(e as Error).message}`); }
  }
  const folder = resolve(dir).split(/[\\/]/).pop();
  if (manifest?.id && folder !== manifest.id) problems.push(`folder name should match the id (${manifest.id})`);
  return { bundle, problems };
}

function validate(dir: string) {
  const { bundle, problems } = readBundle(dir);
  if (problems.length) { console.error(`✗ ${dir}\n${problems.map((p) => `  - ${p}`).join('\n')}`); return false; }
  console.log(`✓ ${bundle.manifest.id} ${bundle.manifest.version} (${bundle.manifest.permissions.join(', ') || 'no permissions'})`);
  return true;
}

function dev(dir: string, port: number) {
  createServer((req, res) => {
    if (req.url !== '/bundle.json') { res.writeHead(404).end(); return; }
    const { bundle, problems } = readBundle(dir);
    if (problems.length) { res.writeHead(422, { 'content-type': 'text/plain' }).end(problems.join('\n')); console.error(problems.join('\n')); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(bundle));
    console.log(`served ${bundle.manifest.id} ${bundle.manifest.version}`);
  }).listen(port, '127.0.0.1', () => {
    console.log(`In Ferry desktop: Crew → Developers → paste  http://localhost:${port}/bundle.json`);
    console.log('After editing, press "Reload code" on the plugin\'s page. Ctrl+C to stop.');
  });
}

/** Builds <out>/index.json and one bundle file per plugin; hashes are over the exact bundle bytes. */
function buildIndex(pluginsDir: string, out: string) {
  const dirs = readdirSync(pluginsDir).filter((d) => d !== 'dist' && statSync(join(pluginsDir, d)).isDirectory()).sort();
  let ok = true;
  const entries: IndexEntry[] = [];
  const texts = new Map<string, string>();
  for (const d of dirs) {
    const { bundle, problems } = readBundle(join(pluginsDir, d));
    if (problems.length) { ok = validate(join(pluginsDir, d)) && ok; continue; }
    const m = bundle.manifest;
    const file = `${m.id}-${m.version}.json`;
    const text = JSON.stringify(bundle);
    entries.push({
      id: m.id, name: m.name, version: m.version, description: m.description, author: m.author,
      ...(m.homepage ? { homepage: m.homepage } : {}), permissions: m.permissions, bundle: file, sha256: sha256Hex(text),
    });
    texts.set(file, text);
  }
  if (!ok) { console.error('Fix the problems above; the index was not written.'); process.exit(1); }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const e of entries) writeFileSync(join(out, e.bundle), texts.get(e.bundle)!);
  const index: RegistryIndex = { v: 1, plugins: entries };
  writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`Wrote ${entries.length} plugin(s) to ${out}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };
if (cmd === 'validate' && rest[0]) process.exit(validate(rest[0]) ? 0 : 1);
else if (cmd === 'dev' && rest.length) { const port = Number(flag('--port') ?? 8790); dev(rest[0]!, port); }
else if (cmd === 'index') buildIndex(rest[0] ?? 'crew', rest[1] ?? 'dist');
else {
  console.log('Usage:\n  node sdk/ferry-plugin.ts validate <folder>\n  node sdk/ferry-plugin.ts dev <folder> [--port 8790]\n  node sdk/ferry-plugin.ts index [crew] [out]');
  process.exit(cmd ? 1 : 0);
}
