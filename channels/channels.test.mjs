// Run with: node --test channels/channels.test.mjs
// Add CHECK_FEEDS=1 to also fetch every feed and check it is a working RSS or Atom feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('./channels.json', import.meta.url), 'utf8'));
const rssCode = readFileSync(new URL('../crew/rss/plugin.js', import.meta.url), 'utf8');
const channels = data.categories.flatMap((c) => c.channels);
const httpUrl = (u) => typeof u === 'string' && /^https:\/\/[^\s,]+$/.test(u) && !!new URL(u).hostname;

function rss(settings) {
  const logs = [];
  const ferry = { settings, on: (e, fn) => e === 'start' && fn(), every() {}, storage: { get() {} }, log: (...v) => logs.push(v.join(' ')) };
  const ctx = vm.createContext({ ferry, URL });
  vm.runInContext(rssCode, ctx);
  return { ctx, logs };
}

test('channels.json matches the format', () => {
  assert.deepEqual(Object.keys(data).sort(), ['categories', 'version']);
  assert.equal(data.version, 1);
  assert.ok(Array.isArray(data.categories) && data.categories.length);
  const names = new Set();
  for (const cat of data.categories) {
    assert.deepEqual(Object.keys(cat).sort(), ['channels', 'name']);
    assert.ok(typeof cat.name === 'string' && cat.name.trim(), 'category name');
    assert.ok(!names.has(cat.name), `duplicate category ${cat.name}`);
    names.add(cat.name);
    assert.ok(Array.isArray(cat.channels) && cat.channels.length, `${cat.name} has channels`);
    for (const ch of cat.channels) {
      assert.deepEqual(Object.keys(ch).sort(), ['description', 'feed', 'id', 'name', 'site'], ch.id);
      assert.match(ch.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `id ${ch.id}`);
      assert.ok(ch.id.length <= 40, ch.id);
      assert.ok(typeof ch.name === 'string' && ch.name.trim() && ch.name.length <= 60, `${ch.id} name`);
      assert.ok(typeof ch.description === 'string' && ch.description.length <= 120 && /\.$/.test(ch.description), `${ch.id} description: one short sentence`);
      assert.ok(httpUrl(ch.feed), `${ch.id} feed must be a plain https URL without spaces or commas`);
      assert.ok(httpUrl(ch.site), `${ch.id} site`);
    }
  }
});

test('ids and feeds are unique', () => {
  const ids = channels.map((c) => c.id);
  const feeds = channels.map((c) => c.feed);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
  assert.equal(new Set(feeds).size, feeds.length, `duplicate feeds: ${feeds.filter((x, i) => feeds.indexOf(x) !== i)}`);
});

test('appending every feed to the rss feeds setting keeps each one separate', () => {
  let setting = 'https://example.com/a.xml, https://example.com/b.xml';
  for (const ch of channels) setting += '\n' + ch.feed;
  const { logs } = rss({ feeds: setting });
  assert.ok(logs.includes(`Following ${channels.length + 2} feed(s), checking every 30 min`), logs.join('\n'));
});

test('every feed answers with RSS or Atom (CHECK_FEEDS=1)', { skip: !process.env.CHECK_FEEDS }, async () => {
  const { ctx } = rss({ feeds: '' });
  const problems = [];
  await Promise.all(channels.map(async (ch) => {
    try {
      const r = await fetch(ch.feed, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (r.status !== 200) return problems.push(`${ch.id}: HTTP ${r.status}`);
      const text = await r.text();
      if (!ctx.looksLikeFeed(text)) return problems.push(`${ch.id}: not an RSS or Atom feed`);
      if (!ctx.parseFeed(text, ch.feed).items.length) problems.push(`${ch.id}: no posts`);
    } catch (e) { problems.push(`${ch.id}: ${e.message}`); }
  }));
  assert.deepEqual(problems, []);
});
