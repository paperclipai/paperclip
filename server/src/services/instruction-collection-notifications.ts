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

const waitingCopy = (scope: { companyId: string; runId: string }) => sql`company_id = ${scope.companyId} and run_id = ${scope.runId} and (
  (not (coalesce(receipt, '{}'::jsonb) ? 'retainedByRunId') and (
    (attempts < 3 and state in ('prepared', 'pending_collection', 'unchanged_turn', 'warm_saved'))
    or (state = 'unavailable' and process_stopped_at is null and location like 'remote:%'
      and receipt->>'schema' = 'paperclip.agent-files.v1')))
  or (state in ('saved', 'unchanged', 'resolved', 'unavailable') and process_stopped_at is not null
    and receipt->>'schema' = 'paperclip.agent-files.v1' and coalesce(receipt->>'retainedByRunId', '') = ''
    and (receipt->>'cleanupPending' = 'true' or (receipt->>'cleanupPending' is distinct from 'false' and receipt ? 'baseline'))))`;

export async function notifyInstructionCopyStopEvidence(transaction: object, scope: { companyId: string; runId: string }) {
  if (typeof (transaction as Db).execute !== "function") return;
  const found = await (transaction as Db).execute(sql`select 1 from agent_instruction_working_copies where ${waitingCopy(scope)}`);
  if (!Array.isArray(found) || found.length === 0) return;
  await notifyInstructionCollection(transaction, scope);
  await notifyDirectoryCleanup(transaction, scope);
  await (transaction as Db).execute(sql`update agent_instruction_working_copies
    set next_attempt_at = least(coalesce(next_attempt_at, now()), now()), updated_at = clock_timestamp()
    where ${waitingCopy(scope)}`);
}
