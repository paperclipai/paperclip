import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { notifySkillVersionRetention } from "./skill-version-retention-notifications.js";
import { notifyDirectoryCleanup } from "./directory-cleanup-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type InstructionCollectionScope = { companyId: string; runId?: string };

export async function notifyInstructionCollection(transaction: object, scope?: InstructionCollectionScope) {
  if (scope) await notifySkillVersionRetention(transaction, scope.companyId);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.instructionCollection, scope ? JSON.stringify(scope) : "*");
}

export async function notifyInstructionCopyStopEvidence(transaction: object, scope: { companyId: string; runId: string }) {
  if (typeof (transaction as Db).execute !== "function") return;
  const advanced = await (transaction as Db).execute<{ cleanup: boolean }>(sql`update agent_instruction_working_copies
    set next_attempt_at = now(), updated_at = now()
    where company_id = ${scope.companyId} and run_id = ${scope.runId} and next_attempt_at > now() and (
      (not (coalesce(receipt, '{}'::jsonb) ? 'retainedByRunId') and (
        (attempts < 3 and state in ('prepared', 'pending_collection', 'unchanged_turn', 'warm_saved'))
        or (state = 'unavailable' and process_stopped_at is null and location like 'remote:%'
          and receipt->>'schema' = 'paperclip.agent-files.v1')))
      or (state in ('saved', 'unchanged', 'resolved', 'unavailable') and process_stopped_at is not null
        and receipt->>'schema' = 'paperclip.agent-files.v1' and coalesce(receipt->>'retainedByRunId', '') = ''
        and (receipt->>'cleanupPending' = 'true' or (receipt->>'cleanupPending' is distinct from 'false' and receipt ? 'baseline'))))
    returning process_stopped_at is not null and state in ('saved', 'unchanged', 'resolved', 'unavailable') as cleanup`);
  const rows: Array<{ cleanup: boolean }> = Array.isArray(advanced) ? advanced : [];
  if (rows.some(row => !row.cleanup)) await notifyInstructionCollection(transaction, scope);
  if (rows.some(row => row.cleanup)) await notifyDirectoryCleanup(transaction, scope);
}
