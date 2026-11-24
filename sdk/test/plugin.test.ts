// Synced from the Ferry app repo by tools/sync-harbor.ts. Do not edit here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  manifestProblems, bundleProblems, verifyBundle, indexProblems, hostAllowed, sha256Hex, compareVersions,
  lockdown, workerSource, PluginHost, LIMITS, type PluginManifest, type IndexEntry, type Sandbox, type HostCaps,
} from '../index.ts';

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  api: 1, id: 'demo', name: 'Demo', version: '1.0.0', description: 'A demo', author: 'Someone',
  permissions: ['send', 'receive', 'net:api.example.com'], ...over,
});

test('manifest checks', () => {
  assert.deepEqual(manifestProblems(manifest()), []);
  assert.ok(manifestProblems(manifest({ id: 'Bad ID' })).length);
  assert.ok(manifestProblems(manifest({ permissions: ['shell'] })).some((p) => p.includes('unknown permission')));
  assert.ok(manifestProblems(manifest({ permissions: ['net:localhost'] })).length, 'bare hostnames are refused');
  assert.ok(manifestProblems(manifest({ settings: [{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'text' }] })).some((p) => p.includes('duplicate')));
  assert.ok(bundleProblems({ manifest: manifest(), code: '' }).includes('code is missing'));
});

test('host permissions', () => {
  const p = ['net:api.example.com', 'net:*.feeds.org'];
  assert.ok(hostAllowed(p, 'https://api.example.com/x'));
  assert.ok(!hostAllowed(p, 'https://evil.com/?api.example.com'));
  assert.ok(!hostAllowed(p, 'https://api.example.com.evil.com/'));
  assert.ok(hostAllowed(p, 'https://a.feeds.org/rss'));
  assert.ok(!hostAllowed(p, 'https://feeds.org/rss'), 'wildcard is subdomains only');
  assert.ok(!hostAllowed(p, 'https://xfeeds.org/rss'));
  assert.ok(!hostAllowed(p, 'ftp://api.example.com/'));
  assert.ok(!hostAllowed(p, 'https://user:pw@api.example.com/'));
  assert.ok(hostAllowed(['net:*'], 'https://anything.example/'));
  assert.ok(!hostAllowed(['net:*'], 'file:///C:/secret'));
  assert.deepEqual(manifestProblems(manifest({ permissions: ['net:*'] })), []);
});

test('bundle must match the registry entry', () => {
  const text = JSON.stringify({ manifest: manifest(), code: 'ferry.log(1)' });
  const entry: IndexEntry = { ...manifest(), bundle: 'demo-1.0.0.json', sha256: sha256Hex(text) };
  assert.equal(verifyBundle(text, entry).manifest.id, 'demo');
  assert.throws(() => verifyBundle(text + ' ', entry), /hash/);
  const wider = JSON.stringify({ manifest: manifest({ permissions: ['send', 'receive', 'net:api.example.com', 'notify'] }), code: 'x' });
  assert.throws(() => verifyBundle(wider, { ...entry, sha256: sha256Hex(wider) }), /permissions/);
  assert.deepEqual(indexProblems({ v: 1, plugins: [entry] }), []);
  assert.ok(indexProblems({ v: 1, plugins: [entry, entry] }).some((p) => p.includes('duplicate')));
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
});

test('lockdown removes network globals, including ones on prototypes', () => {
  const proto = { fetch() {}, WebSocket: class {}, setTimeout };
  const scope = Object.create(proto);
  scope.XMLHttpRequest = class {};
  lockdown(scope);
  assert.equal(scope.fetch, undefined);
  assert.equal(scope.WebSocket, undefined);
  assert.equal(scope.XMLHttpRequest, undefined);
  assert.equal(scope.setTimeout, setTimeout);
});

