import { expect } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { ToolConnection, ToolCatalogEntry, ToolProfileEffectiveSummary, ToolConnectionTestCallResult } from "../../../packages/shared/src/types/tool-access.js";
import { externalRequirements, selectedExternalBinding } from "./external-fixtures.js";
import { verifyNotionWorkspace, connectNamedNotion } from "./external-notion-provider.js";
import { startNotesProvider, connectNotes, type NotesProvider } from "./external-provider.js";
import { definition, root, checks, externalObservation, observeExternal, verifyRenderedReply } from "./external-support.js";
import { identityWorker, waitForReply, probeAgentPermission } from "./identity-support.js";
const providers = new WeakMap<ChatCatalogContext, NotesProvider>();
export function revokeNotionGuidance(reply: string) {
  const clauses = reply.split(/[.!?;\n]+|\b(?:but|however|then)\b/i);
  const wrong = clauses.some(clause => [...clause.matchAll(/\b(?:disconnect|revoke|remove|delete)\b.{0,70}\b(?:Synthetic Launch Notes|all accounts|all connections)\b/gi)].some(match => !/\b(?:do not|don.t|never|cannot|can.t|should not|must not)\s*$/i.test(clause.slice(0,match.index).trim())));
  return !wrong && /notion/i.test(reply) && /morgan/i.test(reply) && /CEO|both agents|two agents/i.test(reply) && /human|board|operator|settings|manage/i.test(reply)
    && /disconnect|revoke|remove/i.test(reply) && !/\bI(?:['’]ve|\s+have)?\s+(?:already\s+)?(?:disconnected|revoked|removed|deleted)\b|\b(?:erased|deleted)\b.{0,45}\b(?:provider|Notion)(?:.s)? data\b/i.test(reply);
}
export function gradeNotionRevocation(value: unknown) {
  const c = checks(), o = externalObservation(value); c.add("complete-notion-revocation-evidence", !!o, "Official provider, exact affected consumers, actual UI revocation and independent fresh-use failure are required."); if (!o) return c.result();
  c.add("usable-shared-named-account-prerequisite", o.state.provider === "notion" && o.state.workspaceMatched === true && o.state.healthyBefore === true && o.state.twoAgentsHadRead === true && o.state.agentRevokeStatus === 403, "The exact real Notion account is healthy and shared with both intended agents before board-only disconnection.");
  c.add("honest-targeted-human-guidance", revokeNotionGuidance(o.reply) && o.state.unchangedBeforeHuman === true && o.state.correctAccountVisible === true && o.state.humanDisconnected === true && o.state.operatorChannel === "public-browser-disconnect-confirmation", "Actual guidance identifies the old account and affected consumers, then the human follows its supported UI control without a hidden API substitute.");
  c.add("saved-archival-and-new-use-denial", o.state.archived === true && o.state.disabled === true && o.state.affectedEffectiveReadRemoved === true && o.state.newUseStatus === 404 && o.state.newUseReason === "tool_not_found"
    && o.activity.some(row => row.entityId === o.state.connectionId && row.action === "tool_connection.archived" && row.actorType === "user"), "The archived account is disabled, its old action is no longer callable, both agents lose effective access and the real mutation is attributed to the person.");
  const other = o.state.otherResult as ToolConnectionTestCallResult | undefined;
  c.add("unrelated-account-remains-usable", o.state.otherStillActive === true && other?.decision === "allowed" && !other.error && JSON.stringify(other.result).includes(String(o.state.otherMarker)) && o.state.otherProviderReads === 1,
    "An unrelated controlled account remains active and performs an independently observed successful read after revocation.");
  return c.result();
}
export const notionRevocationExternalCases = [definition("app-permissions.revoke-account", async ctx => {
  const binding = selectedExternalBinding(ctx); await verifyNotionWorkspace(ctx,binding); const morgan = await identityWorker(ctx), connected = await connectNamedNotion(ctx,binding,[ctx.input.fixtures.agent.id,morgan.id]);
  const provider = await startNotesProvider(`Unrelated sample page ${ctx.input.nonce}`); providers.set(ctx,provider);
  try {
    const other = await connectNotes(ctx,provider,"read-only"), saved = await ctx.input.api.get<ToolConnection>(`/api/tool-connections/${connected.connectionId}`);
    const catalog = await ctx.input.api.get<{catalog:ToolCatalogEntry[]}>(`/api/tool-connections/${connected.connectionId}/catalog`), read = catalog.catalog.find(row=>connected.readEntryIds.includes(row.id));
    if (!read || !saved.enabled || saved.status !== "active" || saved.healthStatus !== "ok") throw new Error("Setup blocker: real disposable Notion account must be healthy with a known admitted read action");
    for (const id of [morgan.id,ctx.input.fixtures.agent.id]) { const effective = await ctx.input.api.get<ToolProfileEffectiveSummary>(`${root(ctx)}/tools/profiles/effective/agents/${id}`); if (!effective.allowedTools.some(row=>connected.readEntryIds.includes(row.id))) throw new Error("Setup blocker: both agents must actually share the Notion read action"); }
    const agentRevokeStatus = await probeAgentPermission(ctx,`/api/tool-connections/${connected.connectionId}`,"DELETE");
    await ctx.input.api.post(`${root(ctx)}/chats/${ctx.input.fixtures.agent.id}`); await ctx.refreshIssue();
    await ctx.input.api.patch(`/api/issues/${ctx.issue()!.id}`,{description:`The old account to disconnect is Launch Notion (${connected.connectionId}). Its affected consumers are Morgan (${morgan.id}) and the CEO. Synthetic Launch Notes (${other.connectionId}) is an unrelated account and must remain connected. No provider-side data deletion has been requested.`});
    return {...connected,provider:"notion",workspaceMatched:true,healthyBefore:true,twoAgentsHadRead:true,morganId:morgan.id,readToolName:read.toolName,agentRevokeStatus,otherConnectionId:other.connectionId,otherMarker:`Unrelated sample page ${ctx.input.nonce}`};
  } catch(error) {providers.delete(ctx);await provider.close();throw error;}
},gradeNotionRevocation,{
  authentication:"human-session",externalInput:externalRequirements["app-permissions.revoke-account"],
  sourceFiles:["chat-catalog-domains/external-notion-revocation.ts","chat-catalog-domains/external-notion-provider.ts","chat-catalog-domains/external-notion-semantics.ts","chat-catalog-domains/external-provider.ts","chat-catalog-domains/external-fixtures.ts","chat-catalog-domains/external-support.ts","chat-catalog-domains/internal-support.ts","chat-catalog-domains/identity-support.ts","chat-scenarios/app-permissions.yaml"],
  async act(ctx,state) {
    await waitForReply(ctx); const o = await observeExternal(ctx,state); if(!revokeNotionGuidance(o.reply)) throw new Error("Disconnection guidance must preserve the exact old Notion account, affected consumers and unrelated-account boundary");
    const before = await ctx.input.api.get<ToolConnection>(`/api/tool-connections/${state.connectionId}`);state.unchangedBeforeHuman=before.enabled&&before.status==="active";
    const prefix=`/${ctx.input.fixtures.company.issuePrefix}/apps/${state.connectionId}`,href=o.links.find(link=>{try{const url=new URL(link,o.origin);return url.origin===o.origin&&(url.pathname===prefix||url.pathname.startsWith(`${prefix}/`));}catch{return false;}});
    if(!href)throw new Error("The reply did not provide the selected old account's management path");const source=ctx.input.page.url();await ctx.input.page.goto(new URL(href,o.origin).href,{waitUntil:"domcontentloaded"});
    if(!ctx.input.page.url().endsWith("/permissions"))await ctx.input.page.goto(`${prefix}/permissions`,{waitUntil:"domcontentloaded"});await expect(ctx.input.page.getByRole("main")).toContainText("Launch Notion");state.correctAccountVisible=true;
    await ctx.input.page.getByRole("button",{name:"Disconnect",exact:true}).click();const dialog=ctx.input.page.getByRole("alertdialog");await expect(dialog).toContainText("Other connections are unaffected");
    const deleted=ctx.input.page.waitForResponse(response=>new URL(response.url()).pathname===`/api/tool-connections/${state.connectionId}`&&response.request().method()==="DELETE"&&response.ok());await dialog.getByRole("button",{name:"Disconnect connection",exact:true}).click();await deleted;
    state.humanDisconnected=true;state.operatorChannel="public-browser-disconnect-confirmation";await ctx.input.page.goto(source,{waitUntil:"domcontentloaded"});
  },
  async observe(ctx,state) {
    const saved=await ctx.input.api.get<ToolConnection>(`/api/tool-connections/${state.connectionId}`);state.archived=saved.status==="archived";state.disabled=!saved.enabled;
    state.affectedEffectiveReadRemoved=true;for(const id of [state.morganId,ctx.input.fixtures.agent.id]){const effective=await ctx.input.api.get<ToolProfileEffectiveSummary>(`${root(ctx)}/tools/profiles/effective/agents/${id}`);if(effective.allowedTools.some(row=>(state.readEntryIds as string[]).includes(row.id)))state.affectedEffectiveReadRemoved=false;}
    const denied=await ctx.input.api.request.post(`/api/tool-connections/${state.connectionId}/test-calls`,{data:{agentId:state.morganId,toolName:state.readToolName,parameters:{}}});state.newUseStatus=denied.status();const error=await denied.json() as {reasonCode?:string};state.newUseReason=error.reasonCode==="tool_not_found"?error.reasonCode:"other";
    const other=await ctx.input.api.get<ToolConnection>(`/api/tool-connections/${state.otherConnectionId}`);state.otherStillActive=other.enabled&&other.status==="active";state.otherResult=await ctx.input.api.post<ToolConnectionTestCallResult>(`/api/tool-connections/${state.otherConnectionId}/test-calls`,{agentId:ctx.input.fixtures.agent.id,toolName:"launch_read",parameters:{}});state.otherProviderReads=providers.get(ctx)!.calls.filter(row=>row.method==="tools/call"&&row.name==="launch_read"&&row.authorized).length;
    return observeExternal(ctx,state);
  },
  async verifyResult(ctx,_state,value){await verifyRenderedReply(ctx,value);},
  async cleanup(ctx,state){try{for(const id of [state.connectionId,state.otherConnectionId])if(typeof id==="string")await ctx.input.api.delete(`/api/tool-connections/${id}`,{allowNotFound:true});}finally{const provider=providers.get(ctx);providers.delete(ctx);await provider?.close();}},
})];
