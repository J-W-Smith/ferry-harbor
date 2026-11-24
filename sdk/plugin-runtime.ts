// Synced from the Ferry app repo by tools/sync-harbor.ts. Do not edit here.
// What runs inside a plugin's sandbox (a Web Worker on desktop).
// lockdown and installFerryApi are turned into source text with toString(), so they must be
// self-contained: no imports, no references to anything outside their own bodies.

import type { PluginBundle } from './plugin.ts';

/** Messages the sandbox sends to the host. */
export type FromPlugin =
  | { t: 'call'; rid: number; method: 'send' | 'notify' | 'fetch' | 'storage'; args: unknown[] }
  | { t: 'log'; level: 'info' | 'error'; text: string }
  | { t: 'pong' };

/** Messages the host sends to the sandbox. */
export type ToPlugin =
  | { t: 'push'; push: { kind: 'note' | 'link'; title?: string; body?: string; url?: string; from: string } }
  | { t: 'reply'; rid: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'stop' }
  | { t: 'ping' };

export interface PluginInit { settings: Record<string, unknown>; storage: Record<string, unknown> }

/** Removes every way to reach the network or other storage, so ferry.* is the only way out. */
export function lockdown(scope: any) {
  const names = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'importScripts',
    'Worker', 'SharedWorker', 'BroadcastChannel', 'indexedDB', 'caches', 'Request', 'Notification',
    'FileSystemHandle', 'FileSystemDirectoryHandle', 'StorageManager', 'RTCPeerConnection', 'webkitRTCPeerConnection',
    'RTCDataChannel', 'ServiceWorkerContainer', 'CookieStore', 'cookieStore', 'WebAssemblyStreaming',
  ];
  for (const n of names) {
    for (let o = scope; o; o = Object.getPrototypeOf(o)) {
      if (Object.prototype.hasOwnProperty.call(o, n)) {
        try { delete o[n]; } catch { /* ignore */ }
        try { if (n in o) Object.defineProperty(o, n, { value: undefined, configurable: false, writable: false }); } catch { /* ignore */ }
      }
    }
  }
  const nav = scope.navigator;
  if (nav) for (const n of ['storage', 'serviceWorker', 'sendBeacon', 'locks']) {
    for (let o = nav; o; o = Object.getPrototypeOf(o)) {
      if (Object.prototype.hasOwnProperty.call(o, n)) try { delete o[n]; } catch { /* ignore */ }
    }
  }
}

/** Installs the global `ferry` object. Returns the handler for host messages. */
export function installFerryApi(scope: any, post: (m: unknown) => void, init: { settings: Record<string, unknown>; storage: Record<string, unknown> }) {
  let rid = 0;
  const waiting = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  const handlers: Record<string, Array<(...a: any[]) => unknown>> = { start: [], push: [], stop: [] };
  const settings = { ...init.settings };
  let store: Record<string, unknown> = { ...init.storage };

  const fmt = (v: unknown) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || v.message;
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const report = (e: unknown) => post({ t: 'log', level: 'error', text: fmt(e) });
  const call = (method: string, args: unknown[]) => new Promise<any>((res, rej) => {
    const id = ++rid;
    waiting.set(id, { res, rej });
    post({ t: 'call', rid: id, method, args });
  });
  const emit = (ev: string, arg?: unknown) => {
    for (const fn of handlers[ev] ?? []) {
      try { const r = fn(arg); if (r && typeof (r as any).then === 'function') (r as Promise<unknown>).catch(report); } catch (e) { report(e); }
    }
  };
  const clone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const ferry = Object.freeze({
    /** Values the user entered in this plugin's settings. */
    get settings() { return { ...settings }; },
    /** ferry.on('start' | 'push' | 'stop', fn) */
    on(ev: string, fn: (...a: any[]) => unknown) {
      if (!handlers[ev]) throw new Error(`unknown event: ${ev}`);
      if (typeof fn !== 'function') throw new Error('handler must be a function');
      handlers[ev]!.push(fn);
    },
    /** Push a note or link to all your devices. Needs "send". */
    send(p: { title?: string; body?: string; url?: string }) { return call('send', [clone(p)]); },
    /** Show a notification on this computer only. Needs "notify". */
    notify(title: string, body?: string) { return call('notify', [String(title ?? ''), String(body ?? '')]); },
    /** HTTP request to a host listed in the plugin's net: permissions. Resolves {status, headers, text}. */
    fetch(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }) { return call('fetch', [String(url), clone(opts ?? {})]); },
    /** Small key-value store kept between runs (256 KB). */
    storage: Object.freeze({
      get(key: string) { return clone(store[key]); },
      async set(key: string, value: unknown) { const next = { ...store, [key]: clone(value) }; await call('storage', [next]); store = next; },
      async delete(key: string) { const next = { ...store }; delete next[key]; await call('storage', [next]); store = next; },
    }),
    /** Run fn now-ish and then every `minutes` (at least 1). Returns a timer id for clearInterval. */
    every(minutes: number, fn: () => unknown) {
      const ms = Math.max(1, Number(minutes) || 1) * 60_000;
      const run = () => { try { const r = fn(); if (r && typeof (r as any).then === 'function') (r as Promise<unknown>).catch(report); } catch (e) { report(e); } };
      setTimeout(run, 0);
      return setInterval(run, ms);
    },
    log(...a: unknown[]) { post({ t: 'log', level: 'info', text: a.map(fmt).join(' ') }); },
  });
  Object.defineProperty(scope, 'ferry', { value: ferry, writable: false, configurable: false, enumerable: true });
  if (typeof scope.addEventListener === 'function') {
    scope.addEventListener('error', (e: any) => report(e?.error ?? e?.message ?? e));
    scope.addEventListener('unhandledrejection', (e: any) => report(e?.reason ?? e));
  }

  let started = false;
  return {
    start() { if (!started) { started = true; emit('start'); } },
    onMessage(m: any) {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'reply') {
        const w = waiting.get(m.rid);
        if (!w) return;
        waiting.delete(m.rid);
        if (m.ok) w.res(m.value); else w.rej(new Error(String(m.error ?? 'failed')));
      } else if (m.t === 'push') emit('push', m.push);
      else if (m.t === 'stop') emit('stop');
      else if (m.t === 'ping') post({ t: 'pong' });
    },
  };
}

/** Full source for a classic Web Worker running one plugin. */
export function workerSource(bundle: PluginBundle, init: PluginInit) {
  return [
    '"use strict";',
    `(${lockdown.toString()})(self);`,
    `const __ferry = (${installFerryApi.toString()})(self, (m) => postMessage(m), ${JSON.stringify(init)});`,
    'self.addEventListener("message", (e) => __ferry.onMessage(e.data));',
    'try {',
    `(function (ferry) { "use strict";\n${bundle.code}\n})(self.ferry);`,
    '} catch (e) { postMessage({ t: "log", level: "error", text: String(e && e.stack || e) }); }',
    'setTimeout(() => __ferry.start(), 0);',
  ].join('\n');
}
