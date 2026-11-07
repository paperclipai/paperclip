import { and, eq } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";
import type { CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";
import type { ResolvedChatQuestionFormOpen } from "../../chat-question-forms.js";
import type { SlackFormOpenContext } from "./cloud-forms.js";
import { SlackCloudReceiptError } from "./cloud-event.js";
import { stageSlackFormSession, confirmSlackFormSessionUpdate } from "./form-session.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Scope = { companyId: string; endpointId: string; conversationId: string; principalId: string };
export async function stageSlackFormOpenCallback(tx: Tx, input: Scope & {
  context: SlackFormOpenContext; resolved: ResolvedChatQuestionFormOpen; lease?: CredentialMutationLeaseGuard;
  attemptProviderActionId: string; attemptActionId: string | null;
}): Promise<{ kind: "ready"; attemptActionId: string; resolved: ResolvedChatQuestionFormOpen } | { kind: "duplicate" }> {
  const { context, lease } = input;
  if (!lease || !context.environment) throw new SlackCloudReceiptError("form_credential_lease_unavailable", "retry");
  const held = await stageSlackFormSession(tx, { operation: context.operation, currentBinding: context.currentBinding,
    principalId: input.principalId, resolved: input.resolved, lease, environment: context.environment });
  context.sessionActionId = held.actionId;
  if (held.kind !== "update") return { kind: "duplicate" };
  if (input.attemptActionId) return { kind: "ready", attemptActionId: input.attemptActionId, resolved: input.resolved };
  const [attempt] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, input.companyId),
    eq(chatActions.endpointId, input.endpointId), eq(chatActions.conversationId, input.conversationId),
    eq(chatActions.principalId, input.principalId), eq(chatActions.kind, "question_form_open_attempt"),
    eq(chatActions.providerActionId, input.attemptProviderActionId))).for("update");
  if (!attempt || attempt.status !== "processing") throw new SlackCloudReceiptError("form_open_attempt_unresolved", "attention");
  return { kind: "ready", attemptActionId: attempt.id, resolved: input.resolved };
}
export async function confirmSlackFormOpenCallback(tx: Tx, input: Omit<Scope, "conversationId"> & { context: SlackFormOpenContext }): Promise<void> {
  const { context } = input;
  if (!context.sessionActionId || !context.updatedView || !context.operation.view) throw new SlackCloudReceiptError("form_update_receipt_unavailable", "retry");
  const updated = await confirmSlackFormSessionUpdate(tx, { companyId: input.companyId, endpointId: input.endpointId,
    principalId: input.principalId, operationId: context.operation.id }, context.operation.view, context.updatedView.hash);
  if (!updated) throw new SlackCloudReceiptError("form_update_settlement_changed", "retry");
}