/** Runs a plugin's real worker source in a vm context, wired to a PluginHost. */
function run(code: string, m: PluginManifest, caps: Partial<HostCaps> = {}) {
  const logs: string[] = [];
  const sent: unknown[] = [];
  const saved: unknown[] = [];
  const listeners: Array<(e: { data: unknown }) => void> = [];
  let host: PluginHost;
  const toHost: Array<(m: any) => void> = [];
  const ctx = vm.createContext({
    setTimeout, setInterval, clearInterval, JSON, Promise,
    fetch: () => { throw new Error('real fetch reached'); },
    postMessage: (msg: unknown) => queueMicrotask(() => toHost.forEach((f) => f(structuredClone(msg)))),
    addEventListener: (type: string, fn: (e: { data: unknown }) => void) => { if (type === 'message') listeners.push(fn); },
  });
  ctx.self = ctx;
  const sandbox: Sandbox = {
    post: (msg) => queueMicrotask(() => listeners.forEach((f) => f({ data: structuredClone(msg) }))),
    onMessage: (fn) => toHost.push(fn),
    terminate: () => {},
  };
  host = new PluginHost(m, sandbox, {
    send: async (p) => { sent.push(p); },
    notify: async () => {},
    fetch: async (url) => ({ status: 200, headers: {}, text: `got ${url}` }),
    saveStorage: (d) => saved.push(d),
    log: (_l, t) => logs.push(t),
    ...caps,
  });
  vm.runInContext(workerSource({ manifest: m, code }, { settings: { greeting: 'hi' }, storage: { n: 1 } }), ctx);
  return { host, logs, sent, saved, ctx };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test('plugin can send, fetch allowed hosts, store data and receive pushes', async () => {
  const r = run(`
    ferry.on('start', async () => {
      ferry.log('settings', ferry.settings.greeting, typeof fetch);
      const res = await ferry.fetch('https://api.example.com/status');
      await ferry.send({ title: 'Status', body: res.text });
      await ferry.storage.set('n', ferry.storage.get('n') + 1);
      ferry.log('n is', ferry.storage.get('n'));
      try { await ferry.fetch('https://other.com/'); } catch (e) { ferry.log('blocked:', e.message); }
    });
    ferry.on('push', (p) => ferry.log('got push', p.title));
  `, manifest());
  await tick();
  assert.deepEqual(r.sent, [{ kind: 'note', title: 'Status', body: 'got https://api.example.com/status' }]);
  assert.deepEqual(r.saved, [{ n: 2 }]);
  assert.ok(r.logs.includes('settings hi undefined'), r.logs.join('\n'));
  assert.ok(r.logs.includes('n is 2'));
  assert.ok(r.logs.some((l) => l.startsWith('blocked:') && l.includes('other.com')));
  r.host.deliver({ kind: 'note', title: 'Hello', body: 'x', from: 'Phone' });
  await tick();
  assert.ok(r.logs.includes('got push Hello'));
});

test('missing permissions and limits are enforced by the host', async () => {
  const r = run(`
    ferry.on('start', async () => {
      try { await ferry.send({ body: 'x' }); } catch (e) { ferry.log(e.message); }
      try { await ferry.notify('x'); } catch (e) { ferry.log(e.message); }
      ferry.on('push', () => ferry.log('should not see this'));
    });
  `, manifest({ permissions: [] }));
  await tick();
  assert.ok(r.logs.some((l) => l.includes('"send" permission')));
  assert.ok(r.logs.some((l) => l.includes('"notify" permission')));
  r.host.deliver({ kind: 'note', body: 'x', from: 'Phone' });
  await tick();
  assert.ok(!r.logs.includes('should not see this'));
  assert.equal(r.sent.length, 0);

  const s = run(`ferry.on('start', async () => {
    let ok = 0; for (let i = 0; i < ${LIMITS.sendsPerHour + 5}; i++) { try { await ferry.send({ body: 'n' + i }); ok++; } catch {} }
    ferry.log('sent', ok);
  });`, manifest());
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(s.logs.includes(`sent ${LIMITS.sendsPerHour}`), s.logs.join('\n'));
});

test('plugin errors are reported, not thrown into the host', async () => {
  const r = run(`ferry.on('start', () => { throw new Error('boom'); });`, manifest());
  await tick();
  assert.ok(r.logs.some((l) => l.includes('boom')));
});
