// Watches a public Steam wishlist and pushes when games go on sale.
// Uses public endpoints that need no API key:
//   steamcommunity.com/id/<name>/?xml=1                 custom URL name → SteamID64
//   api.steampowered.com/IWishlistService/GetWishlist   the wishlist's app ids
//   api.steampowered.com/IStoreBrowseService/GetItems   names and prices, up to 100 apps a request
// Unofficial; not made by or affiliated with Valve.

const API = 'https://api.steampowered.com';
const COMMUNITY = 'https://steamcommunity.com';
const BATCH = 100;           // apps per price request
const PAUSE_MS = 1500;       // between price requests, to be polite
const MAX_PUSHES = 10;       // per check, so a big sale doesn't flood you

const input = String(ferry.settings.steamId || '').trim();
const minDiscount = Math.min(100, Math.max(1, Number(ferry.settings.minDiscount) || 20));
const country = /^[a-z]{2}$/i.test(String(ferry.settings.country || '').trim())
  ? String(ferry.settings.country).trim().toUpperCase() : 'US';
const hours = Math.max(2, Number(ferry.settings.hours) || 6);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class StopRun extends Error {}

async function get(url) {
  const r = await ferry.fetch(url);
  if (r.status === 429) throw new StopRun('Steam asked us to slow down (429). Trying again next check.');
  return r;
}

// Accepts a SteamID64, a /profiles/<id> link, a /id/<name> link, or a bare custom URL name.
function parseInput(text) {
  const profile = text.match(/\/profiles\/(\d{17})/);
  if (profile) return { id: profile[1] };
  if (/^\d{17}$/.test(text)) return { id: text };
  const vanity = text.match(/\/id\/([^/?#\s]+)/);
  if (vanity) return { vanity: vanity[1] };
  if (/^[A-Za-z0-9_-]{2,32}$/.test(text)) return { vanity: text };
  return {};
}

async function profileXml(path) {
  const r = await get(`${COMMUNITY}/${path}/?xml=1`);
  if (r.status !== 200) throw new StopRun(`Steam Community answered ${r.status} for the profile.`);
  return r.text;
}

async function resolveId() {
  const parsed = parseInput(input);
  if (parsed.id) return parsed.id;
  if (!parsed.vanity) throw new StopRun(`"${input}" doesn't look like a SteamID64, a profile link or a custom URL name.`);
  const cached = ferry.storage.get('resolved');
  if (cached && cached.vanity === parsed.vanity) return cached.id;
  const xml = await profileXml(`id/${encodeURIComponent(parsed.vanity)}`);
  const m = xml.match(/<steamID64>(\d{17})<\/steamID64>/);
  if (!m) throw new StopRun(`No Steam profile found for the custom URL "${parsed.vanity}".`);
  await ferry.storage.set('resolved', { vanity: parsed.vanity, id: m[1] });
  return m[1];
}

async function wishlistAppIds(steamId) {
  const r = await get(`${API}/IWishlistService/GetWishlist/v1/?steamid=${steamId}`);
  if (r.status !== 200) throw new StopRun(`Steam answered ${r.status} for the wishlist of ${steamId}. Check the Steam profile setting.`);
  const items = (JSON.parse(r.text).response || {}).items || [];
  if (!items.length) {
    // Private and empty wishlists look the same here, so check the profile to say which.
    const xml = await profileXml(`profiles/${steamId}`).catch(() => '');
    const privacy = (xml.match(/<privacyState>(\w+)<\/privacyState>/) || [])[1];
    if (/<error>/.test(xml)) throw new StopRun(`No Steam profile has the id ${steamId}.`);
    if (privacy && privacy !== 'public') throw new StopRun(`The Steam profile ${steamId} is ${privacy}. Make your profile and game details public so the wishlist can be read.`);
    throw new StopRun(`The wishlist for ${steamId} is empty or private. Set Game details to Public in Steam's privacy settings.`);
  }
  return items.map((i) => i.appid);
}

// Returns [{ appid, name, pct, final, initial }] for every app currently discounted.
async function discounted(appIds) {
  const out = [];
  for (let i = 0; i < appIds.length; i += BATCH) {
    if (i) await sleep(PAUSE_MS);
    const query = {
      ids: appIds.slice(i, i + BATCH).map((appid) => ({ appid })),
      context: { language: 'english', country_code: country },
      data_request: {},
    };
    const r = await get(`${API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(query))}`);
    if (r.status !== 200) throw new StopRun(`Steam answered ${r.status} for prices.`);
    for (const item of (JSON.parse(r.text).response || {}).store_items || []) {
      const p = item.best_purchase_option;
      if (!p || !p.discount_pct) continue;
      out.push({
        appid: item.appid || item.id,
        name: item.name || `App ${item.id}`,
        pct: p.discount_pct,
        final: p.formatted_final_price,
        initial: p.formatted_original_price,
      });
    }
  }
  return out;
}

async function check() {
  if (!input) return ferry.log('Set your Steam profile on this page to start.');
  try {
    const steamId = await resolveId();
    const owner = `${steamId}|${country}`;
    const firstRun = ferry.storage.get('owner') !== owner;
    const pushed = firstRun ? {} : (ferry.storage.get('pushed') || {}); // appid → discount we pushed for

    const appIds = await wishlistAppIds(steamId);
    const sales = await discounted(appIds);
    const onSale = new Set(sales.map((s) => String(s.appid)));

    // A sale that ended is forgotten, so the next sale for that game pushes again.
    for (const id of Object.keys(pushed)) if (!onSale.has(id)) delete pushed[id];

    const fresh = sales
      .filter((s) => s.pct >= minDiscount && (pushed[s.appid] || 0) < s.pct)
      .sort((a, b) => b.pct - a.pct);

    let sent = 0;
    for (const s of fresh) {
      if (sent < MAX_PUSHES) {
        try {
          await ferry.send({
            title: `${s.name} −${s.pct}% · ${s.final}`,
            url: `https://store.steampowered.com/app/${s.appid}/`,
            body: `was ${s.initial}`,
            channel: 'Steam wishlist',
          });
        } catch (e) {
          ferry.log(`Could not push ${s.name}: ${e.message}`);
          break; // leave the rest unmarked so they push next check
        }
        sent++;
      }
      pushed[s.appid] = s.pct; // past the cap we remember it without pushing
    }

    await ferry.storage.set('pushed', pushed);
    await ferry.storage.set('owner', owner);
    const extra = fresh.length - sent;
    ferry.log(`${appIds.length} games on the wishlist, ${sales.length} on sale, pushed ${sent}` +
      (extra > 0 ? ` (${extra} more remembered without a push)` : '') + '.');
  } catch (e) {
    ferry.log(e instanceof StopRun ? e.message : `Check failed: ${e.message}`);
  }
}

ferry.on('start', () => ferry.every(hours * 60, check));
