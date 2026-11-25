// Follows RSS 2.0, RSS 1.0 and Atom feeds and pushes each new post as a link.
// A plain site address works too: the feed is found from the page's <link rel="alternate"> tag.
// The sandbox has no DOM or XML parser, so feeds are read with small, careful regular expressions.

const MAX_PER_RUN = 10;        // pushes in one run
const MAX_PER_HOUR = 25;       // stays under Ferry's 30 pushes an hour
const MAX_FETCHES_PER_RUN = 25; // stays under Ferry's 30 requests a minute
const MAX_QUEUE = 100;         // posts waiting for a later run
const KEEP_SEEN = 200;         // remembered posts per feed (more if the feed itself is longer)
const MAX_SEEN = 500;
const BODY_CHARS = 200;

const inputs = [...new Set(String(ferry.settings.feeds || '').split(/[\s,]+/).filter((u) => /^https?:\/\/\S+$/i.test(u)))];
const minutes = Math.max(10, Number(ferry.settings.minutes) || 30);

// ---------- text helpers ----------

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', deg: '°', euro: '€', pound: '£', times: '×', eacute: 'é', egrave: 'è',
  aacute: 'á', agrave: 'à', ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return NAMED[name] ?? NAMED[name.toLowerCase()] ?? whole;
  });
}

/** The text of an XML element's content: CDATA kept as is, everything else entity-decoded. */
function xmlText(raw) {
  let out = '';
  let last = 0;
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  for (let m; (m = cdata.exec(raw));) {
    out += decodeEntities(raw.slice(last, m.index)) + m[1];
    last = cdata.lastIndex;
  }
  return out + decodeEntities(raw.slice(last));
}

