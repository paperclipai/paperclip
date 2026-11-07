import { slackFormRetirementHistoryReceipt } from "./ack-retirement-receipt.js";
import { isDeepStrictEqual } from "node:util";
import type { VerifiedIdleCapabilities } from "../../idle-incoming-wake-capability.js";
import { matchSlackConfiguredCoverage, type SlackConfiguredRequirement } from "./configured-coverage.js";
import type { chatActions } from "@paperclipai/db";
import { parseSlackFormBinding, parseSlackFormPublicEnrollment, sameSlackFormBinding } from "./cloud-forms.js";
import { parseSlackFormAckWork, assertSlackFormReceiptHistory } from "./form-ack-work.js";

export type SlackFormHistoryRow = Pick<typeof chatActions.$inferSelect, "id" | "companyId" | "endpointId" | "kind" | "payload" | "result" | "principalId" | "conversationId" | "status" | "providerActionId">;
export function completedSlackFormHistoryActionIds(rows: readonly SlackFormHistoryRow[], companyId: string, endpointId: string, coverage?: { requirements: readonly SlackConfiguredRequirement[]; verified: VerifiedIdleCapabilities; expected: { instanceId: string; generation: string; environment: string } }): readonly string[] {
  const scoped = rows.filter(row => row.companyId === companyId && row.endpointId === endpointId);
  const completed = new Set<string>();
  const matched = coverage ? matchSlackConfiguredCoverage(coverage.requirements, coverage.verified, coverage.expected) : undefined;
  for (const row of scoped) {
    if (!["slack_form_owner", "slack_form_grant"].includes(row.kind) || row.result?.nextAttemptAt !== null) continue;
    try {
      if (row.result?.phase === "transferred") {
        if (slackFormRetirementHistoryReceipt(row)) completed.add(row.id);
        continue;
      }
      const binding = parseSlackFormBinding(row.payload.binding);
      if (binding.companyId !== companyId || binding.endpointId !== endpointId) continue;
      if (!coverage || !matched?.endpointIds.includes(endpointId) || !matched.connectionIds.includes(binding.connectionId)
        || row.payload.environment !== coverage.expected.environment || !coverage.requirements.some(requirement => sameSlackFormBinding(requirement.binding, binding))) continue;
      if (row.kind === "slack_form_owner" && row.result?.phase === "enrolled" || row.kind === "slack_form_grant" && row.result?.phase === "published") completed.add(row.id);
    } catch { continue; }
  }
  for (const session of scoped) {
    if (session.kind !== "slack_form_session" || !["processed", "cancelled", "failed"].includes(session.status)) continue;
    try {
      const binding = parseSlackFormBinding(session.payload.binding), work = parseSlackFormAckWork(session.result?.formAck);
      if (session.status === "failed" && work.receipt?.outcome !== "no_effect") continue;
      if (binding.companyId !== companyId || binding.endpointId !== endpointId || work.phase !== "transferred" || !work.receiptJws || !work.receipt
        || session.result?.nextAttemptAt !== null) continue;
      const receipt = work.receipt;
      assertSlackFormReceiptHistory(session, receipt);
      completed.add(session.id);
      for (const action of scoped) {
        if (!["question_form_open", "question_form_submit"].includes(action.kind) || action.status !== "processed"
          || action.conversationId !== session.conversationId || action.principalId !== session.principalId) continue;
        const expected = action.kind === "question_form_open" ? session.payload.openActionRowId : session.payload.submitActionRowId;
        if (action.id === expected && action.payload.interactionId === session.payload.interactionId
          && action.payload.publicationId === session.payload.publicationId) completed.add(action.id);
      }
    } catch { continue; }
  }
  return [...completed].sort();
}
