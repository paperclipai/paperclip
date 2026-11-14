import { expect } from "@playwright/test";
import type { ToolCatalogEntry,ToolConnection,ToolProfileWithDetails,ToolProfileEffectiveSummary } from "../../../packages/shared/src/types/tool-access.js";
import { definition,root,checks,externalObservation,observeExternal,verifyRenderedReply } from "./external-support.js";
import { selectedExternalBinding,externalRequirements } from "./external-fixtures.js";
import { verifyNotionWorkspace,connectNamedNotion } from "./external-notion-provider.js";
import { probeAgentPermission,waitForReply } from "./identity-support.js";
export function notionProfileGuidance(reply:string){
 return /Notion/i.test(reply)&&/read.only|read actions|reads/i.test(reply)&&/profile/i.test(reply)&&/human|board|admin|settings|management/i.test(reply)&&/\b(?:not|no|until|separate|choose|select)\b[^.!;\n]{0,60}(?:assign|agents|access)|\b(?:assignments?|agent selection|draft)\b[^.!;\n]{0,65}\b(?:separate|not|no|until|required|before)\b/i.test(reply)
  &&!/\b(?:I(?:['’]ve| have)?|we(?:['’]ve| have)?)\s+(?:already\s+)?(?:created|saved|published|assigned)\b/i.test(reply)
  &&!reply.split(/[.!;\n]+/).some(clause=>/\b(?:allow|include|enable)\b[^.!;\n]{0,30}\b(?:writes|write actions|all actions)\b/i.test(clause)&&!/(?:do not|don.t|never|exclude|no)\s+(?:allow|include|enable)/i.test(clause));
}
export function gradeProfileDefinition(value:unknown){
 const c=checks(),o=externalObservation(value);c.add("complete-named-profile-evidence",!!o,"Actual official Notion account/catalog, real draft/publish UI and independent saved/effective policy are required.");if(!o)return c.result();
 c.add("named-notion-prerequisite-and-management-boundary",o.state.provider==="notion"&&o.state.workspaceMatched===true&&o.state.healthyBefore===true&&o.state.agentCreateStatus===403&&notionProfileGuidance(o.reply),"The actual named Notion account is independently matched and healthy; the model directs authorized profile management rather than self-publishing.");
 const profile=o.state.profileAfter as ToolProfileWithDetails|undefined,reads=o.state.readEntryIds as string[]|undefined,writes=o.state.writeEntryIds as string[]|undefined;
 c.add("saved-exact-read-only-policy",!!profile&&profile.companyId===o.companyId&&profile.name==="Notion reads"&&profile.status==="active"&&profile.defaultAction==="deny"&&!!reads?.length&&!!writes?.length&&profile.entries.length===reads.length&&profile.entries.every(entry=>entry.effect==="include"&&entry.selectorType==="catalog_entry"&&!!entry.catalogEntryId&&reads.includes(entry.catalogEntryId))&&reads.every(id=>profile.entries.some(entry=>entry.catalogEntryId===id)),"The one reusable saved profile includes exactly this account's current read actions, excludes writes, and denies future unreviewed tools.");
 const effective=o.state.effectiveAfter as ToolProfileEffectiveSummary|undefined;
 c.add("draft-published-profile-not-effective-assignment",o.state.draftObserved===true&&o.state.draftHadNoBindings===true&&o.state.noAgentSelectionVisible===true&&o.state.organizationDefaultUnchecked===true&&o.state.profileSavedVisible===true&&profile?.bindings.length===0&&!!effective&&effective.agentId===o.leadId&&!effective.profiles.some(row=>row.id===profile?.id)&&!effective.allowedTools.some(tool=>[...reads??[],...writes??[]].includes(tool.id)),"The real draft is later saved active with no consumers or company-wide default; no empty selection is treated as effective access.");
 c.add("actual-human-profile-attribution",!!profile&&o.activity.some(row=>row.entityId===profile.id&&row.actorType==="user"&&row.action==="tool_profile.created")&&o.state.exactlyOneNewProfile===true,"Public product activity attributes exactly one newly saved reusable profile to the human.");return c.result();
}
export const profileDefinitionExternalCases=[definition("gateways-profiles.define-profile",async ctx=>{
 const binding=selectedExternalBinding(ctx);await verifyNotionWorkspace(ctx,binding);const connected=await connectNamedNotion(ctx,binding,[]);
 const saved=await ctx.input.api.get<ToolConnection>(`/api/tool-connections/${connected.connectionId}`);if(saved.status!=="active"||saved.healthStatus!=="ok")throw new Error("Setup blocker: the intended official disposable Notion account must be healthy");
 const catalog=await ctx.input.api.get<{catalog:ToolCatalogEntry[]}>(`/api/tool-connections/${connected.connectionId}/catalog`),writeEntryIds=catalog.catalog.filter(row=>row.isWrite||row.isDestructive).map(row=>row.id),readEntryIds=catalog.catalog.filter(row=>!row.isWrite&&!row.isDestructive).map(row=>row.id);
 if(!readEntryIds.length||!writeEntryIds.length)throw new Error("Setup blocker: actual Notion account must expose classified read and write controls to verify a read-only profile");
 const before=(await ctx.input.api.get<{profiles:ToolProfileWithDetails[]}>(`${root(ctx)}/tools/profiles`)).profiles;
 if(before.some(profile=>profile.name==="Notion reads"))throw new Error("Read-only profile already exists before the requested configuration");
 const agentCreateStatus=await probeAgentPermission(ctx,`${root(ctx)}/tools/profiles`,"POST",{profileKey:"unauthorized-notion",name:"Unauthorized Notion profile",defaultAction:"deny",entries:[]});
 return {...connected,readEntryIds,writeEntryIds,provider:"notion",workspaceMatched:true,healthyBefore:true,profileIdsBefore:before.map(row=>row.id),agentCreateStatus};
},gradeProfileDefinition,{
 authentication:"human-session",externalInput:externalRequirements["gateways-profiles.define-profile"],
 sourceFiles:["chat-catalog-domains/external-profile-definition.ts","chat-catalog-domains/external-fixtures.ts","chat-catalog-domains/external-notion-provider.ts","chat-catalog-domains/external-notion-semantics.ts","chat-catalog-domains/external-support.ts","chat-catalog-domains/internal-support.ts","chat-catalog-domains/identity-support.ts","chat-scenarios/gateways-profiles.yaml"],
 async act(ctx,state){
  await waitForReply(ctx);const o=await observeExternal(ctx,state);if(!notionProfileGuidance(o.reply))throw new Error("Actual reply must preserve the intended Notion read-only profile before human management");
  const prefix=`/${ctx.input.fixtures.company.issuePrefix}/apps/advanced/profiles`,href=o.links.find(link=>{try{const url=new URL(link,o.origin);return url.origin===o.origin&&[prefix,`${prefix}/new`].includes(url.pathname);}catch{return false;}});if(!href)throw new Error("Actual profile management link missing");
  const source=ctx.input.page.url();await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first().click();if(new URL(ctx.input.page.url()).pathname!==`${prefix}/new`)await ctx.input.page.getByRole("button",{name:"New profile",exact:true}).click();
  await ctx.input.page.getByRole("button",{name:/^Read-only See and fetch/}).click();await ctx.input.page.getByRole("textbox",{name:"Name",exact:true}).fill("Notion reads");
  await ctx.input.page.getByRole("button",{name:"Continue",exact:true}).click();
  const rows=(await ctx.input.api.get<{profiles:ToolProfileWithDetails[]}>(`${root(ctx)}/tools/profiles`)).profiles.filter(profile=>!(state.profileIdsBefore as string[]).includes(profile.id));if(rows.length!==1)throw new Error("Expected exactly one real human-created draft");state.profileId=rows[0]!.id;state.draftObserved=rows[0]!.status==="draft";state.draftHadNoBindings=rows[0]!.bindings.length===0;
  await expect(ctx.input.page.getByRole("radio",{name:/Stay blocked until someone allows/})).toBeChecked();await ctx.input.page.getByRole("button",{name:"Continue",exact:true}).click();
  const companyDefault=ctx.input.page.getByRole("checkbox",{name:/Make this the organization default/});await expect(companyDefault).not.toBeChecked();state.organizationDefaultUnchecked=true;
  // The independent saved bindings below are authoritative; this checks the actual assignment step was shown.
  await expect(ctx.input.page.getByRole("heading",{name:"Assign to agents",exact:true})).toBeVisible();state.noAgentSelectionVisible=(await ctx.input.page.locator('input[type="checkbox"]:checked,[role="checkbox"][data-state="checked"]').count())===0;
  await ctx.input.page.getByRole("button",{name:"Save profile",exact:true}).click();await ctx.input.page.waitForURL(url=>url.pathname===`${prefix}/${state.profileId}`);await expect(ctx.input.page.getByRole("main")).toContainText("Notion reads");state.profileSavedVisible=true;await ctx.input.page.goto(source,{waitUntil:"domcontentloaded"});
 },
 async observe(ctx,state){const profiles=(await ctx.input.api.get<{profiles:ToolProfileWithDetails[]}>(`${root(ctx)}/tools/profiles`)).profiles;state.profileAfter=profiles.find(row=>row.id===state.profileId);state.exactlyOneNewProfile=profiles.filter(row=>!(state.profileIdsBefore as string[]).includes(row.id)).length===1;state.effectiveAfter=await ctx.input.api.get<ToolProfileEffectiveSummary>(`${root(ctx)}/tools/profiles/effective/agents/${ctx.input.fixtures.agent.id}`);return observeExternal(ctx,state);},
 async verifyResult(ctx,_state,value){await verifyRenderedReply(ctx,value);},
 async cleanup(ctx,state){if(typeof state.connectionId==="string")await ctx.input.api.delete(`/api/tool-connections/${state.connectionId}`,{allowNotFound:true});},
})];
