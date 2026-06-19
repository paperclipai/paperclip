import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../../config/home.js";

export interface CloudConnectionTokenRecord {
  id: string;
  companyStackId: string;
  targetOrigin: string;
  sourceInstanceId: string;
  sourceInstanceFingerprint: string;
  scopes: string[];
  expiresAt: string;
  [key: string]: unknown;
}

export interface CloudConnection {
  id: string;
  remoteUrl: string;
  targetOrigin: string;
  targetHost: string;
  stackId: string;
  stackSlug?: string | null;
  stackDisplayName?: string | null;
  targetCompanyId: string;
  accessToken: string;
  token: CloudConnectionTokenRecord;
  privateKeyPem: string;
  sourcePublicKey: string;
  sourceInstanceId: string;
  sourceInstanceFingerprint: string;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

interface CloudConnectionStore {
  version: 1;
  connections: Record<string, CloudConnection>;
  currentConnectionId?: string;
}

function defaultStore(): CloudConnectionStore {
  return {
    version: 1,
    connections: {},
  };
}

export function resolveCloudConnectionStorePath(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "secrets", "cloud-upstream-connections.json");
}

export function readCloudConnectionStore(storePath = resolveCloudConnectionStorePath()): CloudConnectionStore {
  if (!fs.existsSync(storePath)) return defaultStore();
  const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<CloudConnectionStore> | null;
  const connections: Record<string, CloudConnection> = {};
  if (raw?.connections && typeof raw.connections === "object") {
    for (const [id, value] of Object.entries(raw.connections)) {
      const normalized = normalizeConnection(value);
      if (normalized) connections[id] = normalized;
    }
  }
  const currentConnectionId =
    typeof raw?.currentConnectionId === "string" && connections[raw.currentConnectionId]
      ? raw.currentConnectionId
      : Object.values(connections).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id;
  return {
    version: 1,
    connections,
    currentConnectionId,
  };
}

export function writeCloudConnectionStore(
  store: CloudConnectionStore,
  storePath = resolveCloudConnectionStorePath(),
): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export function upsertCloudConnection(
  connection: CloudConnection,
  storePath = resolveCloudConnectionStorePath(),
): CloudConnection {
  const store = readCloudConnectionStore(storePath);
  const existing = store.connections[connection.id];
  const now = new Date().toISOString();
  const next = {
    ...connection,
    createdAt: existing?.createdAt ?? connection.createdAt ?? now,
    updatedAt: now,
  };
  store.connections[next.id] = next;
  store.currentConnectionId = next.id;
  writeCloudConnectionStore(store, storePath);
  return next;
}

export function getCloudConnection(
  remoteUrlOrOrigin?: string,
  storePath = resolveCloudConnectionStorePath(),
): CloudConnection | null {
  const store = readCloudConnectionStore(storePath);
  if (remoteUrlOrOrigin?.trim()) {
    const needle = normalizeRemoteLookup(remoteUrlOrOrigin);
    return Object.values(store.connections).find((connection) =>
      normalizeRemoteLookup(connection.remoteUrl) === needle ||
      normalizeRemoteLookup(connection.targetOrigin) === needle
    ) ?? null;
  }
  return store.currentConnectionId ? store.connections[store.currentConnectionId] ?? null : null;
}

function normalizeRemoteLookup(value: string): string {
  try {
    const url = new URL(value);
    return url.origin.replace(/\/+$/u, "");
  } catch {
    return value.trim().replace(/\/+$/u, "");
  }
}

function normalizeConnection(value: unknown): CloudConnection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = stringValue(record.id);
  const remoteUrl = stringValue(record.remoteUrl);
  const targetOrigin = stringValue(record.targetOrigin);
  const targetHost = stringValue(record.targetHost);
  const stackId = stringValue(record.stackId);
  const targetCompanyId = stringValue(record.targetCompanyId);
  const accessToken = stringValue(record.accessToken);
  const token = typeof record.token === "object" && record.token !== null && !Array.isArray(record.token)
    ? record.token as CloudConnectionTokenRecord
    : null;
  const privateKeyPem = stringValue(record.privateKeyPem);
  const sourcePublicKey = stringValue(record.sourcePublicKey);
  const sourceInstanceId = stringValue(record.sourceInstanceId);
  const sourceInstanceFingerprint = stringValue(record.sourceInstanceFingerprint);
  const createdAt = stringValue(record.createdAt);
  const updatedAt = stringValue(record.updatedAt);
  if (
    !id || !remoteUrl || !targetOrigin || !targetHost || !stackId || !targetCompanyId ||
    !accessToken || !token || !privateKeyPem || !sourcePublicKey || !sourceInstanceId ||
    !sourceInstanceFingerprint || !createdAt || !updatedAt
  ) {
    return null;
  }
  return {
    id,
    remoteUrl,
    targetOrigin,
    targetHost,
    stackId,
    stackSlug: stringValue(record.stackSlug),
    stackDisplayName: stringValue(record.stackDisplayName),
    targetCompanyId,
    accessToken,
    token,
    privateKeyPem,
    sourcePublicKey,
    sourceInstanceId,
    sourceInstanceFingerprint,
    scopes: stringArray(record.scopes),
    createdAt,
    updatedAt,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
