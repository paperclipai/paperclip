import { parseSlackFormRetirementReceipt } from "./ack-retirement-receipt.js";
import { assertSlackFormRetirementWorkAuthority, assertSlackRetirementGCWork } from "./form-retirement-work.js";
import { slackFormRetirementHistoryReceipt } from "./ack-retirement-receipt.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chatActions, chatEndpoints, type Db } from "@paperclipai/db";
import type { ConnectionManagementContext } from "../../connection-management.js";
import { logActivity } from "../../activity-log.js";
import { notifyDeliveryWork, DELIVERY_QUEUES } from "../../delivery-work-notifications.js";
import { badRequest, conflict, forbidden, notFound } from "../../../errors.js";
import { parseSlackFormBinding, sameSlackFormBinding } from "./cloud-forms.js";
import { parseSlackFormProofAcceptance } from "./form-session.js";
import { parseSlackFormAckWork } from "./form-ack-work.js";
import type { SlackFormConnectorIdentity } from "./cloud-consumer.js";

export async function retrySlackFormAcknowledgement(db: Db, input: { companyId: string; endpointId: string; actionId: string;
  identity(): SlackFormConnectorIdentity | null; management: ConnectionManagementContext }): Promise<{ actionId: string; state: "scheduled" | "already_scheduled" | "complete" }> {
  if (!/^[a-f0-9-]{36}$/i.test(input.actionId)) throw badRequest("Invalid provider work ID");
  await input.management.reauthorize();
  const identity = input.identity();
  if (input.management.resource.companyId !== input.companyId || !identity || !input.management.decision.allowed || input.management.decision.action !== "connections:configure")
    throw forbidden("Current company and Cloud management authority are required");
  const result = await db.transaction(async tx => {
    const [endpoint] = await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, input.endpointId), eq(chatEndpoints.companyId, input.companyId))).for("update");
    if (!endpoint || endpoint.provider !== "slack") throw notFound("Slack endpoint not found");
    if (input.management.resource.connectionId && input.management.resource.connectionId !== endpoint.connectionId) throw forbidden("Connection authority changed");
    const [row] = await tx.select().from(chatActions).where(and(eq(chatActions.id, input.actionId), eq(chatActions.companyId, input.companyId),
      eq(chatActions.endpointId, endpoint.id), inArray(chatActions.kind, ["slack_form_session", "slack_form_owner"]))).for("update");
    if (!row) throw notFound("Slack form work not found");
    if (row.kind === "slack_form_owner") {
      if (row.result?.phase === "transferred") {
        const retired = slackFormRetirementHistoryReceipt(row);
        if (!retired || retired.binding.instanceId !== identity.instanceId || retired.environment !== identity.environment
          || retired.binding.publicId !== endpoint.publicId || retired.binding.connectionId !== endpoint.connectionId) throw conflict("Retirement history authority changed");
        return { actionId: row.id, state: "complete" as const };
      }
      if (!["retirement_accepted", "retirement_gc_pending"].includes(String(row.result?.phase)) || typeof row.result?.retirementReceiptJws !== "string") throw conflict("No accepted retirement responsibility is available for retry");
      const receipt = row.result?.phase === "retirement_gc_pending" ? assertSlackRetirementGCWork(row, identity) : parseSlackFormRetirementReceipt(row.result.retirementReceipt);
      assertSlackFormRetirementWorkAuthority(row, identity, receipt);
      if (receipt.binding.publicId !== endpoint.publicId || receipt.binding.connectionId !== endpoint.connectionId
        || ["SLACK_FORM_SUBJECT_CHANGED", "SLACK_FORM_INSTANCE_CHANGED", "SLACK_FORM_ENROLLMENT_CHANGED", "SLACK_FORM_CREDENTIAL_CHANGED", "SLACK_FORM_RETIREMENT_CHANGED", "SLACK_FORM_CUSTODY_CHANGED"].includes(String(row.result.failureReason)))
        throw conflict("Retirement responsibility does not match current ownership");
      if (typeof row.result.nextAttemptAt === "string" && Number.isFinite(Date.parse(row.result.nextAttemptAt))) return { actionId: row.id, state: "already_scheduled" as const };
      if (row.status !== "attention" || row.result.nextAttemptAt !== null) throw conflict("Retirement work has no valid retry state");
      await input.management.reauthorize();
      const currentIdentity = input.identity();
      if (!currentIdentity || currentIdentity.instanceId !== identity.instanceId || currentIdentity.environment !== identity.environment
        || input.management.resource.companyId !== input.companyId || !input.management.decision.allowed || input.management.decision.action !== "connections:configure")
        throw forbidden("Current Cloud or management authority changed");
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
      const updated = await tx.update(chatActions).set({ status: "issued", result: { ...row.result,
        firstFailureCode: row.result.firstFailureCode ?? row.result.failureCode, nextAttemptAt: new Date().toISOString() }, updatedAt: new Date() })
        .where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, input.companyId), eq(chatActions.endpointId, endpoint.id),
          sql`${chatActions.payload} = ${JSON.stringify(row.payload)}::jsonb`, sql`${chatActions.result} = ${JSON.stringify(row.result)}::jsonb`)).returning({ id: chatActions.id });
      if (updated.length !== 1) throw conflict("Retirement work changed before retry was committed");
      return { actionId: row.id, state: "scheduled" as const };
    }
    const binding = parseSlackFormBinding(row.payload.binding), proof = parseSlackFormProofAcceptance(row.result?.cloudProofAcceptance), work = parseSlackFormAckWork(row.result?.formAck);
    if (binding.companyId !== input.companyId || binding.endpointId !== endpoint.id || binding.publicId !== endpoint.publicId || binding.connectionId !== endpoint.connectionId
      || binding.instanceId !== identity.instanceId || row.payload.environment !== identity.environment || !sameSlackFormBinding(proof.binding, binding)
      || proof.appReceiptId !== row.id || proof.operationId !== row.payload.operationId || work.deliveryId !== `slack_form_${proof.operationId}`
      || !["submitted", "closed", "not_opened"].includes(String(row.result?.phase))) throw conflict("Retained form responsibility does not match current Cloud authority");
    if (work.receipt && (work.receipt.appReceiptId !== row.id || work.receipt.operationId !== proof.operationId
      || !sameSlackFormBinding(work.receipt.binding, binding) || work.receipt.terminalDigest !== proof.terminalDigest)) throw conflict("Retained form receipt changed");
    if (work.phase === "transferred") {
      if (row.status === "attention" || row.result?.nextAttemptAt !== null) throw conflict("Completed provider work has inconsistent retained status");
      return { actionId: row.id, state: "complete" as const };
    }
    if (typeof row.result?.nextAttemptAt === "string" && Number.isFinite(Date.parse(row.result.nextAttemptAt))) return { actionId: row.id, state: "already_scheduled" as const };
    if (row.status !== "attention" || row.result?.nextAttemptAt !== null) throw conflict("Provider work has no valid retained retry state");
    await input.management.reauthorize();
    const currentIdentity = input.identity();
    if (!currentIdentity || currentIdentity.instanceId !== identity.instanceId || currentIdentity.environment !== identity.environment
      || input.management.resource.companyId !== input.companyId || !input.management.decision.allowed || input.management.decision.action !== "connections:configure")
      throw forbidden("Current Cloud or management authority changed");
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
    const nextAttemptAt = new Date().toISOString();
    const phase = row.result?.phase, status = phase === "submitted" ? "processed" : phase === "not_opened" ? "failed" : "cancelled";
    const updated = await tx.update(chatActions).set({ status, result: { ...row.result, firstFailureCode: row.result?.firstFailureCode ?? row.result?.failureCode,
      nextAttemptAt }, updatedAt: new Date() }).where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, input.companyId), eq(chatActions.endpointId, endpoint.id),
      sql`${chatActions.payload} = ${JSON.stringify(row.payload)}::jsonb`, sql`${chatActions.result} = ${JSON.stringify(row.result)}::jsonb`)).returning({ id: chatActions.id });
    if (updated.length !== 1) throw conflict("Provider work changed before retry was committed");
    return { actionId: row.id, state: "scheduled" as const };
  });
  if (result.state === "scheduled") await logActivity(db, { ...input.management.audit, companyId: input.companyId, action: "chat_provider_work.retry_requested",
    entityType: "tool_connection", entityId: input.management.resource.connectionId ?? input.endpointId, details: { endpointId: input.endpointId, actionId: input.actionId } });
  return result;
}
