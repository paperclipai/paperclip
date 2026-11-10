import { retainSlackFormOpeningProof } from "./form-opening-proof.js";
import { and, eq, sql } from "drizzle-orm";
import { chatActions, chatEndpoints, toolConnections, type Db } from "@paperclipai/db";
import type { chatCredentialMutationLease } from "../../chat-credential-mutation-lease.js";
import type { createChatCredentials } from "../credentials.js";
import { SlackCloudReceiptError, type SlackCloudEvent } from "./cloud-event.js";
import { slackFormSetupRecord, currentSlackFormOwnerBinding, parseSlackFormOperation, sameSlackFormBinding, lookupSlackFormDelivery, withSlackFormOpenContext,
  type SlackFormDeliveryAuthority } from "./cloud-forms.js";
import { slackFormConnectorIdentity } from "./cloud-consumer.js";
import { acceptSlackFormClosed, acceptSlackFormNoEffect, acceptSlackFormTerminalProof, readSlackFormTerminalIntent, readSlackFormTerminalRequest } from "./form-session.js";
import type { SlackFormProtocol } from "./form-owner.js";
import { resolveSlackCloudSigningSecret } from "./cloud-signing-secret.js";

export function createSlackFormDeliveryOwner(db: Db, options: {
  connector(): unknown; protocol: SlackFormProtocol;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  resolveCredentials: ReturnType<typeof createChatCredentials>["resolveCredentials"];
  webhookUrl(publicId: string): string;
  handleWebhook(publicId: string, request: Request, generation: number, acceptedAt: number): Promise<Response>;
}) {
  return async (event: SlackCloudEvent): Promise<void> => {
    const identity = slackFormConnectorIdentity(options.connector());
    if (!identity) throw new SlackCloudReceiptError("form_connector_identity_unavailable", "attention");
    const packet = event.payload.slackFormOpen;
    if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new SlackCloudReceiptError("form_receipt_invalid", "invalid");
    const original = parseSlackFormOperation(Reflect.get(packet, "operation")), binding = original.binding;
    if (binding.instanceId !== identity.instanceId || Reflect.get(packet, "environment") !== identity.environment) throw new SlackCloudReceiptError("form_instance_changed", "attention");
    const [endpoint] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, binding.endpointId), eq(chatEndpoints.companyId, binding.companyId))).limit(1);
    if (!endpoint || endpoint.provider !== "slack") throw new SlackCloudReceiptError("form_endpoint_custody_missing", "attention");
    let authority: SlackFormDeliveryAuthority;
    const local = currentSlackFormOwnerBinding(slackFormSetupRecord(endpoint.setup));
    if (local && sameSlackFormBinding(local, binding) && ["active", "verifying", "attention"].includes(endpoint.status)) {
      const signingSecret = await options.withCredentialMutationLease(endpoint, async lease => {
        const [current] = await db.select({ endpoint: chatEndpoints, connection: toolConnections }).from(chatEndpoints)
          .innerJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatEndpoints.companyId)))
          .where(and(eq(chatEndpoints.id, binding.endpointId), eq(chatEndpoints.companyId, binding.companyId))).limit(1);
        const owner = current && currentSlackFormOwnerBinding(slackFormSetupRecord(current.endpoint.setup));
        if (!current || !owner || !sameSlackFormBinding(owner, binding) || !["active", "verifying", "attention"].includes(current.endpoint.status)
          || current.connection.status !== "active" || !current.connection.enabled) throw new SlackCloudReceiptError("form_current_authority_changed", "attention");
        const secret = await resolveSlackCloudSigningSecret(options.resolveCredentials, current.endpoint, db, ["signingSecret"]);
        await lease.assertOwned(); return secret;
      });
      authority = { kind: "current", binding, ...identity, signingSecret };
    } else {
      const [owner] = await db.select().from(chatActions).where(and(eq(chatActions.companyId, binding.companyId), eq(chatActions.endpointId, binding.endpointId),
        sql`${chatActions.kind} in ('slack_form_owner','slack_form_session')`, sql`${chatActions.payload}->'binding' = ${JSON.stringify(binding)}::jsonb`,
        sql`${chatActions.payload}->>'environment' = ${identity.environment}`)).limit(1);
      if (!owner) throw new SlackCloudReceiptError("form_retained_owner_missing", "attention");
      authority = { kind: "retained", binding, ...identity };
    }
    const lookup = await lookupSlackFormDelivery(event, authority, values => options.protocol({ subject: "github-bot-events", companyId: binding.companyId,
      operation: { kind: "receipt", ...values } }));
    const op = lookup.operation;
    let terminal = await readSlackFormTerminalRequest(db, binding, op.id);
    const actions = Reflect.get(lookup.originalPayload, "actions");
    const actionId = Array.isArray(actions) && actions.length === 1 && actions[0] && typeof actions[0] === "object" ? Reflect.get(actions[0], "action_id") : null;
    if (typeof actionId !== "string") throw new SlackCloudReceiptError("form_issued_action_invalid", "attention");
    if (!terminal && op.closed?.kind === "closed") await db.transaction(tx => acceptSlackFormClosed(tx, op, actionId, identity.environment));
    else if (!terminal && op.rejection) await db.transaction(tx => acceptSlackFormNoEffect(tx, op, actionId, identity.environment));
    else if (!terminal && authority.kind === "current" && op.phase === "confirmed" && !op.closed) {
      const rawBody = Reflect.get(packet, "rawBody"), timestamp = Reflect.get(packet, "timestamp"), signature = Reflect.get(packet, "signature");
      if (typeof rawBody !== "string" || typeof timestamp !== "string" || typeof signature !== "string") throw new SlackCloudReceiptError("form_original_invalid", "invalid");
      const url = new URL(options.webhookUrl(binding.publicId));
      if (!url.pathname.endsWith(`/api/chat-webhooks/${binding.publicId}/slack`)) throw new SlackCloudReceiptError("form_webhook_url_changed", "attention");
      const request = new Request(url, { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature }, body: Buffer.from(rawBody, "base64") });
      const response = await withSlackFormOpenContext(op, binding,
        () => options.handleWebhook(binding.publicId, request, binding.runtimeGeneration, Date.parse(op.acceptedAt)), identity.environment);
      if (!response.ok) throw new SlackCloudReceiptError("form_action_callback_failed", "retry");
    }
    terminal = await readSlackFormTerminalRequest(db, binding, op.id);
    if (!terminal) throw new SlackCloudReceiptError(op.phase === "confirmed" ? "form_view_active" : "form_resource_unresolved", op.phase === "confirmed" ? "retry" : "attention");
    const intent = await readSlackFormTerminalIntent(db, op);
    if (!intent || intent.deliveryId !== event.id) throw new SlackCloudReceiptError("form_terminal_intent_missing", "attention");
    const proof = await options.protocol({ subject: "github-bot-events", companyId: binding.companyId, operation: terminal });
    if (!proof || typeof proof !== "object" || Reflect.get(proof, "instanceId") !== identity.instanceId || Reflect.get(proof, "environment") !== identity.environment)
      throw new SlackCloudReceiptError("form_terminal_proof_invalid", "attention");
    const proven = parseSlackFormOperation(Reflect.get(proof, "operation"));
    await db.transaction(async tx => {
      await acceptSlackFormTerminalProof(tx, { intent, operation: Reflect.get(proof, "operation"), currentInstanceId: identity.instanceId });
      await retainSlackFormOpeningProof(tx, { companyId: binding.companyId, appReceiptId: intent.appReceiptId, operation: proven,
        original: { rawBody: Reflect.get(packet, "rawBody"), timestamp: Reflect.get(packet, "timestamp"), signature: Reflect.get(packet, "signature") } });
    });
  };
}
