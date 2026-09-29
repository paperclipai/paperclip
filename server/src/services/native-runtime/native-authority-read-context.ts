import { AsyncLocalStorage } from "node:async_hooks";
import { dirname } from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { authorityJson, parseAuthorityLocator, readIndexedLocalState, assertNoPendingLegacyMigration } from "../../vendor/paperclip-runner/index.js";
import { readPostgresAuthority } from "./postgres-authority-store.js";

const context = new AsyncLocalStorage<Db>();
/** Scope follows the owning recovery operation, never a global database singleton. */
export function withNativeAuthorityReadContext<T>(db: Db, operation: () => Promise<T>): Promise<T> {
  return context.run(db, operation);
}

export async function readIndexedAuthorityProof(path: string) {
  assertNoPendingLegacyMigration(dirname(path));
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let locator;
  let value: unknown;
  let unsafe = false;
  try {
    const stat = await fd.stat();
    if (!stat.isFile()) throw new Error("native_state_file_unsafe");
    unsafe = process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.());
    if (stat.size > 8192) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) throw new Error("native_state_file_changed"); offset += bytesRead; }
    const after = await fd.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("native_state_file_changed");
    try { value = JSON.parse(buffer.toString("utf8")); } catch { return null; }
    locator = parseAuthorityLocator(value);
  } finally { await fd.close(); }
  const schema = (value as { schema?: string } | null)?.schema;
  if (unsafe && (locator || schema?.includes(".indexed.v1"))) throw new Error("native_indexed_state_file_unsafe");
  let snapshot;
  if (schema === "paperclip.runner.durable.state.indexed.v1" || schema === "paperclip.runner.codex-provider-state.indexed.v1") {
    snapshot = await readIndexedLocalState(path);
  } else {
  if (!locator) return null;
  const db = context.getStore();
  if (!db || locator.location.kind !== "postgres") throw new Error("native_indexed_authority_unavailable");
  snapshot = await readPostgresAuthority(db, locator.location);
  }
  // Include generation in proof hashes: the locator itself is never evidence.
  const proof = { ...snapshot.state, indexedGeneration: snapshot.generation };
  const bytes = Buffer.from(authorityJson(proof));
  return { value: proof, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, retainedBudgetBytes: bytes.length };
}
