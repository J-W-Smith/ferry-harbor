// Pushes when a site goes down (or comes back). Remembers the last state so it only pushes on changes.

const urls = String(ferry.settings.urls).split(/[\s,]+/).filter((u) => /^https?:\/\//i.test(u));
const minutes = Math.max(1, Number(ferry.settings.minutes) || 5);

async function check(url) {
  try {
    const r = await ferry.fetch(url, { method: 'GET' });
    return r.status < 500 ? 'up' : `down (HTTP ${r.status})`;
  } catch (e) {
    return `down (${e.message})`;
  }
}

ferry.on('start', () => {
  if (!urls.length) { ferry.log('No valid addresses. Each one must start with http:// or https://'); return; }
  ferry.log(`Checking ${urls.length} address(es) every ${minutes} min`);
  ferry.every(minutes, async () => {
    const last = ferry.storage.get('last') || {};
    const now = {};
    for (const url of urls) {
      now[url] = await check(url);
      const wasUp = (last[url] ?? 'up') === 'up';
      const isUp = now[url] === 'up';
      if (wasUp && !isUp) await ferry.send({ title: 'Site down', body: `${url} is ${now[url]}`, url });
      if (!wasUp && isUp) await ferry.send({ title: 'Site back up', body: `${url} is up again`, url });
    }
    await ferry.storage.set('last', now);
  });
});
