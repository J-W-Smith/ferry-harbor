// node --test crew/github-notify/plugin.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8');

// Run plugin.js the way Ferry does, with a fake ferry object, and hand back its helpers.
function load(settings, responses = []) {
  const store = {};
  const sent = [];
  const logs = [];
  const requests = [];
  let tick;
  const ferry = {
    settings,
    on: (ev, fn) => { if (ev === 'start') ferry.start = fn; },
    send: async (p) => { sent.push(JSON.parse(JSON.stringify(p))); },
    fetch: async (url, opts) => { requests.push({ url, opts }); return responses.shift(); },
    storage: { get: (k) => store[k], set: async (k, v) => { store[k] = v; }, delete: async (k) => { delete store[k]; } },
    every: (_m, fn) => { tick = fn; return 1; },
    log: (...a) => logs.push(a.join(' ')),
  };
  const fn = vm.runInNewContext(`(function (ferry) { "use strict";\n${code}\n;return { htmlUrl, parseReasons, wanted, describe, check };})`, { clearInterval() {} });
  const api = fn(ferry);
  return { ...api, ferry, store, sent, logs, requests, tick: () => tick() };
}

const repo = { full_name: 'octo/hello', html_url: 'https://github.com/octo/hello' };
const note = (id, reason, type, url, updated = '2030-01-01T00:00:00Z') =>
  ({ id: String(id), reason, updated_at: updated, repository: repo, subject: { title: `Thing ${id}`, type, url } });

test('maps API subject URLs to html URLs', () => {
  const { htmlUrl } = load({ token: 't' });
  const a = 'https://api.github.com/repos/octo/hello';
  assert.equal(htmlUrl(note(1, 'x', 'PullRequest', `${a}/pulls/42`)), 'https://github.com/octo/hello/pull/42');
  assert.equal(htmlUrl(note(1, 'x', 'Issue', `${a}/issues/7`)), 'https://github.com/octo/hello/issues/7');
  assert.equal(htmlUrl(note(1, 'x', 'Commit', `${a}/commits/abc123`)), 'https://github.com/octo/hello/commit/abc123');
  assert.equal(htmlUrl(note(1, 'x', 'Release', `${a}/releases/99`)), 'https://github.com/octo/hello/releases');
  assert.equal(htmlUrl(note(1, 'x', 'Discussion', null)), 'https://github.com/octo/hello/discussions');
  assert.equal(htmlUrl(note(1, 'ci_activity', 'CheckSuite', null)), 'https://github.com/octo/hello/actions');
  assert.equal(htmlUrl(note(1, 'x', 'Unknown', 'https://evil.example/repos/a/b/pulls/1')), 'https://github.com/octo/hello');
});

test('parses and applies the reasons filter', () => {
  const { parseReasons, wanted } = load({ token: 't' });
  assert.deepEqual([...parseReasons(' review_requested, Mention ,assign')], ['review_requested', 'mention', 'assign']);
  assert.deepEqual([...parseReasons('')], []);
  assert.equal(wanted(note(1, 'mention'), []), true);
  assert.equal(wanted(note(1, 'mention'), ['mention']), true);
  assert.equal(wanted(note(1, 'subscribed'), ['mention']), false);
});

test('sends new matching notifications once, skips old ones, never sends the token', async () => {
  const list = [
    note(1, 'review_requested', 'PullRequest', 'https://api.github.com/repos/octo/hello/pulls/5'),
    note(2, 'subscribed', 'Issue', 'https://api.github.com/repos/octo/hello/issues/6'),
    note(3, 'mention', 'Issue', 'https://api.github.com/repos/octo/hello/issues/8', '2000-01-01T00:00:00Z'),
  ];
  const ok = { status: 200, headers: { 'Last-Modified': 'Wed, 01 Jan 2030 00:00:00 GMT' }, text: JSON.stringify(list) };
  const p = load({ token: 'secret-token', reasons: 'review_requested, mention' }, [ok, { ...ok }]);
  await p.ferry.start();
  await p.tick();
  assert.deepEqual(p.sent, [{
    title: 'octo/hello: Thing 1',
    body: 'Your review was requested (pull request)',
    url: 'https://github.com/octo/hello/pull/5',
    channel: 'octo/hello',
  }]);
  assert.equal(p.requests[0].opts.headers.Authorization, 'Bearer secret-token');
  await p.tick();
  assert.equal(p.sent.length, 1, 'deduped on the second check');
  assert.equal(p.requests[1].opts.headers['If-Modified-Since'], 'Wed, 01 Jan 2030 00:00:00 GMT');
  assert.ok(!JSON.stringify([p.sent, p.logs]).includes('secret-token'));
});

test('stops checking after a 401', async () => {
  const p = load({ token: 'bad' }, [{ status: 401, headers: {}, text: '' }]);
  await p.ferry.start();
  await p.tick();
  await p.tick();
  assert.equal(p.requests.length, 1);
  assert.match(p.logs.join('\n'), /401/);
});
