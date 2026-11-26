// Watches the pages you list and pushes a link when their visible text changes.
//
// For each page it keeps only a short fingerprint, not the page itself:
//   h     a hash of the whole page text (with times and dates blanked out)
//   lines hashes of the first 400 lines, so it can tell you which lines are new
//   had   whether the page contained your phrase last time (when "contains" is set)
//   p     a hash of that phrase, so changing the phrase starts over instead of pushing
//   sent  when it last pushed about this page
// The first check of a page only records this. A page that fails to load keeps its old fingerprint.

const MAX_LINES = 400;    // line hashes kept per page (about 3 KB)
const MAX_PAGES = 40;     // keeps storage well under the 256 KB limit
const MAX_PUSHES = 5;     // per check, so a busy run can't use up the 30-an-hour send limit

// ---- Text helpers (no DOM in the sandbox, so careful regexes) ----

/** Splits the "pages" setting into unique http(s) addresses. */
function parsePages(value) {
  const seen = new Set();
  for (const u of String(value || '').split(/[\s,]+/)) if (/^https?:\/\/\S+$/i.test(u)) seen.add(u);
  return [...seen];
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

/** The page's <title>, or '' if it has none. */
function pageTitle(html) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
}

/** Turns HTML into its visible text: one line per block, single spaces, no empty lines. */
function pageText(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Whole elements whose content is never visible text. The closing tag must match the opening one.
  s = s.replace(/<(script|style|noscript|template|svg|head|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // Block-level tags start a new line, so lines in the text roughly match lines on screen.
  s = s.replace(/<\/?(?:p|div|br|hr|li|ul|ol|dl|dt|dd|tr|table|thead|tbody|h[1-6]|section|article|header|footer|nav|aside|main|blockquote|pre|form|fieldset|figure|figcaption|details|summary|option)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi, '\n');
  // Any other tag. Quoted attribute values may contain '>', so skip over them.
  s = s.replace(/<\/?[a-z!?](?:"[^"]*"|'[^']*'|[^'">])*>/gi, ' ');
  s = decodeEntities(s);
  return s
    .split(/\r?\n/)
    .map((line) => line.replace(/[\s​ ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const VOLATILE = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?\b/gi, // 2026-11-25T10:00:00Z
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?(?:\s?(?:utc|gmt|[a-z]{1,4}t))?\b/gi,               // 10:42, 3:05 pm EST
  /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g,                                                           // 11/25/2026, 25.11.26
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'gi'),                  // Nov 25, 2026
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:,?\\s+\\d{4})?\\b`, 'gi'),                  // 25 November 2026
  /\b\d+\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|months?|y|yrs?|years?)\s+ago\b/gi, // 5 minutes ago
  /\b(?:just now|yesterday|today)\b/gi,
  /\b\d{10,}\b/g,                                                                                 // unix times, cache busters
];

/** Blanks out time and date tokens, so a clock or "updated 3 minutes ago" on the page isn't a change. */
function maskVolatile(line) {
  let s = line;
  for (const re of VOLATILE) s = s.replace(re, '#');
  return s.toLowerCase();
}

/** Small, fast string hash (FNV-1a, 32 bits) as base-36 text. Not for security, only to spot changes. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** The fingerprint stored for a page's text. */
function fingerprint(text) {
  const masked = text.split('\n').map(maskVolatile);
  return { h: hash(masked.join('\n')), lines: masked.slice(0, MAX_LINES).map(hash).join(',') };
}

/** Lines of the new text that weren't in the old fingerprint, in page order, at most `max`. */
function newLines(oldLines, text, max = 3) {
  const old = new Set(String(oldLines || '').split(','));
  const out = [];
  for (const line of text.split('\n').slice(0, MAX_LINES)) {
    if (old.has(hash(maskVolatile(line)))) continue;
    out.push(line.length > 160 ? `${line.slice(0, 157)}…` : line);
    if (out.length >= max) break;
  }
  return out;
}

/** The phrase setting, tidied the same way page text is, so "In  Stock" matches "in stock". */
function normalisePhrase(p) {
  return String(p || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The first line containing the phrase, for the push body. */
function lineWith(text, phrase) {
  const line = text.split('\n').find((l) => l.toLowerCase().includes(phrase)) || '';
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

function hostOf(url) {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(url);
  return m ? m[1].toLowerCase() : url;
}

// ---- Checking ----

/**
 * Decides what to do for one page. Pure, so it can be tested.
 * Returns { state, push } where push is null or { title, body, url, channel }.
 */
function compare(url, html, before, phrase, now, intervalMs) {
  const text = pageText(html);
  const fp = fingerprint(text);
  const has = phrase ? text.toLowerCase().includes(phrase) : undefined;
  const p = phrase ? hash(phrase) : undefined;
  const state = { h: fp.h, lines: fp.lines, had: has, p, sent: before?.sent || 0 };
  if (!before) return { state, push: null, baseline: true };            // first look: just remember it

  let body = null;
  if (phrase) {
    if (has && !before.had && before.p === p) body = lineWith(text, phrase) || `Now contains "${phrase}"`;
  } else if (fp.h !== before.h) {
    const added = newLines(before.lines, text);
    body = added.length ? added.join('\n') : 'Some text was removed from the page.';
  }
  if (!body) return { state, push: null };

  // Already pushed about this page within the last interval: keep the old fingerprint, so it pushes next time.
  // (90%, so a timer firing a little early doesn't hold every other change.)
  if (now - (before.sent || 0) < intervalMs * 0.9) return { state: before, push: null, held: true };

  state.sent = now;
  const host = hostOf(url);
  return { state, push: { title: `Changed: ${pageTitle(html) || host}`, body, url, channel: host } };
}

async function checkAll(pages, phrase, minutes) {
  const saved = ferry.storage.get('pages') || {};
  const next = {};
  let pushed = 0;
  for (const url of pages) {
    const before = saved[url];
    let html;
    try {
      const r = await ferry.fetch(url, { method: 'GET', headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' } });
      if (r.status >= 300 && r.status < 400) throw new Error(`redirects to ${r.headers?.location || 'another address'}; watch that address instead`);
      if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
      html = r.text || '';
    } catch (e) {
      ferry.log(`${url}: could not load (${e.message}). Will try again next time.`);
      if (before) next[url] = before;   // a page that's down is not a change: keep what we had
      continue;
    }
    if (pushed >= MAX_PUSHES) {                       // over this run's budget: look again next time
      if (before) next[url] = before;
      continue;
    }
    const result = compare(url, html, before, phrase, Date.now(), minutes * 60_000);
    next[url] = result.state;
    if (result.baseline) ferry.log(`${url}: watching from now on`);
    if (result.push) {
      try {
        await ferry.send(result.push);
        pushed++;
      } catch (e) {
        ferry.log(`${url}: changed, but could not push (${e.message})`);
        if (before) next[url] = before;               // try again next time
      }
    }
  }
  await ferry.storage.set('pages', next);              // also forgets pages you removed from the list
  if (pushed) ferry.log(`Pushed ${pushed} change${pushed === 1 ? '' : 's'}`);
}

ferry.on('start', () => {
  let pages = parsePages(ferry.settings.pages);
  const phrase = normalisePhrase(ferry.settings.contains);
  const minutes = Math.max(5, Number(ferry.settings.minutes) || 30);
  if (!pages.length) { ferry.log('No valid pages. Each one must start with http:// or https://'); return; }
  if (pages.length > MAX_PAGES) {
    ferry.log(`Watching the first ${MAX_PAGES} of ${pages.length} pages`);
    pages = pages.slice(0, MAX_PAGES);
  }
  ferry.log(`Watching ${pages.length} page(s) every ${minutes} min${phrase ? ` for "${phrase}"` : ''}`);
  let running = false;
  ferry.every(minutes, async () => {
    if (running) return;                               // a slow run is still going
    running = true;
    try { await checkAll(pages, phrase, minutes); } finally { running = false; }
  });
});
