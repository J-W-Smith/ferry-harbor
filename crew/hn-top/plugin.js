// Uses the official Hacker News API (https://github.com/HackerNews/API).

const API = 'https://hacker-news.firebaseio.com/v0';
const minScore = Number(ferry.settings.minScore) || 300;
const minutes = Math.max(5, Number(ferry.settings.minutes) || 30);

async function json(path) {
  const r = await ferry.fetch(`${API}/${path}`);
  if (r.status !== 200) throw new Error(`Hacker News answered ${r.status}`);
  return JSON.parse(r.text);
}

ferry.on('start', () => {
  ferry.every(minutes, async () => {
    const seen = ferry.storage.get('seen') || [];
    const ids = (await json('topstories.json')).slice(0, 30);
    let pushed = 0;
    for (const id of ids) {
      if (seen.includes(id)) continue;
      const s = await json(`item/${id}.json`);
      if (!s || s.score < minScore) continue;
      seen.push(id);
      await ferry.send({ title: `${s.title} (${s.score} points)`, url: s.url || `https://news.ycombinator.com/item?id=${id}` });
      if (++pushed >= 5) break; // don't flood you on the first run
    }
    await ferry.storage.set('seen', seen.slice(-500));
    if (pushed) ferry.log(`Pushed ${pushed} stor${pushed === 1 ? 'y' : 'ies'}`);
  });
});
