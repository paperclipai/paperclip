import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { forbidden, HttpError } from "../../errors.js";
import { captureRunIdentity } from "../run-identity.js";
import { chatVoiceCallbacks, instanceUserRoles, companyMemberships } from "@paperclipai/db";
import type { VoiceCaller } from "./voice-session-store.js";
import { z } from "zod";
import { instanceSettingsService } from "../instance-settings.js";
const SPEKO_TOOLS = [{ name: "call_my_phone", description: "Call the responsible person's saved phone number to discuss this task with the assigned Paperclip agent. Requires that person's callback opt-in. Never chooses another recipient, cancels work or grants approvals. Do not redial an uncertain attempt.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "write", scopes: [] }] as const;
type SpekoTaskSession = Pick<ToolGatewaySession, "companyId" | "agentId" | "runId" | "issueId" | "identityContextId">;
interface Binding { companyId: string; endpointId: string; issueId: string; caller: VoiceCaller }
const runtimes = new WeakMap<Db, (binding: Binding, invocationId: string) => Promise<unknown>>();
export function registerSpekoVoiceRuntime(db: Db, start: (binding: Binding, invocationId: string) => Promise<unknown>) {
  runtimes.set(db, start);
  return () => { if (runtimes.get(db) === start) runtimes.delete(db); };
}
async function resolveAuthority(db: Db, session: SpekoTaskSession, endpointId: string) {
  if (!(await instanceSettingsService(db).getExperimental()).enableChatConnectors) throw forbidden("Voice connections are disabled");
  if (!runtimes.has(db) || !session.agentId || !session.runId || !session.issueId) throw forbidden("Speko tools require an active task run");
  const { run, context } = await captureRunIdentity(db, { companyId: session.companyId, agentId: session.agentId, runId: session.runId });
  if ((run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) !== session.issueId || !run.responsibleUserId || session.identityContextId && session.identityContextId !== context?.id) throw forbidden("The accepted requester or task changed");
  const [endpoint] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.companyId, session.companyId), eq(chatEndpoints.id, endpointId), eq(chatEndpoints.provider, "speko"), eq(chatEndpoints.assignedAgentId, session.agentId), eq(chatEndpoints.status, "active")));
  if (!endpoint) throw forbidden("This agent has no active Speko connection");
  const userId = run.responsibleUserId;
  const [preference] = await db.select().from(chatVoiceCallbacks).where(and(eq(chatVoiceCallbacks.companyId, session.companyId), eq(chatVoiceCallbacks.endpointId, endpointId), eq(chatVoiceCallbacks.userId, userId), eq(chatVoiceCallbacks.enabled, true)));
  if (!preference) throw forbidden("The responsible person has not enabled phone callbacks");
  const [admin] = await db.select({ id: instanceUserRoles.id }).from(instanceUserRoles).where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));
  const [member] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(eq(companyMemberships.companyId, session.companyId), eq(companyMemberships.principalId, userId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active")));
  // Local authority is rechecked by the live service, never supplied by model arguments.
  if (!admin && !member && userId !== "local-board") throw forbidden("The responsible person no longer has company access");
  const caller: VoiceCaller = { id: userId, authority: admin ? "instance_admin" : userId === "local-board" ? "local_board" : "member" };
  return { endpoint, caller };
}
export async function executeSpekoVoiceTool(db: Db, session: SpekoTaskSession, endpointId: string, parameters: unknown, invocationId?: string) {
  z.object({}).strict().parse(parameters);
  if (!invocationId || !z.string().uuid().safeParse(invocationId).success) throw forbidden("A durable invocation is required for phone calls");
  const authority = await resolveAuthority(db, session, endpointId);
  return runtimes.get(db)!({ companyId: session.companyId, endpointId, issueId: session.issueId!, caller: authority.caller }, invocationId);
}
import {
  chatEndpoints,
  toolConnections,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolProfiles,
  toolProfileEntries,
  toolProfileBindings,
  type Db,
} from "@paperclipai/db";
import type {
  ToolGatewayDescriptor,
  ToolGatewaySession,
} from "../tool-gateway.js";
export async function syncSpekoVoiceTools(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  endpoint: typeof chatEndpoints.$inferSelect,
  userId: string,
  enabled = true,
) {
  const [connection] = await tx
    .select()
    .from(toolConnections)
    .where(
      and(
        eq(toolConnections.companyId, endpoint.companyId),
        eq(toolConnections.id, endpoint.connectionId),
      ),
    );
  if (!connection) return;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`speko-catalog:${endpoint.id}`}, 0))`,
  );
  const existingEntries = await tx
    .select()
    .from(toolCatalogEntries)
    .where(eq(toolCatalogEntries.connectionId, connection.id));
  const entriesByName = new Map(
    existingEntries.map((entry) => [entry.name, entry]),
  );
  for (const tool of SPEKO_TOOLS) {
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          name: tool.name,
          inputSchema: tool.inputSchema,
          risk: tool.risk,
          scopes: tool.scopes,
        }),
      )
      .digest("hex");
    const values = {
      companyId: endpoint.companyId,
      applicationId: connection.applicationId,
      connectionId: connection.id,
      entryKind: "tool" as const,
      name: `speko_voice:${tool.name}`,
      toolName: tool.name,
      title: tool.description.split(".")[0],
      description: tool.description,
      inputSchema: tool.inputSchema,
      riskLevel: "write" as const,
      isReadOnly: false,
      isWrite: true,
      versionHash: hash,
      schemaHash: hash,
      status: enabled ? ("active" as const) : ("removed" as const),
      reviewedByUserId: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    };
    const existing = entriesByName.get(values.name);
    if (existing?.versionHash === hash) continue;
    await tx
      .insert(toolCatalogEntries)
      .values(values)
      .onConflictDoUpdate({
        target: [toolCatalogEntries.connectionId, toolCatalogEntries.name],
        set: {
          ...values,
          ...(existing
            ? {
                status: existing.status,
                reviewedByUserId: existing.reviewedByUserId,
                reviewedAt: existing.reviewedAt,
              }
            : {}),
        },
      });
  }
  const profileKey = `speko-voice:${endpoint.id}`;
  const [priorProfile] = await tx
    .select()
    .from(toolProfiles)
    .where(
      and(
        eq(toolProfiles.companyId, endpoint.companyId),
        eq(toolProfiles.profileKey, profileKey),
      ),
    );
  if (priorProfile) return;
  const [profile] = await tx
    .insert(toolProfiles)
    .values({
      companyId: endpoint.companyId,
      profileKey,
      name: `Speko voice ${endpoint.id}`,
      description: "Task-scoped tools using this bot's App connection",
      defaultAction: "deny",
      status: enabled ? "active" : "disabled",
      metadata: { spekoVoiceEndpointId: endpoint.id },
    })
    .onConflictDoUpdate({
      target: [toolProfiles.companyId, toolProfiles.profileKey],
      set: {
        description:
          "Task-scoped Speko tools; existing action policies remain in effect.",
      },
    })
    .returning();
  // Provision defaults once. Removing a binding/entry is an operator decision;
  // resolving a retained run must never restore revoked grants.
  if (enabled)
    await tx
      .insert(toolConnectionInstalls)
      .values({
        companyId: endpoint.companyId,
        connectionId: connection.id,
        targetType: "agent",
        targetId: endpoint.assignedAgentId,
        createdByUserId: userId,
      })
      .onConflictDoNothing();

  const [existingEntry] = await tx
    .select({ id: toolProfileEntries.id })
    .from(toolProfileEntries)
    .where(
      and(
        eq(toolProfileEntries.profileId, profile!.id),
        eq(toolProfileEntries.connectionId, connection.id),
      ),
    );
  if (!existingEntry)
    await tx
      .insert(toolProfileEntries)
      .values({
        companyId: endpoint.companyId,
        profileId: profile!.id,
        selectorType: "connection",
        connectionId: connection.id,
        effect: "include",
      })
      .onConflictDoNothing();
  await tx
    .insert(toolProfileBindings)
    .values({
      companyId: endpoint.companyId,
      profileId: profile!.id,
      targetType: "agent",
      targetId: endpoint.assignedAgentId,
      createdByUserId: userId,
      metadata: { spekoVoiceEndpointId: endpoint.id },
    })
    .onConflictDoNothing();
}

async function spekoToolsForEndpoint(db: Db, session: SpekoTaskSession, endpointId: string): Promise<ToolGatewayDescriptor[]> {
  let authority;
  try { authority = await resolveAuthority(db, session, endpointId); }
  catch (error) { if (error instanceof HttpError && [403, 404, 409].includes(error.status)) return []; throw error; }
  const entries = await db.select({ entry: toolCatalogEntries, applicationId: toolConnections.applicationId }).from(toolCatalogEntries)
    .innerJoin(toolConnections, eq(toolConnections.id, toolCatalogEntries.connectionId))
    .where(and(eq(toolCatalogEntries.companyId, session.companyId), eq(toolCatalogEntries.connectionId, authority.endpoint.connectionId), eq(toolCatalogEntries.status, "active"), isNull(toolCatalogEntries.quarantinedAt), eq(toolConnections.enabled, true), eq(toolConnections.status, "active")));
  return entries.filter(({entry}) => entry.toolName === "call_my_phone").map(({entry, applicationId}) => ({
    name: `speko-voice.${endpointId}:call_my_phone`, displayName: "Call my phone", description: entry.description ?? "", parametersSchema: entry.inputSchema,
    pluginId: `speko-voice:${endpointId}`, providerType: "paperclip_speko_voice", risk: "write", applicationId, applicationKey: "speko-voice",
    applicationDisplayName: "Speko voice", connectionId: authority.endpoint.connectionId, catalogEntryId: entry.id,
    upstreamToolName: "call_my_phone", providerMetadata: { endpointId },
  }));
}
export async function spekoToolsForSession(db: Db, session: SpekoTaskSession): Promise<ToolGatewayDescriptor[]> {
  if (!session.agentId || !session.runId || !session.issueId || !runtimes.has(db)) return [];
  const endpoints = await db.select({ id: chatEndpoints.id }).from(chatEndpoints).where(and(eq(chatEndpoints.companyId, session.companyId), eq(chatEndpoints.assignedAgentId, session.agentId), eq(chatEndpoints.provider, "speko"), eq(chatEndpoints.status, "active")));
  const tools: ToolGatewayDescriptor[] = [];
  for (const endpoint of endpoints) tools.push(...await spekoToolsForEndpoint(db, session, endpoint.id));
  return tools;
}

/** Instructions are assigned for browser voice as well as phone callbacks.
 * No caller phone number, provider identity, or credential enters the bundle. */
export async function spekoAssignedResources(db: Db, binding: { companyId: string; agentId: string }) {
  if (!(await instanceSettingsService(db).getExperimental()).enableChatConnectors) return [];
  return db.select({ id: chatEndpoints.id, connectionId: chatEndpoints.connectionId })
    .from(chatEndpoints)
    .innerJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, binding.companyId), eq(toolConnections.enabled, true), eq(toolConnections.status, "active")))
    .innerJoin(toolProfiles, and(eq(toolProfiles.companyId, binding.companyId), eq(toolProfiles.profileKey, sql`'speko-voice:' || ${chatEndpoints.id}::text`), eq(toolProfiles.status, "active")))
    .innerJoin(toolProfileBindings, and(eq(toolProfileBindings.companyId, binding.companyId), eq(toolProfileBindings.profileId, toolProfiles.id), eq(toolProfileBindings.targetType, "agent"), eq(toolProfileBindings.targetId, binding.agentId)))
    .innerJoin(toolProfileEntries, and(eq(toolProfileEntries.profileId, toolProfiles.id), eq(toolProfileEntries.connectionId, chatEndpoints.connectionId), eq(toolProfileEntries.effect, "include")))
    .where(and(eq(chatEndpoints.companyId, binding.companyId), eq(chatEndpoints.assignedAgentId, binding.agentId), eq(chatEndpoints.provider, "speko"), eq(chatEndpoints.status, "active")))
    .then(rows => rows.map(row => ({ ...row, label: "Speko voice" })));
}
