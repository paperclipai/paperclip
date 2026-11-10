import { slackFormRetirementHistoryReceipt } from "./ack-retirement-receipt.js";
import { isDeepStrictEqual } from "node:util";
import type { VerifiedIdleCapabilities } from "../../idle-incoming-wake-capability.js";
import { matchSlackConfiguredCoverage, type SlackConfiguredRequirement } from "./configured-coverage.js";
import type { chatActions } from "@paperclipai/db";
import { parseSlackFormBinding, parseSlackFormPublicEnrollment, sameSlackFormBinding } from "./cloud-forms.js";
import { parseSlackFormAckWork, assertSlackFormReceiptHistory } from "./form-ack-work.js";

export type SlackFormHistoryRow = Pick<typeof chatActions.$inferSelect, "id" | "companyId" | "endpointId" | "kind" | "payload" | "result" | "principalId" | "conversationId" | "status" | "providerActionId">;
export type SlackFormHistoryCoverage = { requirements: readonly SlackConfiguredRequirement[]; verified: VerifiedIdleCapabilities;
  expected: { instanceId: string; generation: string; environment: string }; currentOwners?: ReadonlyMap<string, SlackFormHistoryRow> };

/** Prepare bounded current coverage once; history pages retain no protocol rows.
 * Session-related actions are supplied from the same page or indexed DB joins.
 */
export function createSlackFormHistoryClassifier(coverage?: SlackFormHistoryCoverage) {
  const matched = coverage ? matchSlackConfiguredCoverage(coverage.requirements, coverage.verified, coverage.expected) : undefined;
  const endpoints = new Set(matched?.endpointIds), connections = new Set(matched?.connectionIds);
  const bindings = new Map(coverage?.requirements.map(requirement => [
    `${requirement.binding.companyId}:${requirement.binding.endpointId}`, requirement.binding]));
  return (rows: readonly SlackFormHistoryRow[], companyId: string, endpointId: string, check?: () => void): readonly string[] => {
    const scoped: SlackFormHistoryRow[] = [], byId = new Map<string, SlackFormHistoryRow>();
    for (const row of rows) {
      check?.();
      if (row.companyId !== companyId || row.endpointId !== endpointId) continue;
      const prior = byId.get(row.id);
      if (prior && !isDeepStrictEqual(prior, row)) return [];
      if (!prior) { scoped.push(row); byId.set(row.id, row); }
    }
    const completed = new Set<string>();
    for (const row of scoped) {
      check?.();
      if (!["slack_form_owner", "slack_form_grant"].includes(row.kind) || row.result?.nextAttemptAt !== null) continue;
      try {
        if (row.result?.phase === "transferred") {
          if (slackFormRetirementHistoryReceipt(row)) completed.add(row.id);
          continue;
        }
        const binding = parseSlackFormBinding(row.payload.binding);
        const current = bindings.get(`${companyId}:${endpointId}`);
        if (binding.companyId !== companyId || binding.endpointId !== endpointId || !coverage
          || !endpoints.has(endpointId) || !connections.has(binding.connectionId)
          || row.payload.environment !== coverage.expected.environment || !current || !sameSlackFormBinding(current, binding)) continue;
        if (row.kind === "slack_form_owner" && row.result?.phase === "enrolled") {
          // Owner uniqueness was certified separately. A new or changed owner
          // between keyset passes remains unclassified for the fresh shared gate.
          if (!coverage.currentOwners || isDeepStrictEqual(coverage.currentOwners.get(row.id), row)) completed.add(row.id);
        } else if (row.kind === "slack_form_grant" && row.result?.phase === "published") completed.add(row.id);
      } catch { continue; }
    }
    for (const session of scoped) {
      check?.();
      if (session.kind !== "slack_form_session" || !["processed", "cancelled", "failed"].includes(session.status)) continue;
      try {
        const binding = parseSlackFormBinding(session.payload.binding), work = parseSlackFormAckWork(session.result?.formAck);
        if (session.status === "failed" && work.receipt?.outcome !== "no_effect") continue;
        if (binding.companyId !== companyId || binding.endpointId !== endpointId || work.phase !== "transferred" || !work.receiptJws || !work.receipt
          || session.result?.nextAttemptAt !== null) continue;
        assertSlackFormReceiptHistory(session, work.receipt);
        completed.add(session.id);
        for (const [kind, id] of [["question_form_open", session.payload.openActionRowId], ["question_form_submit", session.payload.submitActionRowId]] as const) {
          const action = typeof id === "string" ? byId.get(id) : undefined;
          if (action?.kind === kind && action.status === "processed" && action.conversationId === session.conversationId
            && action.principalId === session.principalId && action.payload.interactionId === session.payload.interactionId
            && action.payload.publicationId === session.payload.publicationId) completed.add(action.id);
        }
      } catch { continue; }
    }
    return [...completed].sort();
  };
}

export function completedSlackFormHistoryActionIds(rows: readonly SlackFormHistoryRow[], companyId: string, endpointId: string, coverage?: SlackFormHistoryCoverage): readonly string[] {
  return createSlackFormHistoryClassifier(coverage)(rows, companyId, endpointId);
}

export function completedSlackFormSessionReceipt(session: Pick<SlackFormHistoryRow, "id" | "companyId" | "endpointId" | "kind" | "payload" | "result" | "status">) {
  if (session.kind !== "slack_form_session" || !["processed", "cancelled", "failed"].includes(session.status)) return null;
  const binding = parseSlackFormBinding(session.payload.binding), work = parseSlackFormAckWork(session.result?.formAck);
  if (session.status === "failed" && work.receipt?.outcome !== "no_effect") return null;
  if (binding.companyId !== session.companyId || binding.endpointId !== session.endpointId || work.phase !== "transferred"
    || !work.receiptJws || !work.receipt || session.result?.nextAttemptAt !== null) return null;
  assertSlackFormReceiptHistory(session, work.receipt);
  return work.receipt;
}
