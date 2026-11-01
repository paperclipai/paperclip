import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { noteNativeHarnessBackupChange } from "../native-harness-backup-expiration-notifications.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";

export async function publishNativeHarnessBackup(input: {
  db: object; companyId: string; scopeDigest: string; backupRoot: string; pendingRoot: string;
  stamp?: (currentRoot: string) => Promise<void>;
}) {
  const currentRoot = resolve(input.backupRoot, "current");
  const previousRoot = resolve(input.backupRoot, "previous");
  removeNativeHarnessBackup(previousRoot);
  let movedCurrent = false;
  if (existsSync(currentRoot)) {
    renameSync(currentRoot, previousRoot);
    movedCurrent = true;
  }
  try {
    renameSync(input.pendingRoot, currentRoot);
    await input.stamp?.(currentRoot);
  } catch (error) {
    if (existsSync(currentRoot)) removeNativeHarnessBackup(currentRoot);
    if (movedCurrent && existsSync(previousRoot) && !existsSync(currentRoot)) renameSync(previousRoot, currentRoot);
    throw error;
  }
  removeNativeHarnessBackup(previousRoot);
  noteNativeHarnessBackupChange(input.db, { companyId: input.companyId, scopeDigest: input.scopeDigest });
}
