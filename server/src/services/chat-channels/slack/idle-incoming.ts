import { isDeepStrictEqual } from "node:util";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { chatActions, chatEndpoints, toolConnections, type Db } from "@paperclipai/db";
import type { VerifiedIdleCapabilities } from "../../idle-incoming-wake-capability.js";
import { parseSlackFormBinding, parseSlackFormPublicEnrollment, slackFormSetupRecord, sameSlackFormBinding } from "./cloud-forms.js";
import { matchSlackConfiguredCoverage, type SlackConfiguredRequirement } from "./configured-coverage.js";
import { createSlackFormHistoryClassifier, type SlackFormHistoryRow } from "./form-idle-history.js";
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
type SlackIncomingRowsInput = {
  endpoints: readonly { endpoint: SlackIdleEndpoint; connection: SlackIdleConnection }[]; actions: readonly SlackFormHistoryRow[];
  capabilities: VerifiedIdleCapabilities; identity: SlackFormConnectorIdentity; registeredOptions(endpointId: string): boolean; check?(): void;
};
function slackIncomingContext(input: SlackIncomingRowsInput) {
  if (input.endpoints.length > 1000 || !input.capabilities.incomingWake?.routes.includes("slack-broker-events-v1")) return;
  const requirements: SlackConfiguredRequirement[] = [], endpointIds = new Set<string>(), currentOwners = new Map<string, SlackFormHistoryRow>();
  const groups = groupHistory(input.actions);
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
      const owners = (groups.get(`${endpoint.companyId}:${endpoint.id}`) ?? []).filter(row => row.companyId === endpoint.companyId && row.endpointId === endpoint.id && row.kind === "slack_form_owner"
        && /^slack-form-owner:[a-f0-9]{64}$/.test(row.providerActionId) && row.result?.phase === "enrolled" && row.result.nextAttemptAt === null && row.result.desiredActive !== false && ["issued", "processed"].includes(row.status)
        && row.payload.environment === input.identity.environment && row.payload.subject === setup.slackCloudSubject
        && isDeepStrictEqual(row.payload.binding, binding) && isDeepStrictEqual(row.payload.enrollment, enrollment));
      if (owners.length !== 1) return;
      currentOwners.set(owners[0]!.id, owners[0]!);
      requirements.push({ binding, capabilities: { actions: flag(capabilities, "actions"), modals: flag(capabilities, "modals"), slashCommands: flag(capabilities, "slashCommands") }, registeredOptions });
    }
    const expected = { ...input.identity, generation: input.capabilities.incomingWake.generation };
    const matched = matchSlackConfiguredCoverage(requirements, input.capabilities, expected);
    return { requirements, expected, matched, currentOwners };
  } catch { return; }
}

