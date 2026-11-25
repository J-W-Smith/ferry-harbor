// Run with: node --test crew/rss/plugin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8');

/** Loads plugin.js with a fake ferry. Top-level functions become properties of the returned context. */
function load(settings, pages = {}) {
  const sent = [], logs = [], store = {};
  let tick;
  const ferry = {
    settings,
    on: (ev, fn) => { if (ev === 'start') queueMicrotask(fn); },
    every: (_m, fn) => { tick = fn; },
    send: async (p) => { sent.push(JSON.parse(JSON.stringify(p))); }, // the host gets a structured clone too
    fetch: async (url) => {
      const page = pages[url];
      if (page === undefined) return { status: 404, headers: {}, text: 'not found' };
      if (typeof page === 'object') return page;
      return { status: 200, headers: {}, text: page };
    },
    storage: { get: (k) => store[k], set: async (k, v) => { store[k] = structuredClone(v); }, delete: async (k) => { delete store[k]; } },
    log: (...v) => logs.push(v.join(' ')),
  };
  const ctx = vm.createContext({ ferry, URL });
  vm.runInContext(code, ctx);
  return { ctx, sent, logs, store, pages, run: async () => { await new Promise((r) => setTimeout(r, 0)); await tick(); } };
}

const RSS = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet href="style.xsl"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Tom &amp; Jerry&#8217;s Blog</title>
  <link>https://blog.example.com/</link>
  <atom:link href="https://blog.example.com/feed" rel="self" type="application/rss+xml" />
  <image><title>Logo</title><url>https://blog.example.com/logo.png</url></image>
  ${items}
</channel>
</rss>`;

const ITEM2 = `<item>
    <title><![CDATA[Second post: <b>bold</b> & more]]></title>
    <link>https://blog.example.com/2?a=1&amp;b=2</link>
    <guid isPermaLink="false">post-2</guid>
    <pubDate>Tue, 24 Nov 2026 10:00:00 GMT</pubDate>
    <description>&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;</description>
  </item>`;
const ITEM1 = `<item>
    <title>First post</title>
    <link>https://blog.example.com/1</link>
    <pubDate>Mon, 23 Nov 2026 10:00:00 GMT</pubDate>
    <content:encoded><![CDATA[<p>Some <em>long</em> text</p>]]></content:encoded>
  </item>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">Atom &lt;i&gt;Feed&lt;/i&gt;</title>
  <link href="https://atom.example.org/" />
  <id>urn:uuid:feed</id>
  <entry>
    <title>Entry one</title>
    <link rel="replies" href="https://atom.example.org/1#comments"/>
    <link rel="alternate" type="text/html" href="/posts/1"/>
    <id>tag:atom.example.org,2026:1</id>
    <updated>2026-11-20T12:00:00Z</updated>
    <published>2026-11-19T12:00:00Z</published>
    <summary type="html">A &lt;a href="x"&gt;link&lt;/a&gt; inside</summary>
  </entry>