/** Turns an HTML fragment into one short line of plain text. */
function stripHtml(html) {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function shorten(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '') + '…';
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every <name ...>...</name> (or <name .../>) in xml, as { attrs, inner }. Matches the exact tag name only. */
function elements(xml, name) {
  const n = escapeRe(name);
  const re = new RegExp(`<${n}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${n}\\s*>)`, 'gi');
  const found = [];
  for (let m; (m = re.exec(xml));) found.push({ attrs: parseAttrs(m[1] || ''), inner: m[2] || '' });
  return found;
}

function first(xml, ...names) {
  for (const name of names) {
    const el = elements(xml, name)[0];
    if (el && (el.inner.trim() || Object.keys(el.attrs).length)) return el;
  }
  return null;
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (let m; (m = re.exec(s));) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

function absolute(href, base) {
  try { return new URL(href, base).href; } catch { return href; }
}

/** Short, stable id for the seen-set, so storage stays small (FNV-1a, 32 bit, plus the length). */
function hashId(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

// ---------- feed parsing ----------

/** True if the document's root element is an RSS, RDF or Atom feed. */
function looksLikeFeed(text) {
  const head = text.replace(/^﻿/, '').slice(0, 4000);
  return /^\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<(?:rss|feed|rdf:RDF)[\s>]/i.test(head);
}

/** Parses RSS 2.0, RSS 1.0 (RDF) or Atom. Returns { title, items: [{ id, title, link, date, summary }] }, newest first as the feed lists them. */
function parseFeed(xml, feedUrl) {
  const atom = /^\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*<feed[\s>]/i.test(xml.replace(/^﻿/, ''));
  const itemTag = atom ? 'entry' : 'item';
  const firstItem = xml.search(new RegExp(`<${itemTag}[\\s>]`, 'i'));
  const head = firstItem === -1 ? xml : xml.slice(0, firstItem);
  const titleEl = first(head, 'title');
  const title = titleEl ? stripHtml(xmlText(titleEl.inner)) : '';

  const items = elements(xml, itemTag).map(({ attrs, inner }) => {
    const t = first(inner, 'title');
    const itemTitle = t ? stripHtml(xmlText(t.inner)) : '';
    let link = '';
    if (atom) {
      const links = elements(inner, 'link').filter((l) => l.attrs.href);
      const alt = links.find((l) => !l.attrs.rel || l.attrs.rel === 'alternate') || links[0];
      link = alt ? alt.attrs.href : '';
    } else {
      const l = first(inner, 'link');
      link = l ? xmlText(l.inner).trim() : '';
      const guid = first(inner, 'guid');
      if (!link && guid && guid.attrs.ispermalink !== 'false') link = xmlText(guid.inner).trim();
      if (!link && attrs['rdf:about']) link = attrs['rdf:about'];
    }
    if (link) link = absolute(link, feedUrl);
    const idEl = first(inner, atom ? 'id' : 'guid');
    const id = (idEl && xmlText(idEl.inner).trim()) || link || itemTitle;
    const dateEl = first(inner, 'published', 'updated', 'pubDate', 'dc:date', 'issued', 'modified');
    const date = dateEl ? Date.parse(xmlText(dateEl.inner).trim()) || 0 : 0;
    const sumEl = first(inner, 'summary', 'description', 'content', 'content:encoded');
    const summary = sumEl ? shorten(stripHtml(xmlText(sumEl.inner)), BODY_CHARS) : '';
    return { id, title: itemTitle, link, date, summary };
  }).filter((it) => it.id);
  return { title, items };
}

/** Finds the feed address in an HTML page's <link rel="alternate" type="application/rss+xml|atom+xml">. */
function discoverFeed(html, pageUrl) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const candidates = [];
  for (const m of clean.matchAll(/<link\b([^>]*)>/gi)) {
    const a = parseAttrs(m[1]);
    const rel = (a.rel || '').toLowerCase().split(/\s+/);
    const type = (a.type || '').toLowerCase().trim();
    if (!a.href || !rel.includes('alternate')) continue;
    if (type === 'application/rss+xml' || type === 'application/atom+xml') candidates.push(absolute(a.href, pageUrl));
  }
  // Skip comment feeds when there is a main one.
  return candidates.find((u) => !/comments?/i.test(u)) || candidates[0] || null;
}

// ---------- running ----------

let fetchesLeft = 0;

/** Fetches a URL, following up to 3 redirects ourselves (Ferry checks every hop against the permissions). */
async function get(url) {
  for (let hop = 0; hop < 4; hop++) {
    if (fetchesLeft-- <= 0) throw new Error('out of requests for this run');
    const r = await ferry.fetch(url, { method: 'GET', headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5' } });
    const location = r.headers && (r.headers.location || r.headers.Location);
    if (r.status >= 300 && r.status < 400 && location) { url = absolute(location, url); continue; }
    if (r.status !== 200) throw new Error(`answered HTTP ${r.status}`);
    return { url, text: r.text };
  }
  throw new Error('too many redirects');
}

/** Fetches one followed address and returns its parsed feed, finding (and remembering) the feed for a site address. */
async function load(input, state) {
  if (state.feed) {
    try {
      const r = await get(state.feed);
      if (looksLikeFeed(r.text)) return { feedUrl: r.url, feed: parseFeed(r.text, r.url) };
    } catch (e) {
      if (state.feed === input || /out of requests/.test(e.message)) throw e;
    }
    delete state.feed; // the remembered feed moved or broke: look for it again on the site
  }
  const page = await get(input);
  if (looksLikeFeed(page.text)) return { feedUrl: page.url, feed: parseFeed(page.text, page.url) };
  const found = discoverFeed(page.text, page.url);
  if (!found) throw new Error('is not a feed, and the page has no <link rel="alternate"> to an RSS or Atom feed');
  const r = await get(found);
  if (!looksLikeFeed(r.text)) throw new Error(`points to ${found}, which is not an RSS or Atom feed`);
  ferry.log(`${input}: found feed ${r.url}`);
  return { feedUrl: r.url, feed: parseFeed(r.text, r.url) };
}

async function check() {
  const states = ferry.storage.get('feeds') || {};
  let queue = ferry.storage.get('queue') || [];
  const now = Date.now();
  let sent = (ferry.storage.get('sent') || []).filter((t) => now - t < 3600_000);

  // Forget feeds that were removed from the settings.
  for (const key of Object.keys(states)) if (!inputs.includes(key)) delete states[key];
  queue = queue.filter((q) => inputs.includes(q.src));

  // Check feeds round-robin so a long list still gets covered within the request limit.
  fetchesLeft = MAX_FETCHES_PER_RUN;
  const start = (ferry.storage.get('next') || 0) % inputs.length;
  let checked = 0;
  for (; checked < inputs.length && fetchesLeft > 0; checked++) {
    const input = inputs[(start + checked) % inputs.length];
    const state = states[input] || { seen: [] };
    try {
      const { feedUrl, feed } = await load(input, state);
      state.feed = feedUrl;
      if (feed.title) state.title = feed.title;
      const channel = state.title || new URL(feedUrl).hostname;
      const seen = new Set(state.seen);
      const ids = feed.items.map((it) => hashId(it.id));
      if (state.seen.length || state.primed) {
        const fresh = feed.items.filter((it, i) => !seen.has(ids[i]));
        // Oldest first, so the newest post ends up on top of the list on your devices.
        // Feeds list newest first; sort by date when every new post has one.
        if (fresh.every((it) => it.date)) fresh.sort((a, b) => a.date - b.date);
        else fresh.reverse();
        for (const it of fresh) queue.push({ src: input, title: it.title || channel, url: it.link, body: it.summary, channel });
      } else if (feed.items.length) {
        ferry.log(`${input}: following "${channel}" (${feed.items.length} posts already there, not pushed)`);
      }
      state.primed = true;
      const keep = Math.min(MAX_SEEN, Math.max(KEEP_SEEN, ids.length));
      state.seen = [...new Set([...ids, ...state.seen])].slice(0, keep);
      states[input] = state;
    } catch (e) {
      if (/out of requests/.test(e.message)) break;
      ferry.log(`${input}: skipped, ${e.message}`);
      states[input] = state;
    }
  }
  await ferry.storage.set('next', (start + checked) % inputs.length);

  if (queue.length > MAX_QUEUE) {
    ferry.log(`Too many new posts at once, dropped the ${queue.length - MAX_QUEUE} oldest`);
    queue = queue.slice(-MAX_QUEUE);
  }

  let pushed = 0;
  while (queue.length && pushed < MAX_PER_RUN && sent.length < MAX_PER_HOUR) {
    const q = queue[0];
    const link = /^https?:\/\/\S+$/i.test(q.url || '') ? q.url : undefined;
    try {
      await ferry.send({ title: q.title, url: link, body: q.body || (link ? undefined : q.title), channel: q.channel });
    } catch (e) {
      ferry.log(`Could not push "${q.title}": ${e.message}`);
      if (/limit/.test(e.message)) break;
    }
    queue.shift();
    sent.push(Date.now());
    pushed++;
  }
  await ferry.storage.set('feeds', states);
  await ferry.storage.set('queue', queue);
  await ferry.storage.set('sent', sent);
  if (pushed) ferry.log(`Pushed ${pushed} post${pushed === 1 ? '' : 's'}${queue.length ? `, ${queue.length} waiting for the next check` : ''}`);
}

let running = false;
ferry.on('start', () => {
  if (!inputs.length) { ferry.log('No valid addresses. Each one must start with http:// or https://'); return; }
  ferry.log(`Following ${inputs.length} feed(s), checking every ${minutes} min`);
  ferry.every(minutes, async () => {
    if (running) return; // the last check is still going
    running = true;
    try { await check(); } finally { running = false; }
  });
});
