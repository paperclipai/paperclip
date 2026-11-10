import { and, asc, desc, isNotNull, sql } from "drizzle-orm";
import { executionWorkspaces, type Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { offlineWorkspaceMigrationBlockers } from "./remote-workspace-migration-tree.js";
import { migrateRemoteWorkspace } from "./remote-workspace-migration.js";

/** The Cloud maintenance process owns the stop-all-deployments precondition.
 * Imported records leave the pending set, so a restart resumes the same owner
 * journals without moving the task binding or importing over remote authority. */
export async function migrateWorkspaceTrees(db: Db, input: {
  storage: StorageService; signal: AbortSignal; phase: (name: string) => void;
}) {
  const blockers = await offlineWorkspaceMigrationBlockers(db);
  if (blockers.length) throw new Error(blockers[0]);
  let migrated = 0;
  for (;;) {
    input.signal.throwIfAborted();
    // Match the final ephemeral-storage contract, not just the importer's
    // supported subset. Silently skipping an unsupported provider or unsettled
    // lifecycle state would abandon files when the original volume is detached.
    const rows = await db.select({ companyId: executionWorkspaces.companyId, workspaceId: executionWorkspaces.id })
      .from(executionWorkspaces).where(and(isNotNull(executionWorkspaces.cwd),
        sql`${executionWorkspaces.providerType} <> 'plugin'`,
        sql`coalesce(${executionWorkspaces.metadata}->'remoteWorkspace'->>'schema', '') <> 'paperclip.remote-workspace.v1'`,
      )).orderBy(desc(sql`length(${executionWorkspaces.cwd})`), asc(executionWorkspaces.id)).limit(25);
    if (!rows.length) return migrated;
    for (const workspace of rows) {
      input.signal.throwIfAborted();
      input.phase(`workspace:${workspace.workspaceId}`);
      await migrateRemoteWorkspace({ db, storage: input.storage, ...workspace, apply: true, writersStopped: true, signal: input.signal });
      migrated++;
    }
  }
}
