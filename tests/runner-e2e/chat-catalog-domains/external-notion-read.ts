import { expect } from "@playwright/test";
import type { ToolConnection, ToolRunDecisionLookup, ToolProfileEffectiveSummary } from "../../../packages/shared/src/types/tool-access.js";
import { externalRequirements, selectedExternalBinding } from "./external-fixtures.js";
import { connectNamedNotion, readNotionFixturePages, type NotionPageOracle } from "./external-notion-provider.js";
import { notionDateMentioned, notionFactSpan, notionPageIdentityMatches } from "./external-notion-semantics.js";
import { definition, externalObservation, observeExternal, root, checks, verifyRenderedReply } from "./external-support.js";
export function gradeNotionRead(value: unknown) {
  const c = checks(), o = externalObservation(value);
  c.add("complete-named-notion-evidence", !!o, "Real official Notion account/resource checks, provider-backed catalog admission and source-grounded summary are required."); if (!o) return c.result();
  const pages = o.state.pages as NotionPageOracle[] | undefined; const recent = pages?.[0], older = pages?.[1];
  c.add("actual-current-provider-fixtures", o.state.provider === "notion" && o.state.providerOrigin === "https://mcp.notion.com" && o.state.workspaceIndependentlyMatched === true
    && !!recent && !!older && recent.id !== older.id && Date.parse(recent.editedAt) > Date.parse(older.editedAt) && o.state.fixturesUnchanged === true,
    "An independent official Notion API checks token workspace identity and actual current and older allowlisted page bodies/dates before and after the query.");
  const effective = o.state.effective as ToolProfileEffectiveSummary | undefined;
  const readIds = o.state.readEntryIds as string[] | undefined;
  c.add("existing-assigned-healthy-connection", o.state.healthyBeforeQuery === true && o.connections.filter(row => row.id === o.state.connectionId).length === 1
    && o.connections.length === o.state.connectionCountBefore && effective?.agentId === o.leadId && Array.isArray(readIds)
    && readIds.some(id => effective.allowedTools.some(tool => tool.id === id)), "The same pre-existing official Notion connection remains usable for this CEO without duplicate setup or repaired credentials.");
  const decisions = o.state.decisions as ToolRunDecisionLookup[] | undefined;
  c.add("actual-model-notion-read", Array.isArray(decisions) && decisions.some(row => row.decisions.some(decision => decision.invocation.runId === row.runId
    && decision.invocation.agentId === o.leadId && decision.invocation.connectionId === o.state.connectionId && decision.invocation.issueId === o.state.sourceIssueId
    && readIds?.includes(decision.invocation.catalogEntryId ?? "") && decision.invocation.status === "succeeded")),
    "The actual canonical-query model run successfully invokes a read action from this named provider connection; independent oracle reads cannot substitute.");
  c.add("latest-body-grounded-summary", !!recent?.fact && !!notionFactSpan(o.reply, recent.fact) && notionDateMentioned(o.reply, recent.editedAt)
    && o.links.some(link => notionPageIdentityMatches(link, recent.id))
    && (!older?.fact || !notionFactSpan(o.reply, older.fact) || /older|background|previous|earlier/i.test(o.reply)),
    "The answer contains the freshly observed body fact, its real source and update date, and distinguishes older background if mentioned.");
  c.add("no-needless-reconnect", !o.interactions.some(row => row.kind === "connection_intent" && row.payload?.serviceSlug === "notion")
    && !/\b(?:must|need to|please) (?:re)?connect (?:your |the )?notion/i.test(o.reply), "An already usable account is used without a needless setup request.");
  return c.result();
}
export const notionReadExternalCases = [definition("connection-setup.notion-connected", async ctx => {
  const binding = selectedExternalBinding(ctx); const pages = await readNotionFixturePages(ctx, binding);
  const connected = await connectNamedNotion(ctx, binding, [ctx.input.fixtures.agent.id]);
  const connection = await ctx.input.api.get<ToolConnection>(`/api/tool-connections/${connected.connectionId}`);
  if (connection.status !== "active" || !connection.enabled || connection.healthStatus !== "ok") throw new Error("Setup blocker: authorized official Notion fixture did not produce a healthy active connection");
  const connections = await ctx.input.api.get<{ connections: ToolConnection[] }>(`${root(ctx)}/tools/connections`);
  return { ...connected, pages, provider: "notion", providerOrigin: "https://mcp.notion.com", workspaceIndependentlyMatched: true, healthyBeforeQuery: true, connectionCountBefore: connections.connections.length };
}, gradeNotionRead, {
  externalInput: externalRequirements["connection-setup.notion-connected"],
  sourceFiles: ["chat-catalog-domains/external-notion-read.ts", "chat-catalog-domains/external-notion-provider.ts", "chat-catalog-domains/external-notion-semantics.ts", "chat-catalog-domains/external-fixtures.ts", "chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/connection-setup.yaml"],
  async observe(ctx, state) {
    const current = await readNotionFixturePages(ctx); const before = state.pages as NotionPageOracle[];
    state.fixturesUnchanged = current.length === before.length && current.every((page, index) => page.id === before[index]?.id && page.editedAt === before[index]?.editedAt && page.marker === before[index]?.marker);
    state.effective = await ctx.input.api.get<ToolProfileEffectiveSummary>(`${root(ctx)}/tools/profiles/effective/agents/${ctx.input.fixtures.agent.id}`);
    const runs = await ctx.allRuns(); state.decisions = await Promise.all(runs.map(run => ctx.input.api.get<ToolRunDecisionLookup>(`${root(ctx)}/tools/runs/${run.id}/decisions`)));
    state.sourceIssueId = ctx.issue()?.id; return observeExternal(ctx, state);
  },
  async verifyResult(ctx, state, value) {
    await verifyRenderedReply(ctx, value); const page = (state.pages as NotionPageOracle[])[0]!;
    const o = externalObservation(value)!; const href = o.links.find(link => notionPageIdentityMatches(link, page.id)); if (!href) throw new Error("No current Notion page identity in the rendered response");
    const anchor = ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first(); await expect(anchor).toBeVisible();
    // External page browsers can require a second login. The actual source was
    // independently retrieved above; verify the rendered exact link identity.
    await expect(anchor).toHaveAttribute("href", href);
    await ctx.input.evidence("chat-catalog-notion-source.json", { provider: "notion", pageId: page.id, url: page.url, editedAt: page.editedAt, workspaceMatched: true });
  },
  async cleanup(ctx, state) { if (typeof state.connectionId === "string") await ctx.input.api.delete(`/api/tool-connections/${state.connectionId}`, { allowNotFound: true }); },
})];
