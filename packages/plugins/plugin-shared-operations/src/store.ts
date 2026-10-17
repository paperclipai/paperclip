import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { DomainError, emptyState, type CompanyState } from "./domain.js";

export interface StoredState { revision: number; state: CompanyState }
export interface TaskHead { id: string; taskRevision: string; receiverId: string | null }

// Include both transaction and full-precision time. Tokens describe this live
// database only; after a restore, callers must create fresh handoff snapshots.
const taskVersion = "(xmin::text || ':' || extract(epoch from updated_at)::text)";

export function companyId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError("invalid_company", "A valid company is required.");
  }
  return value;
}

export function taskId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError("invalid_task", "A valid task is required.");
  }
  return value;
}

export function expectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("invalid_revision", "An expected revision is required.");
  }
  return value;
}

export function createStore(db: PluginDatabaseClient) {
  if (!/^plugin_[a-z0-9_]+$/.test(db.namespace)) throw new Error("Invalid plugin database namespace");
  const table = `${db.namespace}.company_state`;
  return {
    async taskHead(id: string, taskIdValue: string): Promise<TaskHead> {
      const rows = await db.query<TaskHead>(
        `SELECT id, ${taskVersion} AS "taskRevision", assignee_agent_id AS "receiverId" FROM public.issues WHERE company_id = $1 AND id = $2`,
        [companyId(id), taskId(taskIdValue)],
      );
      if (!rows[0]) throw new DomainError("invalid_task", "The task does not belong to this company.", 404);
      return rows[0];
    },
    async read(id: string): Promise<StoredState> {
      const rows = await db.query<{ revision: number; document: CompanyState }>(
        `SELECT revision, document FROM ${table} WHERE company_id = $1`, [companyId(id)],
      );
      return rows[0] ? { revision: rows[0].revision, state: rows[0].document } : { revision: 0, state: emptyState() };
    },
    async save(id: string, revisionValue: unknown, state: CompanyState, task?: TaskHead): Promise<StoredState> {
      companyId(id);
      const revision = expectedRevision(revisionValue);
      const document = JSON.stringify(state);
      // This first version keeps audit history in one atomic document. Surface the
      // storage limit instead of dropping history or silently truncating memory.
      if (Buffer.byteLength(document, "utf8") > 900_000) {
        throw new DomainError("storage_limit", "Company operations have reached the document limit. Export and migrate the history before adding records.", 422);
      }
      await db.execute(
        `INSERT INTO ${table} (company_id, document) VALUES ($1, $2::jsonb) ON CONFLICT (company_id) DO NOTHING`,
        [id, JSON.stringify(emptyState())],
      );
      const result = await db.execute(
        `UPDATE ${table} SET document = $1::jsonb, revision = revision + 1, updated_at = now() WHERE company_id = $2 AND revision = $3${task ? ` AND EXISTS (SELECT 1 FROM public.issues WHERE id = $4 AND company_id = $2 AND ${taskVersion} = $5 AND assignee_agent_id = $6 FOR SHARE)` : ""}`,
        task ? [document, id, revision, task.id, task.taskRevision, task.receiverId] : [document, id, revision],
      );
      if (result.rowCount !== 1) throw new DomainError("revision_conflict", "The company state changed. Refresh and review the new state before retrying.", 409);
      return { revision: revision + 1, state };
    },
  };
}
