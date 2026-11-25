// Tests for crew/page-watch: text normalising, diffing, and one full run against a fake ferry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../crew/page-watch/plugin.js', import.meta.url), 'utf8');

/** Loads plugin.js the way the host does (wrapped in a function), and hands back its helpers. */
function load(ferry = { on() {} }) {
  const names = 'parsePages pageTitle pageText maskVolatile hash fingerprint newLines normalisePhrase compare';
  const fn = vm.runInNewContext(`(function (ferry) {\n${code}\n;return { ${names.split(' ').join(', ')} };\n})`);
  return fn(ferry);
}
const P = load();
const HOUR = 3_600_000;

test('parsePages splits on spaces, commas and newlines, keeps only http(s), dedupes', () => {
  assert.deepEqual([...P.parsePages('https://a.com, http://b.com\nftp://c.com  https://a.com\n\nnope')], ['https://a.com', 'http://b.com']);
  assert.deepEqual([...P.parsePages(undefined)], []);
});

test('pageText drops scripts, styles, comments and tags, and keeps block lines', () => {
  const html = `<!doctype html><html><head><title>Shop &amp; Co</title><style>p{color:red}</style></head>
    <body><script>var x = "<p>not text</p>";</script><!-- hidden -->
    <div class="a" data-x="1 > 0"><h1>Blue   mug</h1><p>Price: &pound;12 &nbsp; <b>Sold</b>&#32;out</p></div>
    <noscript>Enable JS</noscript><ul><li>One</li><li>Two</li></ul></body></html>`;
  assert.equal(P.pageText(html), 'Blue mug\nPrice: &pound;12 Sold out\nOne\nTwo');
  assert.equal(P.pageTitle(html), 'Shop & Co');
});

test('maskVolatile ignores times, dates and "ago" tokens but not real words', () => {
  const a = P.maskVolatile('Updated 2026-11-25T10:42:00Z, 3 minutes ago, at 10:42 pm. In stock');
  const b = P.maskVolatile('Updated 2026-11-26T08:01:13Z, 1 hour ago, at 8:01 am. In stock');
  assert.equal(a, b);
  assert.equal(P.maskVolatile('Nov 25, 2026'), P.maskVolatile('Dec 1, 2027'));
  assert.notEqual(P.maskVolatile('In stock'), P.maskVolatile('Sold out'));
});

test('hash is short, stable and different for different text', () => {
  assert.equal(P.hash('abc'), P.hash('abc'));
  assert.notEqual(P.hash('abc'), P.hash('abd'));
  assert.ok(P.hash('x'.repeat(10000)).length <= 7);
});

test('newLines reports the first lines that are new, in page order', () => {
  const old = P.fingerprint('Header\nItem A\nFooter').lines;
  assert.deepEqual([...P.newLines(old, 'Header\nItem B\nItem A\nItem C\nFooter')], ['Item B', 'Item C']);
  assert.deepEqual([...P.newLines(old, 'Header\nFooter')], []);
});

test('compare: first look is a baseline, a timestamp-only change is quiet, a real change pushes once per interval', () => {
  const url = 'https://shop.example.com/mug';
  const page = (status, time) => `<title>Blue mug</title><p>Status: ${status}</p><p>Checked at ${time}</p>`;
  const first = P.compare(url, page('Sold out', '10:00'), undefined, '', 0, HOUR);
  assert.equal(first.push, null);
  assert.equal(first.baseline, true);

  const clock = P.compare(url, page('Sold out', '10:30'), first.state, '', HOUR, HOUR);
  assert.equal(clock.push, null);

  const changed = P.compare(url, page('In stock', '11:00'), clock.state, '', 2 * HOUR, HOUR);
  assert.deepEqual({ ...changed.push }, { title: 'Changed: Blue mug', body: 'Status: In stock', url, channel: 'shop.example.com' });

  const tooSoon = P.compare(url, page('Sold out', '11:05'), changed.state, '', 2 * HOUR + 60_000, HOUR);
  assert.equal(tooSoon.push, null);
  assert.equal(tooSoon.state, changed.state); // kept, so it pushes next time
});

test('compare with a phrase pushes only when the page newly contains it', () => {
  const url = 'https://tickets.example.org/show';
  const phrase = P.normalisePhrase('  Tickets   ON sale ');
  const base = P.compare(url, '<p>Coming soon</p>', undefined, phrase, 0, HOUR);
  const other = P.compare(url, '<p>Coming very soon</p>', base.state, phrase, HOUR, HOUR);
  assert.equal(other.push, null);
  const live = P.compare(url, '<h2>Tickets on sale now!</h2>', other.state, phrase, 2 * HOUR, HOUR);
  assert.equal(live.push.body, 'Tickets on sale now!');
  assert.equal(live.push.title, 'Changed: tickets.example.org');
  const still = P.compare(url, '<h2>Tickets on sale now! 5 left</h2>', live.state, phrase, 4 * HOUR, HOUR);
  assert.equal(still.push, null);
  // Changing the phrase starts over rather than pushing for a page that already had it.
  const newPhrase = P.compare(url, '<h2>Tickets on sale now!</h2>', base.state, 'on sale', 5 * HOUR, HOUR);
  assert.equal(newPhrase.push, null);
});

test('a full run: failures are logged and keep their baseline, changes are sent with a channel', async () => {
  const pages = {
    'https://a.example.com/': '<title>A</title><p>v1</p>',
    'https://b.example.com/': '<p>hello</p>',
  };
  let down = false;
  const store = {};
  const sent = [];
  const logs = [];
  let tick;
  const ferry = {
    settings: { pages: Object.keys(pages).join('\n'), minutes: 1 },
    on(ev, fn) { if (ev === 'start') this.start = fn; },
    every(min, fn) { assert.equal(min, 5); tick = fn; },
    async fetch(url) {
      if (down && url.includes('b.')) throw new Error('timed out');
      return { status: 200, headers: {}, text: pages[url] };
    },
    async send(p) { sent.push(p); },
    log: (...v) => logs.push(v.join(' ')),
    storage: { get: (k) => store[k], set: async (k, v) => { store[k] = structuredClone(v); }, delete: async (k) => { delete store[k]; } },
  };
  load(ferry);
  ferry.start();
  await tick();
  assert.equal(sent.length, 0);
  const bBaseline = store.pages['https://b.example.com/'];

  pages['https://a.example.com/'] = '<title>A</title><p>v2</p>';
  down = true;
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'a.example.com');
  assert.equal(sent[0].body, 'v2');
  assert.ok(logs.some((l) => l.includes('b.example.com') && l.includes('timed out')));
  assert.deepEqual(store.pages['https://b.example.com/'], bBaseline);

  down = false;
  await tick();
  assert.equal(sent.length, 1); // b came back unchanged: nothing to report
  assert.ok(JSON.stringify(store).length < 5000);
});
