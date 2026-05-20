import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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

interface EncryptedCloudCredential {
  scheme: "local_encrypted_v1";
  iv: string;
  tag: string;
  ciphertext: string;
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
  fs.writeFileSync(storePath, `${JSON.stringify(serializeStore(store), null, 2)}\n`, { mode: 0o600 });
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
  const accessToken = readCredential(record, "accessToken", "accessTokenMaterial");
  const token = typeof record.token === "object" && record.token !== null && !Array.isArray(record.token)
    ? record.token as CloudConnectionTokenRecord
    : null;
  const privateKeyPem = readCredential(record, "privateKeyPem", "privateKeyMaterial");
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

function readCredential(record: Record<string, unknown>, plaintextKey: string, materialKey: string): string | null {
  const material = record[materialKey];
  if (material && typeof material === "object" && !Array.isArray(material)) {
    try {
      return decryptCredential(material as Record<string, unknown>);
    } catch {
      return null;
    }
  }
  return stringValue(record[plaintextKey]);
}

function serializeStore(store: CloudConnectionStore): Record<string, unknown> {
  const connections: Record<string, unknown> = {};
  for (const [id, connection] of Object.entries(store.connections)) {
    connections[id] = serializeConnection(connection);
  }
  return {
    version: 1,
    connections,
    ...(store.currentConnectionId ? { currentConnectionId: store.currentConnectionId } : {}),
  };
}

function serializeConnection(connection: CloudConnection): Record<string, unknown> {
  const { accessToken, privateKeyPem, ...rest } = connection;
  return {
    ...rest,
    accessTokenMaterial: encryptCredential(accessToken),
    privateKeyMaterial: encryptCredential(privateKeyPem),
  };
}

function encryptCredential(value: string): EncryptedCloudCredential {
  const iv = randomBytes(12);
  const key = loadOrCreateCredentialKey();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    scheme: "local_encrypted_v1",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptCredential(material: Record<string, unknown>): string {
  if (
    material.scheme !== "local_encrypted_v1" ||
    typeof material.iv !== "string" ||
    typeof material.tag !== "string" ||
    typeof material.ciphertext !== "string"
  ) {
    throw new Error("Invalid encrypted cloud credential material");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    loadOrCreateCredentialKey(),
    Buffer.from(material.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(material.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(material.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

function loadOrCreateCredentialKey(): Buffer {
  const envKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (envKey?.trim()) {
    const decoded = decodeCredentialKey(envKey);
    if (!decoded) throw new Error("Invalid PAPERCLIP_SECRETS_MASTER_KEY");
    return decoded;
  }

  const keyPath = path.resolve(
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE?.trim() ||
      path.join(resolvePaperclipInstanceRoot(), "secrets", "master.key"),
  );
  if (fs.existsSync(keyPath)) {
    const decoded = decodeCredentialKey(fs.readFileSync(keyPath, "utf8"));
    if (!decoded) throw new Error(`Invalid secrets master key at ${keyPath}`);
    return decoded;
  }

  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const generated = randomBytes(32);
  fs.writeFileSync(keyPath, generated.toString("base64"), { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // Best effort; the credential store itself is also written 0600.
  }
  return generated;
}

function decodeCredentialKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // ignored
  }
  if (Buffer.byteLength(trimmed, "utf8") === 32) {
    return Buffer.from(trimmed, "utf8");
  }
  return null;
}
