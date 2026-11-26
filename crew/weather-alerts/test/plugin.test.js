// Runs plugin.js against a fake `ferry` and a fixture weather.gov response.
// node --test crew/weather-alerts/test/plugin.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const code = readFileSync(new URL('../plugin.js', here), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('alerts.json', here), 'utf8'));
const NOW = Date.parse('2026-11-25T14:10:00-06:00');

function run({ settings = {}, now = NOW, store = {} } = {}) {
  const h = { sent: [], logs: [], requests: [], store, tick: null, response: { status: 200, text: JSON.stringify(fixture) } };
  const ferry = {
    settings: { location: '32.77671234,-96.797', ...settings },
    on: (ev, fn) => { if (ev === 'start') h.start = fn; },
    every: (_m, fn) => { h.tick = fn; },
    fetch: async (url, opts) => { h.requests.push({ url, opts }); return h.response; },
    send: async (m) => { h.sent.push(m); },
    log: (...v) => h.logs.push(v.join(' ')),
    storage: { get: (k) => structuredClone(h.store[k]), set: async (k, v) => { h.store[k] = structuredClone(v); } },
  };
  class FixedDate extends Date {
    constructor(...a) { super(...(a.length ? a : [h.now])); }
    static now() { return h.now; }
  }
  h.now = now;
  vm.runInNewContext(`(function (ferry) {\n${code}\n})`, { Date: FixedDate, JSON, Math, Number, String, Object, Array, Boolean, Error })(ferry);
  h.start();
  return h;
}

const withAlert = (id, change) => ({
  ...fixture,
  features: fixture.features.map((f) => (f.properties.id.endsWith(id) ? { ...f, properties: { ...f.properties, ...change } } : f)),
});

test('pushes new alerts at or above the chosen severity, once', async () => {
  const h = run();
  await h.tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, 'https://api.weather.gov/alerts/active?point=32.7767,-96.797');
  assert.match(h.requests[0].opts.headers['User-Agent'], /ferry-weather-alerts/);
  assert.equal(h.requests[0].opts.headers.Accept, 'application/geo+json');

  assert.deepEqual(h.sent.map((m) => m.title.split(' until ')[0]), ['Tornado Warning', 'Wind Advisory']);
  const [tornado, wind] = h.sent;
  assert.equal(tornado.channel, 'Dallas, TX +2');
  assert.equal(tornado.url, 'https://alerts.weather.gov');
  assert.match(tornado.body, /^Tornado Warning issued/);
  assert.match(tornado.body, /TAKE COVER NOW/, 'short instruction is included');
  assert.equal(wind.url, 'https://www.weather.gov/fwd');
  assert.doesNotMatch(wind.body, /high profile vehicles/, 'long instruction is left out');
  assert.match(wind.title, / until /, 'falls back to expires when ends is null');

  await h.tick();
  assert.equal(h.sent.length, 2, 'never re-pushes an unchanged alert');
});

test('pushes once more when an alert is updated', async () => {
  const h = run();
  await h.tick();
  h.response.text = JSON.stringify(withAlert('tornado.1', { sent: '2026-11-25T14:20:00-06:00', messageType: 'Update' }));
  await h.tick();
  assert.equal(h.sent.length, 3);
  assert.match(h.sent[2].title, /^Updated: Tornado Warning until /);
  await h.tick();
  assert.equal(h.sent.length, 3);

  // A replacement with a new id that references the pushed alert also counts as an update.
  const repl = structuredClone(fixture.features[1]);
  Object.assign(repl.properties, { id: 'urn:oid:wind.2', sent: '2026-11-25T14:30:00-06:00', references: [{ identifier: 'urn:oid:2.49.0.1.840.0.wind.1' }] });
  h.response.text = JSON.stringify({ features: [repl] });
  await h.tick();
  assert.match(h.sent[3].title, /^Updated: Wind Advisory/);
});

test('respects minSeverity and state codes', async () => {
  const h = run({ settings: { location: 'tx', minSeverity: 'minor' } });
  await h.tick();
  assert.equal(h.requests[0].url, 'https://api.weather.gov/alerts/active?area=TX');
  assert.equal(h.sent.length, 3, 'test messages are skipped');
});

test('forgets alerts after they end', async () => {
  const h = run({ store: { pushed: { old: { sent: 'x', ends: NOW - 1 }, live: { sent: 'y', ends: NOW + 60000 } } } });
  h.response.text = JSON.stringify({ features: [] });
  await h.tick();
  assert.deepEqual(Object.keys(h.store.pushed), ['live']);
});

test('bad location logs and never fetches', () => {
  for (const location of ['', 'Dallas', '95,10', 'ZZ']) {
    const h = run({ settings: { location } });
    assert.equal(h.tick, null);
    assert.match(h.logs[0], /isn't valid/);
  }
});

test('errors log and retry next interval', async () => {
  const h = run();
  h.response = { status: 503, text: JSON.stringify({ detail: 'Service down' }) };
  await h.tick();
  assert.match(h.logs.at(-1), /weather\.gov answered 503: Service down/);
  h.response = { status: 200, text: JSON.stringify(fixture) };
  await h.tick();
  assert.equal(h.sent.length, 2);
});
