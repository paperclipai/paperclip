import { constants, lstatSync, readSync, openSync, fstatSync, closeSync } from "node:fs";
import { basename, resolve } from "node:path";
import { SqliteAuthorityStore } from "./sqlite-authority-store.js";
import { assertNoPendingLegacyMigration } from "./legacy-migration-gate.js";
import { DurableAuthorityStoreError, MAX_LEGACY_AUTHORITY_STATE_BYTES, type AuthoritySnapshot } from "./durable-authority-store.js";
import { materializeCurrentAuthority } from "./current-authority-evidence.js";
import { authorityJson } from "./durable-authority-store.js";
import { createHash } from "node:crypto";

export interface AuthorityLocation {
  kind: "sqlite" | "postgres";
  binding: string;
  file?: string;
  epoch?: string;
}
export interface AuthorityLocator {
  schema: "paperclip.runner.authority-locator.v1";
  location: AuthorityLocation;
}
export type ExternalAuthorityReader = (location: AuthorityLocation) => Promise<AuthoritySnapshot>;

export function parseAuthorityLocator(value: unknown): AuthorityLocator | null {
  const record = value as Partial<AuthorityLocator> | null;
  if (!record || record.schema !== "paperclip.runner.authority-locator.v1") return null;
  const location = record.location;
  if (!location || !["sqlite", "postgres"].includes(location.kind) || typeof location.binding !== "string" || location.binding.length > 4096 ||
    (location.kind === "sqlite" && (typeof location.file !== "string" || location.file !== basename(location.file) || !/^[a-zA-Z0-9_.-]+\.sqlite$/.test(location.file))) ||
    (location.kind === "postgres" && (typeof location.epoch !== "string" || !/^[a-zA-Z0-9_.:-]{1,240}$/.test(location.epoch)))) {
    throw new DurableAuthorityStoreError("invalid_authority", "invalid authority locator");
  }
  return record as AuthorityLocator;
}

/** Legacy files are bounded compatibility input; indexed locators load one row. */
export async function readDurableControlPlaneState(directory: string, readExternal?: ExternalAuthorityReader): Promise<Record<string, unknown>> {
  return (await readDurableControlPlaneSnapshot(directory, readExternal)).state;
}

/** The materialized view and its stored digest are different representations.
 * Archive fences compare the latter, after checking the former still matches
 * the authority the caller admitted. External stores own their own fences. */
export async function readDurableControlPlaneSnapshot(directory: string, readExternal?: ExternalAuthorityReader): Promise<{
  state: Record<string, unknown>; storedSha256: string | null;
}> {
  assertNoPendingLegacyMigration(directory);
  const path = resolve(directory, "control-plane-state.json");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let value: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_LEGACY_AUTHORITY_STATE_BYTES) throw new Error("native_runner_control_plane_state_unsafe");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("native_runner_control_plane_state_changed");
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("native_runner_control_plane_state_changed");
    value = JSON.parse(bytes.toString("utf8"));
    if (parseAuthorityLocator(value) && process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw new Error("native_runner_control_plane_state_unsafe");
  } finally { closeSync(fd); }
  const locator = parseAuthorityLocator(value);
  if (!locator) return { state: value as Record<string, unknown>, storedSha256: null };
  if (locator.location.kind === "postgres") {
    if (!readExternal) throw new DurableAuthorityStoreError("storage_unavailable", "Postgres authority reader is required");
    return { state: (await readExternal(locator.location)).state, storedSha256: null };
  }
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("native_runner_control_plane_state_unsafe");
  const store = await SqliteAuthorityStore.open({ binding: locator.location.binding, path: resolve(directory, locator.location.file!), create: false, readOnly: true });
  try {
    const snapshot = await store.load();
    if (!snapshot) throw new DurableAuthorityStoreError("storage_unavailable", "activated authority snapshot is missing");
    const state = await materializeCurrentAuthority(snapshot.state, store.getRecord.bind(store));
    if ((await store.load())?.generation !== snapshot.generation) throw new DurableAuthorityStoreError("stale_authority", "authority changed while resolving current evidence");
    return { state, storedSha256: createHash("sha256").update(authorityJson(snapshot.state)).digest("hex") };
  } finally { await store.close(); }
}
