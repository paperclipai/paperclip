import { expect } from "@playwright/test";
import type { ToolConnection, ToolProfileEffectiveSummary, ToolProfileWithDetails, ToolCatalogEntry } from "../../../packages/shared/src/types/tool-access.js";
import { externalRequirements, selectedExternalBinding } from "./external-fixtures.js";
import { verifyNotionWorkspace, connectNamedNotion } from "./external-notion-provider.js";
import { definition, root, checks, externalObservation, observeExternal, verifyRenderedReply } from "./external-support.js";
import { identityWorker, waitForReply, probeAgentPermission } from "./identity-support.js";
export function grantMorganGuidance(reply: string) {
  const clauses = reply.split(/[.!?;\n]+|\b(?:but|however|then)\b/i);
  const wrongAudience = clauses.some(clause => [...clause.matchAll(/\b(?:select|grant|assign|enable|give)\b.{0,55}\b(?:all agents|everyone|company-wide|company wide|Riley)\b/gi)].some(match => !/\b(?:do not|don.t|never|cannot|can.t|should not|must not)\s*$/i.test(clause.slice(0, match.index).trim())));
  return !wrongAudience && /Morgan/i.test(reply) && /Notion/i.test(reply) && /assign|access|permission/i.test(reply) && /human|board|operator|you can|settings|manage/i.test(reply)
    && !/\bI(?:['’]ve|\s+have)?\s+(?:already\s+)?(?:assigned|granted|enabled)\b|\bMorgan\s+(?:already\s+has|now\s+has|can\s+now)\b/i.test(reply);
}
export function gradeNotionAudience(value: unknown) {
  const c = checks(), o = externalObservation(value); c.add("complete-named-notion-audience-evidence", !!o, "Official disposable account identity, board-only audience changes, exact saved installs and effective action policy are required."); if (!o) return c.result();
  c.add("healthy-shared-notion-prerequisite", o.state.provider === "notion" && o.state.workspaceMatched === true && o.state.healthyBefore === true && o.state.agentAssignmentStatus === 403 && o.state.noMorganBefore === true, "A usable real Notion account exists; ordinary agent audience mutation is actually denied.");
  c.add("scoped-human-guidance-before-grant", grantMorganGuidance(o.reply) && o.state.noMutationBeforeHuman === true && o.state.humanManagementVisible === true && o.state.onlyMorganRequested === true && o.state.operatorChannel === "public-browser-agent-selection", "Actual initial guidance preserves Morgan-only scope before the authorized human assigns the existing account.");
  const installs = o.state.installsAfter as Array<{targetType: string; targetId: string}> | undefined, access = o.state.effectiveAfter as ToolProfileEffectiveSummary[] | undefined;
  const readIds = Array.isArray(o.state.readEntryIds) ? o.state.readEntryIds as string[] : [], writeIds = Array.isArray(o.state.writeEntryIds) ? o.state.writeEntryIds as string[] : [];
  c.add("only-morgan-effective-audience", !!installs && installs.length === 1 && installs[0]?.targetType === "agent" && installs[0]?.targetId === o.state.morganId
    && readIds.length > 0 && !!access && access.length === 3 && access.every(row => readIds.some(id => row.allowedTools.some(tool => tool.id === id)) === (row.agentId === o.state.morganId)) && o.state.connectionCountUnchanged === true,
    "The saved explicit audience contains only Morgan; real effective access excludes both the CEO and unrelated Riley, with no duplicate account.");
  c.add("action-policy-separate-and-preserved", o.state.appPolicyUnchanged === true && !!access && access.every(row => !writeIds.some(id => row.allowedTools.some(tool => tool.id === id))), "Changing the audience preserves exact saved action rules and keeps writes unavailable.");
  c.add("human-assignment-attribution", o.activity.some(row => row.entityId === o.state.connectionId && row.action === "tool_app.finished" && row.actorType === "user"), "The real public assignment carries human actor attribution.");
  return c.result();
}
export const notionAudienceExternalCases = [definition("app-permissions.grant-one-agent", async ctx => {
  const binding = selectedExternalBinding(ctx); await verifyNotionWorkspace(ctx, binding);
  const morgan = await identityWorker(ctx), riley = await identityWorker(ctx, "Riley"), connected = await connectNamedNotion(ctx, binding, []);
  const saved = await ctx.input.api.get<ToolConnection>(`/api/tool-connections/${connected.connectionId}`);
  if (!saved.enabled || saved.status !== "active" || saved.healthStatus !== "ok") throw new Error("Setup blocker: official disposable Notion account is not healthy");
  const catalog = await ctx.input.api.get<{ catalog: ToolCatalogEntry[] }>(`/api/tool-connections/${connected.connectionId}/catalog`);
  const writeEntryIds = catalog.catalog.filter(row => !connected.readEntryIds.includes(row.id)).map(row => row.id);
  if (!catalog.catalog.length) throw new Error("Setup blocker: real Notion account exposes no catalog actions");
  const current = await ctx.input.api.get<{ profiles: ToolProfileWithDetails[] }>(`${root(ctx)}/tools/profiles`);
  const policy = current.profiles.filter(row => row.profileKey === `app:${connected.connectionId}`);
  const effective = await ctx.input.api.get<ToolProfileEffectiveSummary>(`${root(ctx)}/tools/profiles/effective/agents/${morgan.id}`);
  if (connected.readEntryIds.some(id => effective.allowedTools.some(tool => tool.id === id))) throw new Error("Setup blocker: Morgan already has account access before the requested grant");
  const agentAssignmentStatus = await probeAgentPermission(ctx, `/api/tool-connections/${connected.connectionId}/installs`, "PUT", { installs: [{ targetType: "agent", targetId: morgan.id }] });
  await ctx.input.api.post(`${root(ctx)}/chats/${ctx.input.fixtures.agent.id}`); await ctx.refreshIssue();
  await ctx.input.api.patch(`/api/issues/${ctx.issue()!.id}`, { description: `Use the existing Launch Notion shared account (${connected.connectionId}). Intended consumer: Morgan (${morgan.id}), and nobody else. Riley (${riley.id}) and the CEO must not receive access. Keep the existing read-only action policy unchanged; an authorized human manages audience.` });
  return { ...connected, provider: "notion", workspaceMatched: true, healthyBefore: true, morganId: morgan.id, rileyId: riley.id, noMorganBefore: true, agentAssignmentStatus, writeEntryIds, appPolicyBefore: policy, connectionCountBefore: (await ctx.input.api.get<{connections: unknown[]}>(`${root(ctx)}/tools/connections`)).connections.length };
}, gradeNotionAudience, {
  authentication: "human-session", externalInput: externalRequirements["app-permissions.grant-one-agent"],
  sourceFiles: ["chat-catalog-domains/external-notion-audience.ts", "chat-catalog-domains/external-notion-provider.ts", "chat-catalog-domains/external-notion-semantics.ts", "chat-catalog-domains/external-fixtures.ts", "chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/identity-support.ts", "chat-scenarios/app-permissions.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx); const o = await observeExternal(ctx, state); if (!grantMorganGuidance(o.reply)) throw new Error("Chat guidance must preserve the requested Morgan-only Notion audience before human action");
    const before = await ctx.input.api.get<{installs: unknown[]}>(`/api/tool-connections/${state.connectionId}/installs`); state.noMutationBeforeHuman = before.installs.length === 0;
    const prefix = `/${ctx.input.fixtures.company.issuePrefix}/apps/${state.connectionId}`, href = o.links.find(link => { try { const url = new URL(link, o.origin); return url.origin === o.origin && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)); } catch { return false; } });
    if (!href) throw new Error("Existing Notion account management path missing"); const source = ctx.input.page.url();
    await ctx.input.page.goto(new URL(href, o.origin).href, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("main")).toContainText("Launch Notion"); state.humanManagementVisible = true;
    if (!ctx.input.page.url().endsWith("/permissions")) await ctx.input.page.goto(`${prefix}/permissions`, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("radio", {name:/Just agents I pick/})).toBeChecked();
    await ctx.input.page.getByRole("button", {name:"Choose agents",exact:true}).click();
    const completed = ctx.input.page.waitForResponse(response => new URL(response.url()).pathname === `${root(ctx)}/tools/apps/${state.connectionId}/finish` && response.request().method() === "POST" && response.ok());
    await ctx.input.page.getByRole("checkbox", {name:"Allow Morgan",exact:true}).check();
    const response = await completed, request = response.request().postDataJSON() as {access: {agentIds?: string[]}};
    state.onlyMorganRequested = Array.isArray(request.access.agentIds) && request.access.agentIds.length === 1 && request.access.agentIds[0] === state.morganId;
    state.operatorChannel = "public-browser-agent-selection";
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("button", {name:"1 agent selected",exact:true})).toBeVisible(); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) {
    state.installsAfter = (await ctx.input.api.get<{installs: unknown[]}>(`/api/tool-connections/${state.connectionId}/installs`)).installs;
    state.effectiveAfter = await Promise.all([state.morganId, state.rileyId, ctx.input.fixtures.agent.id].map(id => ctx.input.api.get<ToolProfileEffectiveSummary>(`${root(ctx)}/tools/profiles/effective/agents/${id}`)));
    state.connectionCountUnchanged = (await ctx.input.api.get<{connections: unknown[]}>(`${root(ctx)}/tools/connections`)).connections.length === state.connectionCountBefore;
    const policy = (await ctx.input.api.get<{ profiles: ToolProfileWithDetails[] }>(`${root(ctx)}/tools/profiles`)).profiles.filter(row => row.profileKey === `app:${state.connectionId}`);
    // Installation legitimately changes bindings, not the app's catalog-entry rules.
    const rules = (rows: ToolProfileWithDetails[]) => rows.map(row => ({ id: row.id, defaultAction: row.defaultAction, entries: row.entries.map(entry => ({selectorType:entry.selectorType,effect:entry.effect,applicationId:entry.applicationId,connectionId:entry.connectionId,catalogEntryId:entry.catalogEntryId,toolName:entry.toolName,riskLevel:entry.riskLevel,conditions:entry.conditions})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))) }));
    state.appPolicyUnchanged = JSON.stringify(rules(policy)) === JSON.stringify(rules(state.appPolicyBefore as ToolProfileWithDetails[])); return observeExternal(ctx, state);
  },
  async verifyResult(ctx, _state, value) { await verifyRenderedReply(ctx, value); },
  async cleanup(ctx, state) { if (typeof state.connectionId === "string") await ctx.input.api.delete(`/api/tool-connections/${state.connectionId}`, { allowNotFound: true }); },
})];
