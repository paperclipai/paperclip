import type { Db } from "@paperclipai/db";
import { migrateRunEvidence, type RunEvidenceMigrationItem } from "./run-evidence-migration.js";
import { beginIdleTrackedWork } from "./task-admission.js";

const owners = new WeakSet<Db>();
const unprovenCoverage = new Set(["native_log_source_coverage_unproven", "native_run_log_source_integrity_error"]);
type PageOptions = Pick<Parameters<typeof migrateRunEvidence>[1], "afterRunId" | "afterTraceId" | "limit" | "kinds" | "signal">;
export type RunEvidenceMigrationPage = Awaited<ReturnType<typeof migrateRunEvidence>> & { busy?: boolean };

export async function migrateRunEvidencePage(db: Db, options: PageOptions): Promise<RunEvidenceMigrationPage> {
  options.signal?.throwIfAborted();
  if (owners.has(db)) return { items: [], busy: true };
  owners.add(db);
  const settled = beginIdleTrackedWork();
  try {
    const result = await migrateRunEvidence(db, { ...options, apply: true });
    options.signal?.throwIfAborted();
    const items: RunEvidenceMigrationItem[] = [];
    for (const item of result.items) {
      options.signal?.throwIfAborted();
      if (item.kind !== "log" || item.state !== "blocked" || !unprovenCoverage.has(item.reason ?? "")) {
        items.push(item);
        continue;
      }
      const archived = await migrateRunEvidence(db, { apply: true, runId: item.id, kinds: ["log"], limit: 1,
        preserveSettledNativeFiles: true, signal: options.signal });
      options.signal?.throwIfAborted();
      const current = archived.items.find(candidate => candidate.id === item.id);
      if (current) items.push(current);
    }
    return { ...result, items };
  } finally {
    owners.delete(db);
    settled();
  }
}
