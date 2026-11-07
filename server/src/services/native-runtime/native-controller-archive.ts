import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";
import { persistNativeHarnessBackup, verifyDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";
import type { SettledControllerArchiveOwner } from "./native-controller-archive-source.js";

type Source = { companyId: string; issueId: string; runId: string; controller: string; supervisor?: string };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function legacyNativeControllerArchive(source: Source) {
  const manifest = JSON.stringify({ schema: "paperclip.legacy-controller-archive.v1", companyId: source.companyId,
    issueId: source.issueId, runId: source.runId, reason: "original_runner_artifact_unproven",
    files: { "control-plane-state.json": sha256(source.controller),
      ...(source.supervisor === undefined ? {} : { "supervisor.json": sha256(source.supervisor) }) } });
  return { manifest, scopeDigest: sha256(manifest), manifestSha256: `sha256:${sha256(manifest)}` };
}

export async function hasArchivedLegacyNativeController(db: Db, input: Source & { storage: StorageService; signal?: AbortSignal }) {
  return verifyDurableNativeHarnessBackup({ db, storage: input.storage, companyId: input.companyId,
    ...legacyNativeControllerArchive(input), signal: input.signal });
}

export async function archiveFailedLegacyNativeController(db: Db, input: Source & {
  storage: StorageService; writersStopped?: true; onlineOwner?: SettledControllerArchiveOwner; signal: AbortSignal;
}) {
  if (input.onlineOwner ? input.writersStopped || input.onlineOwner.kind !== "settled_controller_archive"
    || input.onlineOwner.companyId !== input.companyId || input.onlineOwner.issueId !== input.issueId
    || input.onlineOwner.runId !== input.runId || input.onlineOwner.controllerDigest !== sha256(input.controller)
    || input.onlineOwner.supervisorDigest !== (input.supervisor === undefined ? null : sha256(input.supervisor)) : !input.writersStopped) {
    throw new Error("native_controller_archive_authority_invalid");
  }
  if (await hasArchivedLegacyNativeController(db, input)) return;
  const descriptor = legacyNativeControllerArchive(input);
  const root = await mkdtemp(join(tmpdir(), "pc-legacy-controller-archive-"));
  try {
    await writeFile(join(root, "manifest.json"), descriptor.manifest, { mode: 0o600 });
    await writeFile(join(root, "control-plane-state.json"), input.controller, { mode: 0o600 });
    if (input.supervisor !== undefined) await writeFile(join(root, "supervisor.json"), input.supervisor, { mode: 0o600 });
    await persistNativeHarnessBackup({ db, storage: input.storage, root, scopeDigest: descriptor.scopeDigest, signal: input.signal,
      owner: input.onlineOwner ?? { kind: "offline_migration", writersStopped: true, terminalFailureOnly: true,
        companyId: input.companyId, issueId: input.issueId, runId: input.runId } });
  } finally { await removeNativeHarnessBackup(root); }
}
