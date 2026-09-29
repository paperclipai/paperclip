import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { authorityDirectlyFollows, authorityJson, type DurableAuthorityStore } from "./durable-authority-store.js";
import { legacyControllerActivation, stageLegacyControlPlaneAuthority, type StoredCoreState } from "./durable-prp-control-plane.js";
import { readIndexedLocalState } from "./indexed-local-state-reader.js";
import type { DurableRecoveryIdentity } from "./prp-transport-types.js";

export interface PreparedLocalAuthority {
  schema: "paperclip.runner.prepared-legacy-authority.v1";
  binding: string;
  fenceId: string;
  sourceDigest: string;
  currentDigest: string;
  currentKey: "runner" | "codex-provider";
  generation: 1;
  receipts: number;
}
export interface PreparedLocalSession { runner: PreparedLocalAuthority; provider: PreparedLocalAuthority }
type SourceIdentity = { dev: string; ino: string; size: string; mtime: string; ctime: string };
type Preparation = PreparedLocalSession & { controllerGeneration: string; controllerDigest: string; files: string[]; sources: Record<string, SourceIdentity> };
interface Marker {
  schema: "paperclip.runner.legacy-activation.v1";
  identity: DurableRecoveryIdentity;
  fenceId: string;
  phase: "copying" | "activating" | "active";
  preparation: Preparation | null;
  preparationDigest: string | null;
}
export interface LegacySessionMigrationOptions {
  root: string;
  identity: DurableRecoveryIdentity;
  authority: DurableAuthorityStore;
  fenceId: string;
  /** Use the same qualified native artifact for staging and current reads. */
  runnerBinary?: string;
  /** Must prove exclusive controller ownership AND every old runner/provider
   * writer stopped. An expired lease or a missing PID alone is insufficient. */
  assertExclusiveFence(): Promise<void>;
  /** Run the qualified runnerd `storage stage-legacy` command with the exact
   * source invocation. It writes only this private destination. */
  prepareLocal(destination: string): Promise<PreparedLocalSession>;
  onBoundary?(name: string): Promise<void>;
}
const digest = (value: unknown) => createHash("sha256").update(authorityJson(value)).digest("hex");
const prefixes = ["runner-state", "codex-provider-state"];
const dataFiles = prefixes.flatMap(prefix => [".sqlite", ".sqlite-wal", ".sqlite-shm", ".sqlite.receipts", ".sqlite.routing", ".sqlite.lifetime", ".sqlite.lock"].map(suffix => prefix + suffix));
const locators = prefixes.map(prefix => `${prefix}.json`);
const isStoreDirectory = (file: string) => file.endsWith(".receipts") || file.endsWith(".routing");

async function stat(path: string) { try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
async function privatePath(path: string, directory = false): Promise<void> {
  const value = await lstat(path);
  if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile()) ||
      (process.platform !== "win32" && ((value.mode & 0o077) !== 0 || value.uid !== process.getuid?.()))) throw new Error("native_legacy_migration_unsafe");
}
async function sourceIdentity(path: string): Promise<SourceIdentity> {
  await privatePath(path);
  const value = await lstat(path, { bigint: true });
  return { dev: String(value.dev), ino: String(value.ino), size: String(value.size), mtime: String(value.mtimeNs), ctime: String(value.ctimeNs) };
}
function sameSource(a: SourceIdentity, b: SourceIdentity, linked = false) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime === b.mtime && (linked || a.ctime === b.ctime);
}
async function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
async function publish(path: string, value: unknown) {
  if (await stat(path)) await privatePath(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}
async function readMarker(path: string): Promise<Marker | null> {
  if (!await stat(path)) return null;
  await privatePath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (before.size > 16 * 1024) throw new Error("native_legacy_migration_marker_oversized");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) throw new Error("native_legacy_migration_changed"); offset += bytesRead; }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("native_legacy_migration_changed");
    return JSON.parse(bytes.toString()) as Marker;
  } finally { await file.close(); }
}
function validateLocal(proof: PreparedLocalAuthority, kind: "runner" | "codex-provider", identity: DurableRecoveryIdentity, fenceId: string) {
  const binding = `${kind === "runner" ? "runner" : "provider"}/${identity.runnerInstanceId}/${identity.normalizedSessionId}`;
  if (proof.schema !== "paperclip.runner.prepared-legacy-authority.v1" || proof.binding !== binding || proof.fenceId !== fenceId || proof.currentKey !== kind || proof.generation !== 1 ||
      !Number.isSafeInteger(proof.receipts) || proof.receipts < 0 || !/^[a-f0-9]{64}$/.test(proof.sourceDigest) || !/^[a-f0-9]{64}$/.test(proof.currentDigest)) throw new Error("native_legacy_preparation_invalid");
}
async function verifyLocal(directory: string, prepared: PreparedLocalSession, identity: DurableRecoveryIdentity, fenceId: string, runnerBinary?: string) {
  for (const [name, proof] of [["runner-state", prepared.runner], ["codex-provider-state", prepared.provider]] as const) {
    validateLocal(proof, name === "runner-state" ? "runner" : "codex-provider", identity, fenceId);
    const snapshot = await readIndexedLocalState(resolve(directory, `${name}.json`), { runnerBinary });
    if (snapshot.generation !== "1" || snapshot.stateDigest !== proof.currentDigest || authorityJson(snapshot.preparation) !== authorityJson(proof)) throw new Error("native_legacy_preparation_changed");
    if (name === "runner-state" && Object.entries(identity).some(([key, value]) => snapshot.state[key] !== value)) throw new Error("native_legacy_runner_binding_changed");
  }
}

