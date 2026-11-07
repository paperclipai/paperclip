import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";
import { persistNativeHarnessBackup, verifyDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";
import type { SettledControllerArchiveOwner } from "./native-controller-archive-source.js";
import { assertSkillSnapshotPath, MAX_SKILL_SNAPSHOT_FILES } from "../skill-snapshot.js";
import { MAX_NATIVE_HARNESS_PATH_BYTES } from "./native-harness-backup-archive.js";

export const NATIVE_CONTROLLER_WEB_LIMITS = {
  entries: MAX_SKILL_SNAPSHOT_FILES,
  metadataBytes: 4 * 1024 * 1024,
  pathBytes: MAX_NATIVE_HARNESS_PATH_BYTES,
} as const;

export type NativeControllerHistoryEntry = { path: string; mode: number; type: "directory" }
  | { path: string; mode: number; type: "file"; content: string };
export type NativeControllerHistoryManifestEntry = { path: string; mode: number; type: "directory" }
  | { path: string; mode: number; type: "file"; size: number; sha256: string };
export type NativeControllerWebEntry = { path: string; mode: number; type: "directory" }
  | { path: string; mode: number; type: "file"; content: Buffer };
type WebEvidence<T> = { entries: readonly T[]; bindingDigest: string };
type Source = { companyId: string; issueId: string; runId: string; controller?: string; supervisor?: string;
  history?: readonly NativeControllerHistoryEntry[];
  historyBindingDigest?: string;
  web?: WebEvidence<NativeControllerWebEntry>;
  purpose?: "filesystem_independence" };
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function nativeControllerHistoryManifest(history: readonly NativeControllerHistoryEntry[]): NativeControllerHistoryManifestEntry[] {
  return history.map(entry => entry.type === "directory" ? { ...entry }
    : { path: entry.path, mode: entry.mode, type: entry.type, size: Buffer.byteLength(entry.content), sha256: sha256(entry.content) });
}

export function nativeControllerWebManifest(entries: readonly NativeControllerWebEntry[]): NativeControllerHistoryManifestEntry[] {
  return entries.map(entry => entry.type === "directory" ? { ...entry }
    : { path: entry.path, mode: entry.mode, type: entry.type, size: entry.content.length, sha256: sha256(entry.content) });
}

export function nativeControllerEvidenceDescriptor(source: { companyId: string; issueId: string; runId: string;
  controllerDigest: string | null; supervisorDigest: string | null; history?: readonly NativeControllerHistoryManifestEntry[];
  historyBindingDigest?: string;
  web?: WebEvidence<NativeControllerHistoryManifestEntry>;
  purpose?: "filesystem_independence" }) {
  const history = source.history?.length ? source.history.map(entry => entry.type === "directory"
    ? { path: entry.path, mode: entry.mode, type: entry.type }
    : { path: entry.path, mode: entry.mode, type: entry.type, size: entry.size, sha256: entry.sha256 }) : undefined;
  if (history) {
    const paths = new Set<string>(); let bytes = 0;
    if (source.purpose !== "filesystem_independence" || history.length > 128 || !/^[a-f0-9]{64}$/.test(source.historyBindingDigest ?? "")) {
      throw new Error("native_controller_archive_authority_invalid");
    }
    for (const entry of history) {
      if (!/^authority-epochs(?:\/epoch-[a-f0-9]{24}(?:\/control-plane(?:\/control-plane-state\.json)?|\/runner-state\.json)?)?$/.test(entry.path)
        || paths.has(entry.path) || !Number.isInteger(entry.mode) || entry.mode < 0 || (entry.mode & ~0o777) !== 0
        || !["directory", "file"].includes(entry.type)
        || entry.path.includes("/") && !paths.has(entry.path.slice(0, entry.path.lastIndexOf("/")))) {
        throw new Error("native_controller_archive_authority_invalid");
      }
      paths.add(entry.path);
      if (entry.type === "file" && (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 16 * 1024 * 1024
        || !/^[a-f0-9]{64}$/.test(entry.sha256) || (bytes += entry.size) > 64 * 1024 * 1024)) {
        throw new Error("native_controller_archive_authority_invalid");
      }
    }
  }
  if (source.web && source.web.entries.length > NATIVE_CONTROLLER_WEB_LIMITS.entries) {
    throw new Error("native_controller_archive_authority_invalid");
  }
  const web = source.web ? { bindingDigest: source.web.bindingDigest,
    entries: source.web.entries.map(entry => entry.type === "directory" ? { path: entry.path, mode: entry.mode, type: entry.type }
      : { path: entry.path, mode: entry.mode, type: entry.type, size: entry.size, sha256: entry.sha256 }) } : undefined;
  if (source.controllerDigest === null && !web) throw new Error("native_controller_archive_authority_invalid");
  if (web) {
    const paths = new Set<string>(); let bytes = 0;
    if (source.purpose !== "filesystem_independence" || !/^[a-f0-9]{64}$/.test(web.bindingDigest)) {
      throw new Error("native_controller_archive_authority_invalid");
    }
    for (const entry of web.entries) {
      assertSkillSnapshotPath(entry.path);
      if (Buffer.byteLength(entry.path) > NATIVE_CONTROLLER_WEB_LIMITS.pathBytes
        || !/^(?:(web-home|web-state|web-manifests)(\/|$)|web-supervisor\.json$)/.test(entry.path) || paths.has(entry.path)
        || !["directory", "file"].includes(entry.type)
        || !Number.isInteger(entry.mode) || entry.mode < 0 || (entry.mode & ~0o777) !== 0
        || entry.path.includes("/") && !paths.has(entry.path.slice(0, entry.path.lastIndexOf("/")))
        || entry.type === "file" && (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 16 * 1024 * 1024
          || !/^[a-f0-9]{64}$/.test(entry.sha256) || (bytes += entry.size) > 64 * 1024 * 1024)) {
        throw new Error("native_controller_archive_authority_invalid");
      }
      paths.add(entry.path);
    }
    if (Buffer.byteLength(JSON.stringify(web.entries)) > NATIVE_CONTROLLER_WEB_LIMITS.metadataBytes) {
      throw new Error("native_controller_archive_authority_invalid");
    }
  }
  const manifest = JSON.stringify({ schema: "paperclip.legacy-controller-archive.v1", companyId: source.companyId,
    issueId: source.issueId, runId: source.runId, reason: source.purpose === "filesystem_independence"
      ? "original_volume_source_evidence" : "original_runner_artifact_unproven",
    files: { ...(source.controllerDigest === null ? {} : { "control-plane-state.json": source.controllerDigest }),
      ...(source.supervisorDigest === null ? {} : { "supervisor.json": source.supervisorDigest }),
      ...(history ? Object.fromEntries(history.filter(entry => entry.type === "file").map(entry => [entry.path, entry.sha256])) : {}),
      ...(web ? Object.fromEntries(web.entries.filter(entry => entry.type === "file").map(entry => [entry.path, entry.sha256])) : {}) },
    ...(history ? { history, historyBindingDigest: source.historyBindingDigest } : {}),
    ...(web ? { web: { entries: web.entries, bindingDigest: web.bindingDigest, controllerAbsent: source.controllerDigest === null } } : {}) });
  return { manifest, scopeDigest: sha256(manifest), manifestSha256: `sha256:${sha256(manifest)}` };
}

export function legacyNativeControllerArchive(source: Source) {
  return nativeControllerEvidenceDescriptor({ ...source, controllerDigest: source.controller === undefined ? null : sha256(source.controller),
    supervisorDigest: source.supervisor === undefined ? null : sha256(source.supervisor),
    history: source.history ? nativeControllerHistoryManifest(source.history) : undefined,
    web: source.web ? { entries: nativeControllerWebManifest(source.web.entries), bindingDigest: source.web.bindingDigest } : undefined });
}

export async function hasArchivedLegacyNativeController(db: Db, input: Source & { storage: StorageService; signal?: AbortSignal }) {
  return verifyDurableNativeHarnessBackup({ db, storage: input.storage, companyId: input.companyId,
    ...legacyNativeControllerArchive(input), signal: input.signal });
}

export async function archiveFailedLegacyNativeController(db: Db, input: Source & {
  storage: StorageService; writersStopped?: true; onlineOwner?: SettledControllerArchiveOwner; signal: AbortSignal;
}) {
  if (input.controller === undefined || input.web || input.purpose || input.history?.length || input.onlineOwner?.filesystemIndependence) throw new Error("native_controller_archive_authority_invalid");
  return persistLegacyControllerEvidence(db, input);
}

export async function archiveNativeControllerSourceEvidence(db: Db, input: Source & {
  storage: StorageService; onlineOwner: SettledControllerArchiveOwner; signal: AbortSignal;
}) {
  if (input.purpose !== "filesystem_independence" || !input.onlineOwner.filesystemIndependence) {
    throw new Error("native_controller_archive_authority_invalid");
  }
  input = { ...input, history: input.history?.map(entry => ({ ...entry })), web: input.web ? { ...input.web,
    entries: input.web.entries.map(entry => entry.type === "file" ? { ...entry, content: Buffer.from(entry.content) } : { ...entry }) } : undefined };
  (await import("./native-harness-filesystem-independence.js")).assertNativeHarnessFilesystemArchiveContents(
    input.onlineOwner, legacyNativeControllerArchive(input));
  await db.transaction(async tx => (await import("./native-controller-archive-source.js"))
    .assertSettledControllerArchiveSource(tx as unknown as Db, input.onlineOwner));
  return persistLegacyControllerEvidence(db, input);
}

async function persistLegacyControllerEvidence(db: Db, input: Source & {
  storage: StorageService; writersStopped?: true; onlineOwner?: SettledControllerArchiveOwner; signal: AbortSignal;
}) {
  if (input.onlineOwner ? input.writersStopped || input.onlineOwner.kind !== "settled_controller_archive"
    || input.onlineOwner.companyId !== input.companyId || input.onlineOwner.issueId !== input.issueId
    || input.onlineOwner.runId !== input.runId || input.onlineOwner.controllerDigest !== (input.controller === undefined ? null : sha256(input.controller))
    || input.onlineOwner.supervisorDigest !== (input.supervisor === undefined ? null : sha256(input.supervisor)) : !input.writersStopped) {
    throw new Error("native_controller_archive_authority_invalid");
  }
  if (await hasArchivedLegacyNativeController(db, input)) return;
  const descriptor = legacyNativeControllerArchive(input);
  const root = await mkdtemp(join(tmpdir(), "pc-legacy-controller-archive-"));
  try {
    await writeFile(join(root, "manifest.json"), descriptor.manifest, { mode: 0o600 });
    if (input.controller !== undefined) await writeFile(join(root, "control-plane-state.json"), input.controller, { mode: 0o600 });
    if (input.supervisor !== undefined) await writeFile(join(root, "supervisor.json"), input.supervisor, { mode: 0o600 });
    for (const entry of input.history ?? []) {
      if (entry.type === "directory") await mkdir(join(root, entry.path), { mode: 0o700 });
      else await writeFile(join(root, entry.path), entry.content, { mode: entry.mode });
    }
    for (const entry of [...(input.history ?? [])].reverse()) await chmod(join(root, entry.path), entry.mode);
    for (const entry of input.web?.entries ?? []) {
      if (entry.type === "directory") await mkdir(join(root, entry.path), { mode: 0o700 });
      else await writeFile(join(root, entry.path), entry.content, { mode: entry.mode });
    }
    for (const entry of [...(input.web?.entries ?? [])].reverse()) await chmod(join(root, entry.path), entry.mode);
    await persistNativeHarnessBackup({ db, storage: input.storage, root, scopeDigest: descriptor.scopeDigest, signal: input.signal,
      owner: input.onlineOwner ?? { kind: "offline_migration", writersStopped: true, terminalFailureOnly: true,
        companyId: input.companyId, issueId: input.issueId, runId: input.runId } });
  } finally { await removeNativeHarnessBackup(root); }
}
