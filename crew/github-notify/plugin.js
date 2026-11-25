// Uses the GitHub REST notifications API (https://docs.github.com/rest/activity/notifications).
// It only reads notifications. It never marks them as read, and the token goes only to api.github.com.

const API = 'https://api.github.com/notifications?per_page=50';
const token = String(ferry.settings.token || '').trim();
const reasons = parseReasons(ferry.settings.reasons);
const minutes = Math.max(2, Number(ferry.settings.minutes) || 5);
const MAX_PER_CHECK = 10; // Ferry allows 30 pushes an hour
const MAX_SEEN = 300;

const REASON_WORDS = {
  approval_requested: 'Your approval was requested',
  assign: 'You were assigned',
  author: 'New activity on something you opened',
  ci_activity: 'A workflow run you started finished',
  comment: 'New comment on a thread you commented on',
  invitation: 'You were invited to the repository',
  manual: 'New activity on a thread you subscribed to',
  member_feature_requested: 'A member asked for a feature',
  mention: 'You were mentioned',
  review_requested: 'Your review was requested',
  security_advisory_credit: 'You were credited on a security advisory',
  security_alert: 'New security alert',
  state_change: 'You changed the state of this thread',
  subscribed: 'New activity in a repository you watch',
  team_mention: 'Your team was mentioned',
};

const TYPE_WORDS = {
  PullRequest: 'pull request',
  Issue: 'issue',
  Release: 'release',
  Commit: 'commit',
  Discussion: 'discussion',
  CheckSuite: 'workflow run',
  RepositoryVulnerabilityAlert: 'security alert',
};

// "review_requested, Mention" -> ['review_requested', 'mention']; empty -> [] (all reasons)
function parseReasons(text) {
  return String(text || '').split(/[\s,]+/).map((r) => r.trim().toLowerCase()).filter(Boolean);
}

function wanted(n, reasonList) {
  return reasonList.length === 0 || reasonList.includes(String(n.reason).toLowerCase());
}

// Turn the API's subject.url into the page you would open in a browser.
function htmlUrl(n) {
  const repo = n.repository || {};
  const repoPage = repo.html_url || `https://github.com/${repo.full_name || ''}`;
  const api = n.subject && n.subject.url;
  const m = typeof api === 'string' && api.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/([a-z]+)\/([^/?#]+)$/);
  if (m) {
    const [, fullName, kind, ref] = m;
    const base = `https://github.com/${fullName}`;
    if (kind === 'pulls') return `${base}/pull/${ref}`;
    if (kind === 'issues') return `${base}/issues/${ref}`;
    if (kind === 'commits') return `${base}/commit/${ref}`;
    if (kind === 'discussions') return `${base}/discussions/${ref}`;
    if (kind === 'releases') return `${base}/releases`; // the API gives a numeric id, not the tag
  }
  const type = n.subject && n.subject.type;
  if (type === 'CheckSuite') return `${repoPage}/actions`;
  if (type === 'Discussion') return `${repoPage}/discussions`;
  if (type === 'Release') return `${repoPage}/releases`;
  return repoPage;
}

function describe(n) {
  const words = REASON_WORDS[n.reason] || `GitHub says: ${String(n.reason || 'update').replace(/_/g, ' ')}`;
  const type = TYPE_WORDS[n.subject && n.subject.type];
  return type ? `${words} (${type})` : words;
}

function header(headers, name) {
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name) return v;
  return undefined;
}

let stopped = false;
let timer;
let nextPollAt = 0;

async function check() {
  if (stopped || Date.now() < nextPollAt) return;
  const installedAt = ferry.storage.get('installedAt');
  const lastModified = ferry.storage.get('lastModified');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ferry-github-notify',
  };
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  const r = await ferry.fetch(API, { headers });

  const pollSeconds = Number(header(r.headers, 'x-poll-interval'));
  if (pollSeconds > 0) nextPollAt = Date.now() + pollSeconds * 1000;

  if (r.status === 304) return;
  if (r.status === 401) {
    stopped = true;
    if (timer !== undefined && typeof clearInterval === 'function') clearInterval(timer);
    ferry.log('GitHub rejected the token (401). Check the token in settings; checks are paused until you change them.');
    return;
  }
  if (r.status === 403 || r.status === 429) {
    const reset = Number(header(r.headers, 'x-ratelimit-reset'));
    const retry = Number(header(r.headers, 'retry-after'));
    if (retry > 0) nextPollAt = Math.max(nextPollAt, Date.now() + retry * 1000);
    else if (reset > 0) nextPollAt = Math.max(nextPollAt, reset * 1000);
    ferry.log(`GitHub answered ${r.status}: rate limited or the token lacks notifications access. Trying again later.`);
    return;
  }
  if (r.status !== 200) {
    ferry.log(`GitHub answered ${r.status}. Trying again next time.`);
    return;
  }

  const list = JSON.parse(r.text);
  const seen = ferry.storage.get('seen') || [];
  const fresh = list
    .filter((n) => Date.parse(n.updated_at) >= installedAt)
    .filter((n) => wanted(n, reasons))
    .filter((n) => !seen.includes(`${n.id}@${n.updated_at}`))
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));

  let pushed = 0;
  for (const n of fresh.slice(0, MAX_PER_CHECK)) {
    const repo = (n.repository && n.repository.full_name) || 'GitHub';
    await ferry.send({
      title: `${repo}: ${(n.subject && n.subject.title) || 'Notification'}`,
      body: describe(n),
      url: htmlUrl(n),
      channel: repo,
    });
    seen.push(`${n.id}@${n.updated_at}`);
    pushed++;
  }
  await ferry.storage.set('seen', seen.slice(-MAX_SEEN));
  // If some were held back, fetch the full list again next time instead of getting a 304.
  const lm = header(r.headers, 'last-modified');
  if (fresh.length <= MAX_PER_CHECK && lm) await ferry.storage.set('lastModified', lm);
  if (pushed) ferry.log(`Pushed ${pushed} notification${pushed === 1 ? '' : 's'}${fresh.length > pushed ? `, ${fresh.length - pushed} more next time` : ''}`);
}

ferry.on('start', async () => {
  if (!token) {
    ferry.log('Add a GitHub token in settings to start.');
    return;
  }
  // First run: nothing older than now is sent.
  if (!ferry.storage.get('installedAt')) await ferry.storage.set('installedAt', Date.now());
  timer = ferry.every(minutes, check);
});
