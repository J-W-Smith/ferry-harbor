# Ferry Harbor

The Harbor is where Ferry's **Crew** (plugins) sign on. Crew add new sources and actions to Ferry: watch a site, poll an API, react to links you push.

Every crew member here was reviewed by a harbor master before it was merged, and Ferry installs exactly the reviewed bytes, pinned by sha256.

Crew run on Ferry for desktop today. Your phone and browser receive whatever they send.

## How a crew member is made

A crew member is a folder named after its id, with two files:

```
crew/my-plugin/
  ferry-plugin.json   the manifest: what it is and what it may do
  plugin.js           the code, one plain JavaScript file, no build step
```

`ferry-plugin.json`:

```json
{
  "api": 1,
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "One sentence about what it does.",
  "author": "Your name or GitHub handle",
  "homepage": "https://github.com/you/my-plugin",
  "license": "MIT",
  "permissions": ["send", "net:api.example.com"],
  "settings": [
    { "key": "token", "label": "API token", "type": "password", "required": true },
    { "key": "minutes", "label": "Check every (minutes)", "type": "number", "default": 15 }
  ]
}
```

- `id`: 2 to 40 characters, using lowercase letters, digits and dashes. It never changes.
- `version`: `1.2.3`. Bump it for every change.
- `settings` types: `text`, `password`, `number`, `toggle`. The user fills them in on the plugin's page.

### Permissions

Ask only for what you use. The user sees this list before installing, and Ferry refuses anything not on it.

| Permission | Lets the plugin |
|---|---|
| `send` | push notes and links to all the user's devices (30 an hour) |
| `receive` | read notes and links that arrive on this computer |
| `notify` | show a notification on this computer only (60 an hour) |
| `net:api.example.com` | make requests to that host |
| `net:*.example.com` | make requests to that domain's subdomains |
| `net:*` | make requests to any public website. Use only when the user chooses the address (like an uptime checker) |

Local and private addresses (localhost, 192.168.x.x and so on) are always blocked, and redirects are not followed.

## The `ferry` API

Your code runs in a sandbox with a global `ferry` object. It has no `fetch`, `XMLHttpRequest`, `WebSocket`, DOM, file system, or access to Ferry's keys. The `ferry` object is the only way out.

```js
ferry.settings                 // { key: value } from the plugin's settings
ferry.on('start', fn)          // after the plugin loads (and after every settings change)
ferry.on('push', (p) => …)     // incoming { kind: 'note'|'link', title, body, url, from }  (needs "receive")
ferry.on('stop', fn)           // just before the plugin is turned off
await ferry.send({ title, body, url })   // url makes it a link; needs "send"
await ferry.notify(title, body)          // needs "notify"
const r = await ferry.fetch(url, { method, headers, body })  // → { status, headers, text }; needs "net:…"
ferry.storage.get(key)                   // saved between runs, 256 KB in all
await ferry.storage.set(key, value)
await ferry.storage.delete(key)
ferry.every(minutes, fn)       // run now and then every N minutes (at least 1)
ferry.log(...values)           // writes to the plugin's ship's log in Ferry
```

Requests fail if the response is over 2 MB or takes longer than 15 seconds. A plugin that freezes its thread for 40 seconds is stopped.

See [`uptime-check`](crew/uptime-check/plugin.js) and [`hn-top`](crew/hn-top/plugin.js) for complete examples.

## Try it on your computer

```
npm install
node sdk/ferry-plugin.ts validate crew/my-plugin
node sdk/ferry-plugin.ts dev crew/my-plugin
```

Then in Ferry for desktop:

1. Open **Crew → Developers**.
2. Paste `http://localhost:8790/bundle.json` and install.
3. After each edit, press **Reload code** on the plugin's page.

Developer installs are marked unreviewed.

## Send it in

1. Fork this repository and add your folder under `crew/`.
2. Run `node sdk/ferry-plugin.ts validate crew/<id>`.
3. Open a pull request. Say what the plugin does and why it needs each permission.

Don't edit `dist/` or `sdk/`. Harbor masters rebuild `dist/` after merging, and `sdk/` is synced from the Ferry app repo.

### What harbor masters check

- The code is readable: no minified, obfuscated or generated code, and no `eval` tricks.
- Every permission is needed, and `net:*` is used only when the user picks the addresses.
- It sends data only where its description says. It never sends settings such as tokens anywhere else.
- It respects the services it calls: sensible intervals and their terms of use.
- It doesn't use another company's name or logo in a way that looks official.

Updates go through the same review. If a new version asks for more permissions, Ferry asks the user again before updating.

## For harbor masters

After merging, rebuild the registry and commit it:

```
npm run index
```

Ferry for desktop reads `dist/index.json` from this repo's `main` branch.
