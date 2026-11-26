import { createHash } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { spekoToolDefinitions } from "./speko-protocol.js";
import { createSpekoProvider, SpekoProviderError } from "./speko-provider.js";

/** Called while the existing connection credential lease is held. */
export async function configureSpekoSessionTools(db: Db, input: {
  companyId: string; endpointId: string; agentId: string; callbackUrl: string; signingSecret: string;
  previousSigningSecret?: string;
  client: ReturnType<typeof createSpekoProvider>; assertOwned(): Promise<void>;
}) {
  const definitions = spekoToolDefinitions(input.callbackUrl);
  let tools = await input.client.listTools(input.agentId);
  // Speko provisions knowledge-base search on fresh personas and always
  // enables hangup. These built-ins are not foreign application integrations.
  const defaultBuiltins = new Set(["search_knowledge_base", "end_call"]);
  if (tools.some((tool) => !(tool.source.kind === "builtin" && defaultBuiltins.has(tool.name)) && !definitions.some((definition) => definition.name === tool.name))) {
    throw conflict("Choose a dedicated Speko voice agent with no unrelated tools");
  }
  for (const definition of definitions) {
    await input.assertOwned();
    const matches = tools.filter((tool) => tool.name === definition.name);
    if (matches.length > 1) throw conflict("Remove duplicate Speko session tools before reconnecting");
    const existing = matches[0];
    // The endpoint owns a persona, but must not silently reroute a tool which
    // was explicitly configured for another application.
    if (existing && (existing.source.kind !== "webhook" || existing.source.url !== definition.source.url)) {
      // A test tunnel may change origins. Reroute only a tool whose exact old
      // definition and provider ID have a completed receipt on this endpoint.
      const oldDefinition = existing.source.kind === "webhook" && existing.source.url
        ? spekoToolDefinitions(existing.source.url).find(tool => tool.name === definition.name) : null;
      const oldFingerprint = oldDefinition && createHash("sha256").update(JSON.stringify({agentId: input.agentId, definition: oldDefinition, signingSecret: input.previousSigningSecret ?? input.signingSecret})).digest("hex");
      const oldDefinitionHash = oldDefinition && createHash("sha256").update(JSON.stringify(oldDefinition)).digest("hex");
      const [owned] = oldFingerprint ? await db.select().from(chatActions).where(and(
        eq(chatActions.companyId, input.companyId), eq(chatActions.endpointId, input.endpointId),
        eq(chatActions.kind, "speko_tool_setup"), eq(chatActions.status, "completed"),
        sql`${chatActions.result}->>'toolId' = ${existing.id}`,
        or(eq(chatActions.providerActionId, `speko_tool:${definition.name}:${oldFingerprint}`),
          and(sql`${chatActions.payload}->>'ownershipAgentId' = ${input.agentId}`,
            sql`${chatActions.payload}->>'ownershipDefinitionHash' = ${oldDefinitionHash}`))
      )).limit(1) : [];
      if (owned?.status !== "completed" || owned.result?.toolId !== existing.id) {
        throw conflict("This Speko voice agent has tools connected elsewhere. Choose a dedicated voice agent.");
      }
      // Upgrade legacy proof before changing the provider callback. A failed
      // PATCH/retry no longer depends on the secret being replaced.
      await input.assertOwned();
      await db.update(chatActions).set({payload: {...owned.payload, ownershipAgentId: input.agentId,
        ownershipDefinitionHash: oldDefinitionHash}, updatedAt: new Date()}).where(eq(chatActions.id, owned.id));
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ agentId: input.agentId, definition, signingSecret: input.signingSecret })).digest("hex");
    const actionId = `speko_tool:${definition.name}:${fingerprint}`;
    let [action] = await db.select().from(chatActions).where(and(eq(chatActions.companyId, input.companyId), eq(chatActions.endpointId, input.endpointId), eq(chatActions.providerActionId, actionId)));
    if (action && action.status !== "failed" && !existing) throw conflict("A previous Speko tool setup has an uncertain outcome. Inspect the voice agent's tools before reconnecting.");
    if (!action) {
      [action] = await db.insert(chatActions).values({ companyId: input.companyId, endpointId: input.endpointId, kind: "speko_tool_setup", providerActionId: actionId, status: "processing", payload: { name: definition.name, fingerprint, ownershipAgentId: input.agentId, ownershipDefinitionHash: createHash("sha256").update(JSON.stringify(definition)).digest("hex") } }).returning();
    }
    // A recovered matching tool is repaired with an idempotent PATCH. GET does
    // not expose the secret, so presence alone cannot verify the signing key.
    await input.assertOwned();
    await db.update(chatActions).set({ status: "processing", updatedAt: new Date() }).where(eq(chatActions.id, action.id));
    let receipt: { id: string };
    try {
      receipt = await input.client.configureTool(input.agentId, definition, input.signingSecret, existing?.id);
    } catch (error) {
      // Only a definitive rejection permits another POST. A timeout may already
      // have created the tool and must first be reconciled by its name and URL.
      if (error instanceof SpekoProviderError && !error.outcomeUnknown) {
        await db.update(chatActions).set({ status: "failed", updatedAt: new Date() }).where(eq(chatActions.id, action.id));
      }
      throw error;
    }
    await input.assertOwned();
    await db.update(chatActions).set({ status: "completed", result: { toolId: receipt.id }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
    tools = await input.client.listTools(input.agentId);
  }
  const callback = new URL(input.callbackUrl); callback.pathname = callback.pathname.replace(/\/tools$/, "/events");
  await input.assertOwned();
  const hooks = await input.client.listWebhooks();
  const scoped = hooks.filter(hook => hook.allAgents || hook.agentIds.includes(input.agentId));
  const matching = [] as typeof scoped;
  for (const hook of scoped) {
    if (hook.allAgents || hook.agentIds.length !== 1 || Object.keys(hook.filterTags).length) continue;
    if (hook.url === callback.href) { matching.push(hook); continue; }
    const oldFingerprint = createHash("sha256").update(JSON.stringify({agentId: input.agentId, url: hook.url, secret: input.previousSigningSecret ?? input.signingSecret})).digest("hex");
    const [owned] = await db.select().from(chatActions).where(and(
      eq(chatActions.companyId, input.companyId), eq(chatActions.endpointId, input.endpointId),
      eq(chatActions.kind, "speko_lifecycle_setup"), eq(chatActions.status, "completed"),
      sql`${chatActions.result}->>'webhookId' = ${hook.id}`,
      or(eq(chatActions.providerActionId, `speko_lifecycle:${oldFingerprint}`),
        and(sql`${chatActions.payload}->>'ownershipAgentId' = ${input.agentId}`,
          sql`${chatActions.payload}->>'ownershipUrl' = ${hook.url}`))
    )).limit(1);
    if (owned) {
      await input.assertOwned();
      await db.update(chatActions).set({payload: {...owned.payload, ownershipAgentId: input.agentId, ownershipUrl: hook.url}, updatedAt: new Date()}).where(eq(chatActions.id, owned.id));
      matching.push(hook);
    }
  }
  if (matching.length > 1 || scoped.some(hook => hook.events.includes("call.pre_call") && !matching.includes(hook))) throw conflict("This Speko persona already has another pre-call webhook. Use a dedicated voice persona.");
  const fingerprint = createHash("sha256").update(JSON.stringify({ agentId: input.agentId, url: callback.href, secret: input.signingSecret })).digest("hex");
  const actionId = `speko_lifecycle:${fingerprint}`;
  const [previous] = await db.select().from(chatActions).where(and(eq(chatActions.companyId, input.companyId), eq(chatActions.endpointId, input.endpointId), eq(chatActions.providerActionId, actionId)));
  if (previous && previous.status !== "failed" && !matching.length) throw conflict("Speko webhook setup has an uncertain outcome. Inspect Webhooks in Speko before reconnecting.");
  const action = previous ?? (await db.insert(chatActions).values({companyId: input.companyId, endpointId: input.endpointId, kind: "speko_lifecycle_setup", providerActionId: actionId, status: "processing", payload: { fingerprint, ownershipAgentId: input.agentId, ownershipUrl: callback.href }}).returning())[0]!;
  await input.assertOwned();
  try {
    const receipt = await input.client.configureWebhook(input.agentId, callback.href, input.signingSecret, matching[0]?.id);
    await input.assertOwned();
    await db.update(chatActions).set({ status: "completed", result: { webhookId: receipt.id }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
  } catch (error) {
    if (error instanceof SpekoProviderError && !error.outcomeUnknown) await db.update(chatActions).set({ status: "failed", updatedAt: new Date() }).where(eq(chatActions.id, action.id));
    throw error;
  }
  await input.assertOwned();
  await input.client.configureVoiceDefaults(input.agentId);
  await input.assertOwned();

}
