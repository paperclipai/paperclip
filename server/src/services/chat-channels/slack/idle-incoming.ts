import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chatActions, chatEndpoints, toolConnections, type Db } from "@paperclipai/db";
import type { VerifiedIdleCapabilities } from "../../idle-incoming-wake-capability.js";
import { parseSlackFormBinding, parseSlackFormPublicEnrollment, slackFormSetupRecord, sameSlackFormBinding } from "./cloud-forms.js";
import { matchSlackConfiguredCoverage, type SlackConfiguredRequirement } from "./configured-coverage.js";
import { completedSlackFormHistoryActionIds, type SlackFormHistoryRow } from "./form-idle-history.js";
import type { SlackFormConnectorIdentity } from "./cloud-consumer.js";

export type SlackIdleEndpoint = Pick<typeof chatEndpoints.$inferSelect, "id" | "companyId" | "connectionId" | "publicId" | "provider" | "status"> & { setup: unknown; capabilities: unknown };
export type SlackIdleConnection = Pick<typeof toolConnections.$inferSelect, "id" | "companyId" | "status" | "enabled" | "transport" | "connectionPurpose">;
export type SlackIdleIncomingProjection = Readonly<{ endpointIds: readonly string[]; connectionIds: readonly string[]; completedActionIds: readonly string[] }>;
export const slackHasRegisteredOptionsAtCurrentBuild = (_endpointId: string): boolean => false;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Slack idle object");
  return Object.fromEntries(Object.entries(value));
}
function flag(value: Record<string, unknown>, key: string): boolean {
  const v = value[key]; if (typeof v !== "boolean") throw new Error("Unknown Slack configured capability"); return v;
}
export function projectSlackIdleIncomingRows(input: {
  endpoints: readonly { endpoint: SlackIdleEndpoint; connection: SlackIdleConnection }[]; actions: readonly SlackFormHistoryRow[];
  capabilities: VerifiedIdleCapabilities; identity: SlackFormConnectorIdentity; registeredOptions(endpointId: string): boolean; check?(): void;
}): SlackIdleIncomingProjection | undefined {
  if (input.endpoints.length > 1000 || input.actions.length > 1000 || !input.capabilities.incomingWake?.routes.includes("slack-broker-events-v1")) return;
  const requirements: SlackConfiguredRequirement[] = [], endpointIds = new Set<string>();
  try {
    for (const { endpoint, connection } of input.endpoints) {
      input.check?.();
      if (endpoint.provider !== "slack" || endpoint.companyId !== connection.companyId || endpoint.connectionId !== connection.id || connection.transport !== "chat_sdk" || connection.connectionPurpose !== "channel" || endpointIds.has(endpoint.id)) return;
      endpointIds.add(endpoint.id);
      if (endpoint.status !== "active" || connection.status !== "active" || !connection.enabled) continue;
      const setup = slackFormSetupRecord(endpoint.setup), binding = parseSlackFormBinding(setup.slackCloudForms);
      const capabilities = object(endpoint.capabilities), registeredOptions = input.registeredOptions(endpoint.id);
      if (typeof registeredOptions !== "boolean" || setup.step !== "complete" || setup.slackCloudInstanceId !== binding.instanceId || setup.runtimeGeneration !== binding.runtimeGeneration
        || binding.instanceId !== input.identity.instanceId || binding.companyId !== endpoint.companyId || binding.endpointId !== endpoint.id
        || binding.connectionId !== connection.id || binding.publicId !== endpoint.publicId || typeof setup.slackCloudSubject !== "string") return;
      const descriptor = object(setup.slackCloudEvents), enrollment = parseSlackFormPublicEnrollment({ version: 1, instanceId: input.identity.instanceId,
        companyId: endpoint.companyId, endpointId: endpoint.id, publicId: endpoint.publicId, connectionId: endpoint.connectionId,
        runtimeGeneration: descriptor.runtimeGeneration, bindingId: descriptor.bindingId, teamId: descriptor.teamId, appId: descriptor.appId });
      const { credentialFingerprint: _, eventBindingId, ...base } = binding;
      if (!isDeepStrictEqual({ ...base, bindingId: eventBindingId }, enrollment)) return;
      const owners = input.actions.filter(row => row.companyId === endpoint.companyId && row.endpointId === endpoint.id && row.kind === "slack_form_owner"
        && /^slack-form-owner:[a-f0-9]{64}$/.test(row.providerActionId) && row.result?.phase === "enrolled" && row.result.nextAttemptAt === null && row.result.desiredActive !== false && ["issued", "processed"].includes(row.status)
        && row.payload.environment === input.identity.environment && row.payload.subject === setup.slackCloudSubject
        && isDeepStrictEqual(row.payload.binding, binding) && isDeepStrictEqual(row.payload.enrollment, enrollment));
      if (owners.length !== 1) return;
      requirements.push({ binding, capabilities: { actions: flag(capabilities, "actions"), modals: flag(capabilities, "modals"), slashCommands: flag(capabilities, "slashCommands") }, registeredOptions });
    }
    const expected = { ...input.identity, generation: input.capabilities.incomingWake.generation };
    const matched = matchSlackConfiguredCoverage(requirements, input.capabilities, expected);
    const completed = new Set<string>();
    for (const { endpoint } of input.endpoints) {
      input.check?.();
      const ids = completedSlackFormHistoryActionIds(input.actions, endpoint.companyId, endpoint.id,
        { requirements, verified: input.capabilities, expected });
      for (const id of ids) { if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) return; completed.add(id); }
    }
    return Object.freeze({ endpointIds: Object.freeze([...(matched?.endpointIds ?? [])]), connectionIds: Object.freeze([...(matched?.connectionIds ?? [])]), completedActionIds: Object.freeze([...completed].sort()) });
  } catch { return; }
}
export async function readSlackIdleIncomingProof(tx: Pick<Db, "select">, input: {
  capabilities?: VerifiedIdleCapabilities; identity?: SlackFormConnectorIdentity; receiverBound: boolean;
  beforeRead(): Promise<void>; remaining(): number; registeredOptions(endpointId: string): boolean;
}): Promise<SlackIdleIncomingProjection | undefined> {
  if (!input.capabilities?.incomingWake?.routes.includes("slack-broker-events-v1") || !input.identity || !input.receiverBound) return;
  const broker = input.capabilities.incomingWake.slackBroker;
  if (!broker || broker.instanceId !== input.identity.instanceId || broker.generation !== input.capabilities.incomingWake.generation) return;
  await input.beforeRead();
  const endpoints = await tx.select({ endpoint: chatEndpoints, connection: toolConnections }).from(chatEndpoints).innerJoin(toolConnections,
    and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatEndpoints.companyId)))
    .where(and(eq(chatEndpoints.provider, "slack"), eq(toolConnections.transport, "chat_sdk"), eq(toolConnections.connectionPurpose, "channel"),
      sql`exists (select 1 from companies where id=${chatEndpoints.companyId} and status <> 'archived')`)).orderBy(chatEndpoints.id).limit(1001);
  input.remaining(); if (endpoints.length > 1000) return;
  if (!endpoints.length && broker.entries.length) return;
  if (!endpoints.length) return Object.freeze({ endpointIds: [], connectionIds: [], completedActionIds: [] });
  await input.beforeRead();
  const actions = await tx.select({ action: chatActions }).from(chatActions).innerJoin(chatEndpoints,
    and(eq(chatEndpoints.id, chatActions.endpointId), eq(chatEndpoints.companyId, chatActions.companyId)))
    .where(and(eq(chatEndpoints.provider, "slack"), inArray(chatActions.endpointId, endpoints.map(value => value.endpoint.id)),
      inArray(chatActions.kind, ["slack_form_owner", "slack_form_grant", "slack_form_session", "question_form_open", "question_form_submit"])))
    .orderBy(chatActions.id).limit(1001);
  input.remaining(); if (actions.length > 1000) return;
  const projection = projectSlackIdleIncomingRows({ endpoints, actions: actions.map(row => row.action), capabilities: input.capabilities,
    identity: input.identity, registeredOptions: input.registeredOptions, check: () => { input.remaining(); } });
  input.remaining();
  return projection;
}
