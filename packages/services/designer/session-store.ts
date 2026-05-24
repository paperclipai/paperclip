import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface HistoryEntry {
  kind: string;
  at?: string;
  [k: string]: unknown;
}

export interface StoredSession {
  key: string;
  createdAt: string;
  updatedAt?: string;
  history: HistoryEntry[];
  designUrl?: string;
  name?: string;
  fidelity?: 'wireframe' | 'highfi';
  lastUrl?: string | null;
  [k: string]: unknown;
}

export type SessionPatch = Partial<Omit<StoredSession, 'key' | 'createdAt' | 'history'>> & {
  history?: HistoryEntry[];
};

const ROOT = process.env.DESIGNER_STATE_DIR || path.join(os.homedir(), '.designer');
const SESSIONS_FILE = path.join(ROOT, 'sessions.json');

function ensureRoot(): void {
  fs.mkdirSync(ROOT, { recursive: true });
}

function readAll(): Record<string, StoredSession> {
  ensureRoot();
  if (!fs.existsSync(SESSIONS_FILE)) return {};
  try {
    return (JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as Record<string, StoredSession>) || {};
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, StoredSession>): void {
  ensureRoot();
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

export function getSession(key: string): StoredSession | null {
  return readAll()[key] || null;
}

export function upsertSession(key: string, patch: SessionPatch): StoredSession {
  const all = readAll();
  const prev: StoredSession = all[key] || { key, createdAt: new Date().toISOString(), history: [] };
  const next: StoredSession = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  all[key] = next;
  writeAll(all);
  return next;
}

export function listSessions(): StoredSession[] {
  return Object.values(readAll());
}

export function appendHistory(key: string, entry: Omit<HistoryEntry, 'at'>): StoredSession {
  const all = readAll();
  const prev: StoredSession = all[key] || { key, createdAt: new Date().toISOString(), history: [] };
  prev.history = [...(prev.history || []), { ...entry, at: new Date().toISOString() } as HistoryEntry];
  prev.updatedAt = new Date().toISOString();
  all[key] = prev;
  writeAll(all);
  return prev;
}

export function stateDir(): string {
  return ROOT;
}
