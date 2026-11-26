// Pushes active National Weather Service alerts (https://www.weather.gov/documentation/services-web-api).
// Free, no key. NWS asks every client to send a User-Agent that identifies it.

const API = 'https://api.weather.gov/alerts/active';
const HEADERS = {
  'User-Agent': 'ferry-weather-alerts (github.com/J-W-Smith/ferry-harbor)',
  Accept: 'application/geo+json',
};
const SEVERITIES = ['Minor', 'Moderate', 'Severe', 'Extreme'];
const STATES = ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY ' +
  'AS GU MP PR VI').split(' ');
const MAX_PER_RUN = 5;    // don't flood you when a big storm system arrives
const MAX_REMEMBERED = 300;

const minutes = Math.max(2, Number(ferry.settings.minutes) || 5);

// "32.7767,-96.7970" → "point=32.7767,-96.797"; "tx" → "area=TX"; anything else → null.
function locationQuery(raw) {
  const text = String(raw ?? '').trim();
  if (/^[a-z]{2}$/i.test(text)) {
    const code = text.toUpperCase();
    return STATES.includes(code) ? `area=${code}` : null;
  }
  const m = text.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  // weather.gov redirects points with more than 4 decimals, and Ferry doesn't follow redirects.
  const round = (n) => String(Math.round(n * 10000) / 10000);
  return `point=${round(lat)},${round(lon)}`;
}

function severityRank(s) {
  return SEVERITIES.findIndex((x) => x.toLowerCase() === String(s ?? '').trim().toLowerCase());
}

function endTime(p) {
  const t = Date.parse(p.ends || p.expires || '');
  return Number.isNaN(t) ? null : t;
}

function localTime(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function cut(text, max) {
  if (text.length <= max) return text;
  const short = text.slice(0, max);
  const lastSpace = short.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? short.slice(0, lastSpace) : short) + '…';
}

// "Dallas, TX; Tarrant, TX; Collin, TX" → "Dallas, TX +2"
function shortArea(areaDesc) {
  const areas = String(areaDesc ?? '').split(';').map((a) => a.trim()).filter(Boolean);
  if (!areas.length) return 'Weather alerts';
  const first = cut(areas[0], 32);
  return areas.length > 1 ? `${first} +${areas.length - 1}` : first;
}

function message(p, updated) {
  const ends = endTime(p);
  const title = `${updated ? 'Updated: ' : ''}${clean(p.event) || 'Weather alert'}${ends ? ` until ${localTime(ends)}` : ''}`;
  const parts = [];
  if (p.headline) parts.push(clean(p.headline));
  if (p.description) parts.push(cut(clean(p.description), 400));
  const instruction = clean(p.instruction);
  if (instruction && instruction.length <= 200) parts.push(instruction);
  const url = typeof p.web === 'string' && /^https?:\/\//i.test(p.web) ? p.web : 'https://alerts.weather.gov';
  return { title, body: parts.join('\n\n'), url, channel: shortArea(p.areaDesc) };
}

async function fetchAlerts(query) {
  const r = await ferry.fetch(`${API}?${query}`, { method: 'GET', headers: HEADERS });
  if (r.status !== 200) {
    let detail = '';
    try { detail = JSON.parse(r.text).detail || ''; } catch { /* not JSON */ }
    throw new Error(`weather.gov answered ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = JSON.parse(r.text);
  return Array.isArray(data.features) ? data.features.map((f) => f.properties || {}) : [];
}

// pushed: { [alertId]: { sent, ends } }. An NWS update either keeps the id with a new `sent`,
// or comes as a new id whose `references` name the alert it replaces.
async function check(query, minRank) {
  const pushed = ferry.storage.get('pushed') || {};
  const now = Date.now();
  for (const [id, a] of Object.entries(pushed)) {
    if (a.ends !== null && a.ends < now) delete pushed[id];
  }

  const alerts = await fetchAlerts(query);
  let sent = 0;
  for (const p of alerts) {
    if (!p.id || p.status !== 'Actual' || p.messageType === 'Cancel') continue;
    if (severityRank(p.severity) < minRank) continue;
    const known = pushed[p.id];
    if (known && known.sent === p.sent) continue;
    const replaces = (p.references || []).some((ref) => ref && pushed[ref.identifier]);
    const updated = Boolean(known) || replaces;
    if (sent >= MAX_PER_RUN) break; // the rest go out next time
    await ferry.send(message(p, updated));
    pushed[p.id] = { sent: p.sent, ends: endTime(p) };
    sent++;
  }

  const ids = Object.keys(pushed);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_REMEMBERED))) delete pushed[id];
  await ferry.storage.set('pushed', pushed);
  if (sent) ferry.log(`Pushed ${sent} alert${sent === 1 ? '' : 's'}`);
}

ferry.on('start', () => {
  const query = locationQuery(ferry.settings.location);
  if (!query) {
    ferry.log(`Location "${ferry.settings.location ?? ''}" isn't valid. Use "lat,lon" like 32.7767,-96.7970 (US only), or a two-letter state code like TX.`);
    return;
  }
  let minRank = severityRank(ferry.settings.minSeverity || 'Moderate');
  if (minRank < 0) {
    ferry.log(`Lowest severity "${ferry.settings.minSeverity}" isn't one of ${SEVERITIES.join(', ')}. Using Moderate.`);
    minRank = severityRank('Moderate');
  }
  ferry.log(`Checking weather.gov alerts for ${query.replace('=', ' ')} (${SEVERITIES[minRank]} and up) every ${minutes} min`);
  ferry.every(minutes, async () => {
    try {
      await check(query, minRank);
    } catch (e) {
      ferry.log(`Couldn't check alerts, will retry in ${minutes} min: ${e.message}`);
    }
  });
});
