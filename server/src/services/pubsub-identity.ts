import { constants } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import path from "node:path";
import { pubsubIdSchema, type PubsubIdentity } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export interface PubsubSigningIdentity extends PubsubIdentity { privateKey: KeyObject }

async function persistPublicIdentity(identityPath: string, identity: PubsubIdentity) {
  const parsed = path.parse(identityPath);
  const publicPath = path.join(parsed.dir, `${parsed.name}-public.json`);
  const temporary = `${publicPath}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  let installed = false;
  try {
    try {
      // Deliberately enumerate public fields: never serialize the signing identity.
      await file.writeFile(JSON.stringify({
        version: 1,
        instanceId: identity.instanceId,
        publicKey: identity.publicKey,
      }));
      await file.chmod(0o644);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, publicPath);
    installed = true;
    const directory = await open(parsed.dir || ".", constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (!installed) await unlink(temporary);
  }
}

export async function loadPubsubIdentity(identityPath = path.join(resolvePaperclipInstanceRoot(), "data", "pubsub", "identity.json")): Promise<PubsubSigningIdentity> {
  async function readExisting(): Promise<PubsubSigningIdentity> {
    const file = await open(identityPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o777) !== 0o600) {
        throw new Error("PubSub identity must be a regular mode-0600 file smaller than 16 KiB");
      }
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1
        || !("instanceId" in value) || !("privateKey" in value) || typeof value.privateKey !== "string") {
        throw new Error("Invalid persisted PubSub identity");
      }
      const instanceId = pubsubIdSchema.parse(value.instanceId);
      const privateKey = createPrivateKey(value.privateKey);
      if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("PubSub identity key must be Ed25519");
      const identity = { instanceId, privateKey, publicKey: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString() };
      await persistPublicIdentity(identityPath, identity);
      return identity;
    } finally { await file.close(); }
  }
  try { return await readExisting(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(identityPath), { recursive: true, mode: 0o700 });
  const temporary = `${identityPath}.${randomUUID()}.tmp`;
  const { privateKey } = generateKeyPairSync("ed25519");
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(JSON.stringify({
      version: 1,
      instanceId: randomUUID(),
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }));
    await file.sync();
  } finally { await file.close(); }
  try {
    // Atomic, non-overwriting installation: concurrent starters all adopt the winning complete file.
    try { await link(temporary, identityPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const directory = await open(path.dirname(identityPath), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary); }
  return readExisting();
}

/** Explicit onboarding entry point. Private material never leaves this module's public API. */
export async function ensurePubsubIdentity(identityPath?: string): Promise<PubsubIdentity> {
  const { instanceId, publicKey } = await loadPubsubIdentity(identityPath);
  return { instanceId, publicKey };
}