function groupHistory(rows: readonly SlackFormHistoryRow[]) {
  const groups = new Map<string, SlackFormHistoryRow[]>();
  for (const row of rows) {
    const key = `${row.companyId}:${row.endpointId}`, group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  return groups;
}
function projection(context: NonNullable<ReturnType<typeof slackIncomingContext>>, completed: Set<string>): SlackIdleIncomingProjection {
  return Object.freeze({ endpointIds: Object.freeze([...(context.matched?.endpointIds ?? [])]),
    connectionIds: Object.freeze([...(context.matched?.connectionIds ?? [])]), completedActionIds: Object.freeze([...completed].sort()) });
}
export function projectSlackIdleIncomingRows(input: SlackIncomingRowsInput): SlackIdleIncomingProjection | undefined {
  try {
    const context = slackIncomingContext(input);
    if (!context) return;
    const classify = createSlackFormHistoryClassifier({ requirements: context.requirements, verified: input.capabilities, expected: context.expected, currentOwners: context.currentOwners });
    const groups = groupHistory(input.actions), completed = new Set<string>();
    for (const { endpoint } of input.endpoints) {
      input.check?.();
      for (const id of classify(groups.get(`${endpoint.companyId}:${endpoint.id}`) ?? [], endpoint.companyId, endpoint.id, input.check)) {
        if (!uuid.test(id)) return; completed.add(id);
      }
    }
    return projection(context, completed);
  } catch { return; }
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const pageSize = 1000;
const historyOpen = alias(chatActions, "slack_idle_history_open"), historySubmit = alias(chatActions, "slack_idle_history_submit");
const relatedId = (key: "openActionRowId" | "submitActionRowId") => sql`CASE
  WHEN ${chatActions.payload}->>${key} ~* '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$'
  THEN (${chatActions.payload}->>${key})::uuid ELSE NULL END`;

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
  // Retain only bounded current-owner candidates. Old enrolled generations do
  // not become current coverage, and duplicate exact owners on ANY page fail.
  const endpointsById = new Map(endpoints.map(value => [value.endpoint.id, value]));
  const currentOwners = new Map<string, SlackFormHistoryRow[]>();
  let ownerCursor: string | undefined;
  for (;;) {
    await input.beforeRead();
    const page = await tx.select({ action: chatActions }).from(chatActions).innerJoin(chatEndpoints,
      and(eq(chatEndpoints.id, chatActions.endpointId), eq(chatEndpoints.companyId, chatActions.companyId)))
      .where(and(eq(chatEndpoints.provider, "slack"), inArray(chatActions.endpointId, endpoints.map(value => value.endpoint.id)),
        eq(chatActions.kind, "slack_form_owner"), sql`${chatActions.result}->>'phase'='enrolled'`,
        ownerCursor ? gt(chatActions.id, ownerCursor) : undefined))
      .orderBy(chatActions.id).limit(pageSize);
    input.remaining();
    for (const { action } of page) {
      input.remaining();
      const scope = endpointsById.get(action.endpointId);
      if (!scope || action.companyId !== scope.endpoint.companyId || scope.endpoint.status !== "active"
        || scope.connection.status !== "active" || !scope.connection.enabled) continue;
      try {
        const setup = slackFormSetupRecord(scope.endpoint.setup), binding = parseSlackFormBinding(setup.slackCloudForms);
        if (!/^slack-form-owner:[a-f0-9]{64}$/.test(action.providerActionId) || !["issued", "processed"].includes(action.status)
          || action.result?.nextAttemptAt !== null || action.result.desiredActive === false || action.payload.environment !== input.identity.environment
          || action.payload.subject !== setup.slackCloudSubject || !sameSlackFormBinding(parseSlackFormBinding(action.payload.binding), binding)) continue;
        const enrollment = parseSlackFormPublicEnrollment(action.payload.enrollment);
        const { credentialFingerprint: _, eventBindingId, ...base } = binding;
        if (!isDeepStrictEqual({ ...base, bindingId: eventBindingId }, enrollment)) continue;
        const owners = currentOwners.get(action.endpointId) ?? [];
        owners.push(action); if (owners.length > 1) return;
        currentOwners.set(action.endpointId, owners);
      } catch { continue; }
    }
    if (page.length < pageSize) break;
    ownerCursor = page.at(-1)!.action.id;
  }
  const common = { endpoints, capabilities: input.capabilities, identity: input.identity,
    registeredOptions: input.registeredOptions, check: () => { input.remaining(); } };
  const context = slackIncomingContext({ ...common, actions: [...currentOwners.values()].flat() });
  if (!context) return;
  const classify = createSlackFormHistoryClassifier({ requirements: context.requirements, verified: input.capabilities, expected: context.expected, currentOwners: context.currentOwners });
  const completed = new Set<string>(); let cursor: string | undefined;
  for (;;) {
    await input.beforeRead();
    // Indexed primary-key joins supply only the two referenced actions. A
    // session/page boundary never requires an all-history JSON accumulator or
    // one extra read per historical session.
    const page = await tx.select({ action: chatActions, open: historyOpen, submit: historySubmit }).from(chatActions)
      .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatActions.endpointId), eq(chatEndpoints.companyId, chatActions.companyId)))
      .leftJoin(historyOpen, and(eq(chatActions.kind, "slack_form_session"), eq(historyOpen.kind, "question_form_open"), eq(historyOpen.id, relatedId("openActionRowId")), eq(historyOpen.companyId, chatActions.companyId), eq(historyOpen.endpointId, chatActions.endpointId)))
      .leftJoin(historySubmit, and(eq(chatActions.kind, "slack_form_session"), eq(historySubmit.kind, "question_form_submit"), eq(historySubmit.id, relatedId("submitActionRowId")), eq(historySubmit.companyId, chatActions.companyId), eq(historySubmit.endpointId, chatActions.endpointId)))
      .where(and(eq(chatEndpoints.provider, "slack"), inArray(chatActions.endpointId, endpoints.map(value => value.endpoint.id)),
        inArray(chatActions.kind, ["slack_form_owner", "slack_form_grant", "slack_form_session", "question_form_open", "question_form_submit"]),
        cursor ? gt(chatActions.id, cursor) : undefined)).orderBy(chatActions.id).limit(pageSize);
    input.remaining();
    const groups = groupHistory(page.flatMap(row => [row.action, ...(row.open ? [row.open] : []), ...(row.submit ? [row.submit] : [])]));
    for (const rows of groups.values()) {
      input.remaining(); const first = rows[0]!;
      for (const id of classify(rows, first.companyId, first.endpointId, () => { input.remaining(); })) {
        if (!uuid.test(id)) return; completed.add(id);
      }
    }
    if (page.length < pageSize) break;
    cursor = page.at(-1)!.action.id;
  }
  input.remaining();
  return projection(context, completed);
}
