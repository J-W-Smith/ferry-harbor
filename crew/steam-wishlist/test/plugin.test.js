// Runs plugin.js against saved Steam responses. node --test crew/steam-wishlist/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const code = readFileSync(new URL('../plugin.js', here), 'utf8');
const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, here), 'utf8');

const EMPTY = JSON.stringify({ response: {} });

// routes: [regex, () => ({ status, text })]
function load(settings, routes, storage = {}) {
  const r = { sent: [], logs: [], fetched: [], storage, tick: null };
  const ferry = {
    settings,
    on(ev, fn) { if (ev === 'start') r.start = fn; },
    every(_minutes, fn) { r.tick = fn; },
    log: (...v) => r.logs.push(v.join(' ')),
    async send(p) { r.sent.push({ ...p }); },
    async fetch(url) {
      r.fetched.push(url);
      const hit = routes.find(([re]) => re.test(url));
      if (!hit) throw new Error(`unexpected fetch ${url}`);
      return hit[1](url);
    },
    storage: {
      get: (k) => structuredClone(r.storage[k]),
      async set(k, v) { r.storage[k] = structuredClone(v); },
      async delete(k) { delete r.storage[k]; },
    },
  };
  vm.runInNewContext(code, { ferry, setTimeout: (fn) => setTimeout(fn, 0), URL, JSON });
  r.start();
  return r;
}

const ok = (text) => () => ({ status: 200, text });
const steam = (items = fixture('items.json'), wishlist = fixture('wishlist.json')) => [
  [/IWishlistService\/GetWishlist/, ok(wishlist)],
  [/IStoreBrowseService\/GetItems/, ok(items)],
  [/steamcommunity\.com\/id\/someone\//, ok(fixture('profile.xml'))],
];

test('first run pushes sales at or above the threshold, deepest first', async () => {
  const r = load({ steamId: '76561198044300079', minDiscount: 20, country: 'gb' }, steam());
  await r.tick();
  assert.deepEqual(r.sent, [
    { title: 'Dragon Age: Origins - Ultimate Edition −80% · $5.99', url: 'https://store.steampowered.com/app/47810/', body: 'was $29.99', channel: 'Steam wishlist' },
    { title: 'Kenshi −60% · $11.99', url: 'https://store.steampowered.com/app/233860/', body: 'was $29.99', channel: 'Steam wishlist' },
  ]);
  assert.match(r.fetched[1], /country_code%22%3A%22GB/);
  assert.deepEqual(r.storage.pushed, { 47810: 80, 233860: 60 });
});

test('pushes once per sale, again only when it deepens, and again after the sale ends', async () => {
  const r = load({ steamId: 'https://steamcommunity.com/profiles/76561198044300079/' }, steam());
  await r.tick();
  r.sent.length = 0;

  await r.tick(); // same prices
  assert.deepEqual(r.sent, []);

  const deeper = fixture('items.json').replace('"discount_pct":60', '"discount_pct":75');
  const r2 = load({ steamId: '76561198044300079' }, steam(deeper), r.storage);
  await r2.tick();
  assert.deepEqual(r2.sent.map((s) => s.title), ['Kenshi −75% · $11.99']);

  const ended = fixture('items.json').replace(/"discount_pct":80/, '"discount_pct":0');
  const r3 = load({ steamId: '76561198044300079' }, steam(ended), r2.storage);
  await r3.tick();
  assert.equal(r3.storage.pushed[47810], undefined, 'ended sale is forgotten');
  const r4 = load({ steamId: '76561198044300079' }, steam(), r3.storage);
  await r4.tick();
  assert.deepEqual(r4.sent.map((s) => s.url), ['https://store.steampowered.com/app/47810/']);
});

test('first run caps at 10 pushes and remembers the rest', async () => {
  const many = { response: { store_items: Array.from({ length: 15 }, (_, i) => ({
    id: 1000 + i, appid: 1000 + i, name: `Game ${i}`,
    best_purchase_option: { discount_pct: 30 + i, formatted_final_price: '$1.00', formatted_original_price: '$2.00' },
  })) } };
  const wl = { response: { items: many.response.store_items.map((s) => ({ appid: s.appid })) } };
  const r = load({ steamId: '76561198044300079' }, steam(JSON.stringify(many), JSON.stringify(wl)));
  await r.tick();
  assert.equal(r.sent.length, 10);
  assert.equal(r.sent[0].title, 'Game 14 −44% · $1.00');
  assert.equal(Object.keys(r.storage.pushed).length, 15);
  assert.ok(r.logs.some((l) => l.includes('5 more remembered')), r.logs.join('\n'));
});

test('resolves a custom URL name once through the profile XML', async () => {
  const r = load({ steamId: 'https://steamcommunity.com/id/someone/' }, steam());
  await r.tick();
  assert.match(r.fetched[0], /steamcommunity\.com\/id\/someone\/\?xml=1/);
  assert.match(r.fetched[1], /steamid=76561198044300079/);
  assert.deepEqual(r.storage.resolved, { vanity: 'someone', id: '76561198044300079' });
  r.fetched.length = 0;
  await r.tick();
  assert.ok(!r.fetched.some((u) => u.includes('xml=1')));
});

test('private wishlist and bad ids give a clear log line and no pushes', async () => {
  const priv = load({ steamId: '76561197960287930' }, [
    [/GetWishlist/, ok(EMPTY)],
    [/profiles\/76561197960287930\/\?xml=1/, ok(fixture('profile-private.xml'))],
  ]);
  await priv.tick();
  assert.deepEqual(priv.sent, []);
  assert.ok(priv.logs.some((l) => l.includes('is friendsonly')), priv.logs.join('\n'));

  const missing = load({ steamId: 'nobody-here' }, [
    [/id\/nobody-here/, ok('<?xml version="1.0"?><response><error><![CDATA[The specified profile could not be found.]]></error></response>')],
  ]);
  await missing.tick();
  assert.ok(missing.logs.some((l) => l.includes('No Steam profile found')), missing.logs.join('\n'));

  const junk = load({ steamId: 'not a steam id!' }, []);
  await junk.tick();
  assert.ok(junk.logs.some((l) => l.includes("doesn't look like")), junk.logs.join('\n'));
});

test('a 429 stops the check without pushing', async () => {
  const r = load({ steamId: '76561198044300079' }, [
    [/GetWishlist/, ok(fixture('wishlist.json'))],
    [/GetItems/, () => ({ status: 429, text: '' })],
  ]);
  await r.tick();
  assert.deepEqual(r.sent, []);
  assert.ok(r.logs.some((l) => l.includes('429')));
  assert.equal(r.storage.owner, undefined, 'still a first run next time');
});
