// Synced from the Ferry app repo by tools/sync-harbor.ts. Do not edit here.
// Host side of one running plugin: checks every call against the plugin's permissions and limits,
// then hands it to the app. The app supplies the sandbox (a Worker on desktop) and the capabilities.

import { hostAllowed, type PluginManifest } from './plugin.ts';
import type { FromPlugin, ToPlugin } from './plugin-runtime.ts';

export interface Sandbox { post(m: ToPlugin): void; onMessage(fn: (m: FromPlugin) => void): void; terminate(): void }

export interface HostCaps {
  send(p: { kind: 'note' | 'link'; title?: string; body?: string; url?: string }): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  /** Must refuse private and local addresses and must not follow redirects. */
  fetch(url: string, opts: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; text: string }>;
  saveStorage(data: Record<string, unknown>): void;
  log(level: 'info' | 'error', text: string): void;
}

export const LIMITS = {
  sendsPerHour: 30,
  notifiesPerHour: 60,
  fetchesPerMinute: 30,
  storageBytes: 256 * 1024,
  titleChars: 200,
  bodyChars: 4000,
  logChars: 2000,
  pingEveryMs: 30_000,
  pongWithinMs: 10_000,
};

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const BLOCKED_HEADERS = /^(host|cookie|origin|referer|connection|content-length|transfer-encoding|proxy-.*|sec-.*)$/i;

class RateWindow {
  private times: number[] = [];
  private max: number;
  private ms: number;
  constructor(max: number, ms: number) { this.max = max; this.ms = ms; }
  take(now = Date.now()) {
    this.times = this.times.filter((t) => now - t < this.ms);
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
}

export class PluginHost {
  private sends = new RateWindow(LIMITS.sendsPerHour, 3_600_000);
  private notifies = new RateWindow(LIMITS.notifiesPerHour, 3_600_000);
  private fetches = new RateWindow(LIMITS.fetchesPerMinute, 60_000);
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private lastPong = Date.now();
  stopped = false;
  readonly manifest: PluginManifest;
  private sandbox: Sandbox;
  private caps: HostCaps;
  private onCrash: (reason: string) => void;

  constructor(manifest: PluginManifest, sandbox: Sandbox, caps: HostCaps, onCrash: (reason: string) => void = () => {}) {
    this.manifest = manifest;
    this.sandbox = sandbox;
    this.caps = caps;
    this.onCrash = onCrash;
    sandbox.onMessage((m) => void this.handle(m));
  }

  has(p: string) { return this.manifest.permissions.includes(p); }

  /** Starts the "is it stuck?" check. A plugin that hangs its thread is stopped. */
  watch() {
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastPong > LIMITS.pingEveryMs + LIMITS.pongWithinMs) { this.stop(); this.onCrash('stopped responding'); return; }
      this.sandbox.post({ t: 'ping' });
    }, LIMITS.pingEveryMs);
  }

  /** Gives the plugin an incoming note or link, if it asked for "receive". */
  deliver(push: { kind: 'note' | 'link'; title?: string; body?: string; url?: string; from: string }) {
    if (!this.stopped && this.has('receive')) this.sandbox.post({ t: 'push', push });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.watchdog);
    try { this.sandbox.post({ t: 'stop' }); } catch { /* ignore */ }
    // Give stop handlers a moment, then kill the thread.
    setTimeout(() => this.sandbox.terminate(), 500);
  }

  private async handle(m: FromPlugin) {
    if (this.stopped || !m || typeof m !== 'object') return;
    if (m.t === 'pong') { this.lastPong = Date.now(); return; }
    if (m.t === 'log') { this.caps.log(m.level === 'error' ? 'error' : 'info', String(m.text).slice(0, LIMITS.logChars)); return; }
    if (m.t !== 'call' || typeof m.rid !== 'number') return;
    const reply = (ok: boolean, value?: unknown, error?: string) => { if (!this.stopped) this.sandbox.post({ t: 'reply', rid: m.rid, ok, value, error }); };
    try {
      reply(true, await this.run(m.method, Array.isArray(m.args) ? m.args : []));
    } catch (e) {
      reply(false, undefined, e instanceof Error ? e.message : String(e));
    }
  }

  private need(p: string) { if (!this.has(p)) throw new Error(`this plugin did not ask for the "${p}" permission`); }

  private async run(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'send': {
        this.need('send');
        const p = (args[0] ?? {}) as Record<string, unknown>;
        const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);
        const title = text(p.title, LIMITS.titleChars), body = text(p.body, LIMITS.bodyChars), url = text(p.url, 2000);
        if (url && !/^https?:\/\/\S+$/i.test(url)) throw new Error('url must be an http(s) link');
        if (!url && !body) throw new Error('send needs a body or a url');
        if (!this.sends.take()) throw new Error(`limit reached: ${LIMITS.sendsPerHour} pushes an hour`);
        await this.caps.send(url ? { kind: 'link', url, title, body } : { kind: 'note', body: body!, title });
        return true;
      }
      case 'notify': {
        this.need('notify');
        if (!this.notifies.take()) throw new Error(`limit reached: ${LIMITS.notifiesPerHour} notifications an hour`);
        await this.caps.notify(String(args[0] ?? '').slice(0, LIMITS.titleChars) || this.manifest.name, String(args[1] ?? '').slice(0, LIMITS.bodyChars));
        return true;
      }
      case 'fetch': {
        const url = String(args[0] ?? '');
        if (!hostAllowed(this.manifest.permissions, url)) throw new Error(`this plugin did not ask to connect to ${safeHost(url)}`);
        const o = (args[1] ?? {}) as Record<string, unknown>;
        const method = String(o.method ?? 'GET').toUpperCase();
        if (!METHODS.includes(method)) throw new Error(`method not allowed: ${method}`);
        const headers: Record<string, string> = {};
        if (o.headers && typeof o.headers === 'object') {
          for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) {
            if (typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(k) && !BLOCKED_HEADERS.test(k)) headers[k] = v.slice(0, 4000);
          }
        }
        const body = typeof o.body === 'string' ? o.body.slice(0, 256 * 1024) : undefined;
        if (!this.fetches.take()) throw new Error(`limit reached: ${LIMITS.fetchesPerMinute} requests a minute`);
        return await this.caps.fetch(url, { method, headers, body });
      }
      case 'storage': {
        const data = args[0];
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('storage must be an object');
        if (JSON.stringify(data).length > LIMITS.storageBytes) throw new Error('storage is full (256 KB)');
        this.caps.saveStorage(data as Record<string, unknown>);
        return true;
      }
      default:
        throw new Error(`unknown call: ${method}`);
    }
  }
}

function safeHost(url: string) { try { return new URL(url).host || 'that address'; } catch { return 'that address'; } }