/** Roll forward a three-store migration. The durable intent gates BOTH formats
 * until the exact controller commit and all local stores have been published.
 * Originals remain private and inspectable; no rollback guesses from history. */
export async function migrateLegacySessionAuthority(options: LegacySessionMigrationOptions): Promise<void> {
  const { identity, fenceId, authority } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(fenceId)) throw new Error("native_legacy_migration_fence_invalid");
  const root = resolve(options.root), controller = resolve(root, "control-plane"), runner = resolve(root, "runner");
  const staging = resolve(root, "indexed-migration"), local = resolve(staging, "runner"), originals = resolve(staging, "legacy");
  const markerPath = resolve(root, "indexed-migration.json"), sourcePath = resolve(controller, "control-plane-state.json");
  await options.assertExclusiveFence();
  for (const path of [root, controller, runner]) await privatePath(path, true);
  let marker = await readMarker(markerPath);
  if (marker && (marker.schema !== "paperclip.runner.legacy-activation.v1" || marker.fenceId !== fenceId || authorityJson(marker.identity) !== authorityJson(identity)
      || !["copying", "activating", "active"].includes(marker.phase))) throw new Error("native_legacy_migration_conflict");
  if (!marker) {
    marker = { schema: "paperclip.runner.legacy-activation.v1", identity, fenceId, phase: "copying", preparation: null, preparationDigest: null };
    await publish(markerPath, marker);
    await options.onBoundary?.("intent");
  }
  // Completed execution may have advanced since migration. Never rewrite it.
  if (marker.phase === "active") return;
  for (const path of [staging, originals]) {
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await privatePath(path, true); await syncDirectory(dirname(path));
  }
  if (marker.phase === "copying") {
    const sources: Record<string, SourceIdentity> = {};
    for (const name of ["control-plane-state.json", ...locators]) sources[name] = await sourceIdentity(name === "control-plane-state.json" ? sourcePath : resolve(runner, name));
    const prepared = await stageLegacyControlPlaneAuthority({ sourcePath, identity, authority, fenceId, assertExclusiveFence: options.assertExclusiveFence });
    const peers = await options.prepareLocal(local);
    await verifyLocal(local, peers, identity, fenceId, options.runnerBinary);
    const runnerState = (await readIndexedLocalState(resolve(local, "runner-state.json"), { runnerBinary: options.runnerBinary })).state;
    const projection = prepared.state.projection as unknown as StoredCoreState;
    if (projection.warmTransition || Number(runnerState.ackedSourceSeq) > projection.ackedSourceSeq || Number(runnerState.nextSourceSeq) <= projection.ackedSourceSeq ||
        Number(runnerState.lastControllerCommandSeq) >= projection.indexedState!.nextControllerSeq) throw new Error("native_legacy_peer_cursors_conflict");
    await options.assertExclusiveFence();
    // Preparation of local peers can take time. Revalidate the original
    // controller identity after it, without scanning its copied prefix again.
    await stageLegacyControlPlaneAuthority({ sourcePath, identity, authority, fenceId, assertExclusiveFence: options.assertExclusiveFence });
    for (const name of Object.keys(sources)) if (!sameSource(sources[name]!, await sourceIdentity(name === "control-plane-state.json" ? sourcePath : resolve(runner, name)))) throw new Error("native_legacy_source_changed");
    const files: string[] = [];
    for (const file of [...dataFiles, ...locators]) if (await stat(resolve(local, file))) { await privatePath(resolve(local, file), isStoreDirectory(file)); files.push(file); }
    if (![...prefixes.flatMap(prefix => [`${prefix}.sqlite`, `${prefix}.sqlite.routing`]), ...locators].every(file => files.includes(file))) throw new Error("native_legacy_preparation_incomplete");
    marker.preparation = { ...peers, controllerGeneration: prepared.generation, controllerDigest: digest(prepared.state), files, sources };
    marker.preparationDigest = digest(marker.preparation);
    marker.phase = "activating";
    await publish(markerPath, marker);
    await options.onBoundary?.("prepared");
  }
  const prepared = marker.preparation;
  if (!prepared || marker.preparationDigest !== digest(prepared) || !Array.isArray(prepared.files) || new Set(prepared.files).size !== prepared.files.length
      || prepared.files.some(file => ![...dataFiles, ...locators].includes(file))) throw new Error("native_legacy_migration_preparation_invalid");
  validateLocal(prepared.runner, "runner", identity, fenceId); validateLocal(prepared.provider, "codex-provider", identity, fenceId);
  for (const name of ["control-plane-state.json", ...locators]) {
    const backup = resolve(originals, name), linked = !!await stat(backup);
    const source = linked ? backup : name === "control-plane-state.json" ? sourcePath : resolve(runner, name);
    // Our hard link changes ctime but preserves the original inode, bytes and
    // modification time. Before that link, require the full source identity.
    if (!prepared.sources?.[name] || !sameSource(prepared.sources[name]!, await sourceIdentity(source), linked)) throw new Error("native_legacy_source_changed");
  }
  await options.assertExclusiveFence();
  const current = await authority.load();
  if (!current) throw new Error("native_legacy_controller_missing");
  const receipt = (current.state.indexedState as StoredCoreState["indexedState"])?.legacyActivation;
  if (receipt?.fenceId === fenceId && receipt.preparationDigest === marker.preparationDigest && !authorityDirectlyFollows(current, prepared.controllerGeneration)) throw new Error("native_legacy_controller_advanced_before_publication");
  if (receipt?.fenceId !== fenceId || receipt.preparationDigest !== marker.preparationDigest) {
    if (current.generation !== prepared.controllerGeneration || digest(current.state) !== prepared.controllerDigest) throw new Error("native_legacy_controller_changed");
    const projection = legacyControllerActivation(current, identity, fenceId, marker.preparationDigest!);
    await authority.commit({ expectedGeneration: current.generation, state: projection as unknown as Record<string, unknown>, records: [] });
    await options.onBoundary?.("controller-commit");
  }
  // Preserve exact original bytes with no-clobber hard links before replacing
  // any locator. All peers are stopped; the external fence is rechecked below.
  for (const [name, path] of [["control-plane-state.json", sourcePath], ...locators.map(file => [file, resolve(runner, file)])] as const) {
    const backup = resolve(originals, name!);
    if (!await stat(backup)) { await privatePath(path!); await link(path!, backup); await syncDirectory(originals); }
    else await privatePath(backup);
  }
  for (const file of prepared.files) {
    await options.assertExclusiveFence();
    const source = resolve(local, file), target = resolve(runner, file);
    const sourceStat = await stat(source), targetStat = await stat(target);
    if (sourceStat) {
      await privatePath(source, isStoreDirectory(file));
      if (targetStat && !locators.includes(file)) throw new Error("native_legacy_destination_conflict");
      if (targetStat) await privatePath(target, isStoreDirectory(file));
      await rename(source, target); await syncDirectory(local); await syncDirectory(runner);
      await options.onBoundary?.(`publish:${file}`);
    } else await privatePath(target, isStoreDirectory(file));
  }
  await verifyLocal(runner, prepared, identity, fenceId, options.runnerBinary);
  await options.assertExclusiveFence();
  await publish(sourcePath, { schema: "paperclip.runner.authority-locator.v1", location: authority.location });
  await options.onBoundary?.("controller-locator");
  marker.phase = "active";
  await publish(markerPath, marker);
  await options.onBoundary?.("active");
}
