// Synced from the Ferry app repo by tools/sync-harbor.ts. Do not edit here.
// Ferry plugins: manifest and bundle checks shared by the desktop host, the author tool and the registry.
// The sandbox runtime (what runs inside a plugin's worker) lives in plugin-runtime.ts.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const PLUGIN_API = 1;
export const MAX_CODE_BYTES = 256 * 1024;

export type SettingType = 'text' | 'password' | 'number' | 'toggle';
export interface PluginSetting { key: string; label: string; type: SettingType; default?: string | number | boolean; required?: boolean; help?: string }

/** ferry-plugin.json */
export interface PluginManifest {
  api: number;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  license?: string;
  /** "send", "receive", "notify", "net:example.com", "net:*.example.com", "net:*" (any public site) */
  permissions: string[];
  settings?: PluginSetting[];
}

/** What gets installed: the manifest plus the plugin's single JS file. */
export interface PluginBundle { manifest: PluginManifest; code: string }

/** One entry in a registry's index.json. */
export interface IndexEntry {
  id: string; name: string; version: string; description: string; author: string;
  homepage?: string; permissions: string[];
  /** Bundle URL, relative to index.json or absolute. */
  bundle: string;
  /** sha256 (hex) of the bundle file's exact bytes. */
  sha256: string;
}
export interface RegistryIndex { v: 1; plugins: IndexEntry[] }

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const VER_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SIMPLE_PERMS = ['send', 'receive', 'notify'];

export function permissionValid(p: string) {
  return SIMPLE_PERMS.includes(p) || p === 'net:*' || (p.startsWith('net:') && HOST_RE.test(p.slice(4)));
}

const str = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Returns a list of problems; empty means the manifest is valid. */
export function manifestProblems(m: any): string[] {
  const p: string[] = [];
  if (!m || typeof m !== 'object') return ['manifest must be a JSON object'];
  if (m.api !== PLUGIN_API) p.push(`api must be ${PLUGIN_API}`);
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) p.push('id must be 2-40 chars: lowercase letters, digits, dashes');
  if (!str(m.name, 40)) p.push('name is required (max 40 chars)');
  if (typeof m.version !== 'string' || !VER_RE.test(m.version)) p.push('version must look like 1.2.3');
  if (!str(m.description, 200)) p.push('description is required (max 200 chars)');
  if (!str(m.author, 80)) p.push('author is required (max 80 chars)');
  if (m.homepage !== undefined && !(typeof m.homepage === 'string' && /^https:\/\/\S+$/.test(m.homepage))) p.push('homepage must be an https URL');
  if (!Array.isArray(m.permissions)) p.push('permissions must be a list');
  else {
    for (const x of m.permissions) if (typeof x !== 'string' || !permissionValid(x)) p.push(`unknown permission: ${JSON.stringify(x)}`);
    if (new Set(m.permissions).size !== m.permissions.length) p.push('permissions has duplicates');
    if (m.permissions.length > 20) p.push('at most 20 permissions');
  }
  if (m.settings !== undefined) {
    if (!Array.isArray(m.settings) || m.settings.length > 20) p.push('settings must be a list of at most 20');
    else {
      const keys = new Set<string>();
      for (const s of m.settings) {
        if (!s || typeof s.key !== 'string' || !KEY_RE.test(s.key)) { p.push(`bad setting key: ${JSON.stringify(s?.key)}`); continue; }
        if (keys.has(s.key)) p.push(`duplicate setting: ${s.key}`);
        keys.add(s.key);
        if (!str(s.label, 80)) p.push(`setting ${s.key}: label is required`);
        if (!['text', 'password', 'number', 'toggle'].includes(s.type)) p.push(`setting ${s.key}: type must be text, password, number or toggle`);
      }
    }
  }
  return p;
}

export function bundleProblems(b: any): string[] {
  if (!b || typeof b !== 'object') return ['bundle must be a JSON object'];
  const p = manifestProblems(b.manifest);
  if (typeof b.code !== 'string' || !b.code.trim()) p.push('code is missing');
  else if (utf8ToBytes(b.code).length > MAX_CODE_BYTES) p.push(`code is over ${MAX_CODE_BYTES / 1024} KB`);
  return p;
}

export const sha256Hex = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));

/**
 * Checks a downloaded bundle against its index entry: the hash must match the exact bytes,
 * and id, version and permissions must be what the index (and the reviewer) saw.
 */
export function verifyBundle(text: string, entry: IndexEntry): PluginBundle {
  if (sha256Hex(text) !== entry.sha256.toLowerCase()) throw new Error('download does not match the registry hash');
  const b = JSON.parse(text);
  const problems = bundleProblems(b);
  if (problems.length) throw new Error(problems[0]);
  const m = b.manifest as PluginManifest;
  if (m.id !== entry.id || m.version !== entry.version) throw new Error('bundle id or version does not match the registry');
  if ([...m.permissions].sort().join() !== [...entry.permissions].sort().join()) throw new Error('bundle permissions do not match the registry');
  return b;
}

export function indexProblems(ix: any): string[] {
  if (!ix || ix.v !== 1 || !Array.isArray(ix.plugins)) return ['index must be {"v":1,"plugins":[...]}'];
  const p: string[] = [];
  const ids = new Set<string>();
  for (const e of ix.plugins) {
    if (!e || typeof e.id !== 'string' || !ID_RE.test(e.id)) { p.push(`bad id: ${JSON.stringify(e?.id)}`); continue; }
    if (ids.has(e.id)) p.push(`duplicate id: ${e.id}`);
    ids.add(e.id);
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(e.sha256)) p.push(`${e.id}: bad sha256`);
    if (typeof e.bundle !== 'string' || !e.bundle) p.push(`${e.id}: bundle is missing`);
    if (!Array.isArray(e.permissions) || !e.permissions.every((x: unknown) => typeof x === 'string' && permissionValid(x))) p.push(`${e.id}: bad permissions`);
  }
  return p;
}

/** True if the plugin declared net access to this URL's host (http or https only). */
export function hostAllowed(permissions: string[], url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return permissions.some((p) => {
    if (!p.startsWith('net:')) return false;
    const h = p.slice(4).toLowerCase();
    if (h === '*') return true;
    return h.startsWith('*.') ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h;
  });
}

/** Plain-language description of each permission, shown before install. */
export function describePermission(p: string): string {
  if (p === 'send') return 'Send notes and links to all your devices';
  if (p === 'receive') return 'Read the notes and links that arrive on this computer';
  if (p === 'notify') return 'Show notifications on this computer';
  if (p === 'net:*') return 'Connect to any public website';
  if (p.startsWith('net:')) return p.slice(4).startsWith('*.') ? `Connect to ${p.slice(6)} and its subdomains` : `Connect to ${p.slice(4)}`;
  return p;
}

/** Semver-ish compare of "1.2.3" strings. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