</feed>`;

test('parses RSS 2.0: channel title, CDATA, entities, links, guid, dates, short summary', () => {
  const { ctx } = load({ feeds: '' });
  assert.ok(ctx.looksLikeFeed(RSS(ITEM2 + ITEM1)));
  const f = ctx.parseFeed(RSS(ITEM2 + ITEM1), 'https://blog.example.com/feed');
  assert.equal(f.title, 'Tom & Jerry’s Blog');
  assert.equal(f.items.length, 2);
  const [a, b] = f.items;
  assert.equal(a.title, 'Second post: bold & more');
  assert.equal(a.link, 'https://blog.example.com/2?a=1&b=2');
  assert.equal(a.id, 'post-2');
  assert.equal(a.date, Date.parse('2026-11-24T10:00:00Z'));
  assert.equal(a.summary, 'Hello & welcome');
  assert.equal(b.id, 'https://blog.example.com/1', 'no guid: the link is the id');
  assert.equal(b.summary, 'Some long text');
});

test('parses Atom: html title, alternate link resolved against the feed, published date', () => {
  const { ctx } = load({ feeds: '' });
  assert.ok(ctx.looksLikeFeed(ATOM));
  const f = ctx.parseFeed(ATOM, 'https://atom.example.org/feed.xml');
  assert.equal(f.title, 'Atom Feed');
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0].link, 'https://atom.example.org/posts/1');
  assert.equal(f.items[0].id, 'tag:atom.example.org,2026:1');
  assert.equal(f.items[0].date, Date.parse('2026-11-19T12:00:00Z'));
  assert.equal(f.items[0].summary, 'A link inside');
});

test('long summaries are cut at a word', () => {
  const { ctx } = load({ feeds: '' });
  const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
  const f = ctx.parseFeed(RSS(`<item><title>x</title><guid>g</guid><description>${long}</description></item>`), 'https://x.example/');
  assert.ok(f.items[0].summary.length <= 200);
  assert.ok(f.items[0].summary.endsWith('…'));
  assert.ok(/word\d+…$/.test(f.items[0].summary));
});

test('finds the feed in an HTML page', () => {
  const { ctx } = load({ feeds: '' });
  const html = `<html><head>
    <!-- <link rel="alternate" type="application/rss+xml" href="/old.xml"> -->
    <link rel="stylesheet" href="/a.css">
    <link type='application/rss+xml' rel='alternate' title='Comments' href='/comments/feed'>
    <LINK REL="alternate" TYPE="application/atom+xml" HREF="/feed.atom?x=1&amp;y=2" />
  </head><body><feed>not a feed</feed></body></html>`;
  assert.ok(!ctx.looksLikeFeed(html));
  assert.equal(ctx.discoverFeed(html, 'https://site.example/blog/'), 'https://site.example/feed.atom?x=1&y=2');
  assert.equal(ctx.discoverFeed('<html><head></head></html>', 'https://site.example/'), null);
});

test('first run sends nothing, later runs push only new posts with a channel, failing feeds do not stop others', async () => {
  const p = load({ feeds: 'https://site.example/, https://down.example/rss\nhttps://blog.example.com/feed', minutes: 1 }, {
    'https://site.example/': '<html><head><link rel="alternate" type="application/atom+xml" href="/atom"></head></html>',
    'https://site.example/atom': ATOM,
    'https://blog.example.com/feed': RSS(ITEM1),
  });
  await p.run();
  assert.equal(p.sent.length, 0, 'no flood on first sight');
  assert.equal(p.store.feeds['https://site.example/'].feed, 'https://site.example/atom', 'resolved feed remembered');
  assert.ok(p.logs.some((l) => l.includes('https://down.example/rss: skipped, answered HTTP 404')), p.logs.join('\n'));

  p.pages['https://blog.example.com/feed'] = RSS(ITEM2 + ITEM1);
  delete p.pages['https://site.example/']; // the remembered feed is used, the site page is not fetched again
  await p.run();
  assert.deepEqual(p.sent, [{
    title: 'Second post: bold & more', url: 'https://blog.example.com/2?a=1&b=2', body: 'Hello & welcome', channel: 'Tom & Jerry’s Blog',
  }]);
  await p.run();
  assert.equal(p.sent.length, 1, 'nothing new, nothing sent');
});

test('caps pushes per run and carries the rest over, oldest first', async () => {
  const items = (n) => Array.from({ length: n }, (_, i) => `<item><title>Post ${n - i}</title><link>https://b.example/${n - i}</link><pubDate>${new Date(Date.UTC(2026, 0, n - i)).toUTCString()}</pubDate></item>`).join('');
  const p = load({ feeds: 'https://b.example/feed' }, { 'https://b.example/feed': RSS(items(1)) });
  await p.run();
  p.pages['https://b.example/feed'] = RSS(items(16));
  await p.run();
  assert.equal(p.sent.length, 10);
  assert.equal(p.sent[0].title, 'Post 2');
  assert.equal(p.store.queue.length, 5);
  await p.run();
  assert.equal(p.sent.length, 15);
  assert.equal(p.sent[14].title, 'Post 16');
  assert.ok(p.store.feeds['https://b.example/feed'].seen.length <= 500);
  assert.ok(JSON.stringify(p.store).length < 20_000);
});
