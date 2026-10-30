import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { onNativeHarnessBackupChange, type NativeHarnessBackupExpirationScope } from "../native-harness-backup-expiration-notifications.js";
import { onRetainedNativeSessionCleanupRelease } from "../retained-native-session-cleanup-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { nativeHarnessBackupExpirationService, type NativeHarnessBackupExpirationOptions } from "./native-harness-backup-expiration.js";

type Entry = { id: string; companyId: string; agentId: string; dueAt: number };

export function registerNativeHarnessBackupExpirationWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, db: Db,
  options: NativeHarnessBackupExpirationOptions, canRun: () => boolean,
) {
  const service = nativeHarnessBackupExpirationService(db, { ...options, duty: "backups" });
  const cursors = new Map<string, string>();
  const worker = registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.nativeHarnessBackupExpiration, batchSize: options.maxRemovals ?? 25,
    decodeScope: (hint: string): NativeHarnessBackupExpirationScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
    matches: (entry: Entry, scope?: NativeHarnessBackupExpirationScope) => !scope || entry.companyId === scope.companyId
      && (!scope.scopeDigest || entry.id === scope.scopeDigest),
    load: async (scope, signal) => {
      const key = scope ? JSON.stringify(scope) : "*";
      const page = scope?.scopeDigest ? { names: [scope.scopeDigest], complete: true }
        : await service.backupScopes(cursors.get(key), options.maxEntries ?? 100);
      const rows: Entry[] = [];
      for (const name of page.names) {
        if (signal?.aborted || !canRun()) throw new Error("Backup expiration discovery paused");
        const entry = await service.inspectBackup(name);
        if (entry && (!scope || entry.companyId === scope.companyId)) rows.push(entry);
      }
      if (page.complete) cursors.delete(key); else cursors.set(key, page.names.at(-1)!);
      return { rows, complete: page.complete };
    },
    check: async (entry, signal) => {
      if (signal?.aborted || !canRun()) throw new Error("Backup expiration paused");
      const current = await service.inspectBackup(entry.id);
      if (!current || current.companyId !== entry.companyId) return null;
      if (current.dueAt > Date.now()) return current;
      const result = await service.expireBackup(entry.id);
      if (result.candidates || result.failed) logger.info({ ...result, dryRun: options.dryRun ?? false }, "native harness backup expiration");
      if (options.dryRun) return null;
      const remaining = await service.inspectBackup(entry.id);
      if (!remaining) return null;
      if (result.skipped.session_active) throw new Error("Backup session is active");
      return remaining;
    },
  }, canRun);
  const unsubscribe = onNativeHarnessBackupChange(db, scope => worker.invalidate(JSON.stringify(scope)));
  const release = onRetainedNativeSessionCleanupRelease(db, scope => worker.invalidate(JSON.stringify({ companyId: scope.companyId })));
  return { ...worker, async stop() { unsubscribe(); release(); await worker.stop(); } };
}
