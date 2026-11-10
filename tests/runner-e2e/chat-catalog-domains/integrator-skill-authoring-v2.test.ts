import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { InternalObservation } from "./internal-support.js";
vi.mock("@playwright/test",()=>({expect:Object.assign((node:any)=>({toBeVisible:async()=>{if(!node.visible)throw Error("Missing real UI item");},toBeEditable:async()=>{if(!node.editable)throw Error("Noneditable real UI");},toHaveURL:async(predicate:(url:URL)=>boolean)=>{if(!predicate(new URL(node.url())))throw Error("Wrong actual Studio identity");}}),{poll:(read:()=>Promise<boolean>)=>({toBe:async(expected:boolean)=>{for(let i=0;i<3;i++)if(await read()===expected)return;throw Error("UI content did not hydrate to the saved checklist");}})})}));
const observed=vi.hoisted(()=>({base:undefined as unknown}));
vi.mock("./integrator-support.js",async original=>({...await original<typeof import("./integrator-support.js")>(),observeInternal:vi.fn(async(_ctx:unknown,state:unknown)=>({...observed.base as object,state}))}));
import { gradeIntegratorSkills, authoredChecklistTextBlocks, preservesVisibleWebsiteChecklist, inspectAuthoredSkill, integratorSkillsCases, websiteChecklist } from "./integrator-skills.js";
afterEach(()=>vi.restoreAllMocks());
function fixture(){
 const markdown=websiteChecklist.join("\n"),source="https://fixture.test/ACORN/chats/ceo";let current=source,reloads=0,editorReads=0;
 const version={id:"revision",companyId:"company",companySkillId:"skill",revisionNumber:1,authorAgentId:"ceo",authorUserId:null,fileInventory:[{path:"SKILL.md",kind:"skill",content:markdown}]};
 const skill={id:"skill",companyId:"company",name:"Website review checklist",slug:"website-review-checklist",editable:true,currentVersionId:"revision",markdown,usedByAgents:[]};
 const state:Record<string,unknown>={},o={scenarioId:"skills.author-skill",origin:"https://fixture.test",companyId:"company",leadId:"ceo",state,skills:[skill],versions:{skill:[version]},policy:{},editDecision:{allowed:true},tasks:[],projects:[],goals:[],comments:[],documents:[],revisions:[],humanQueries:["Turn our website review checklist into a reusable skill."],runs:[{id:"native",status:"succeeded",agentId:"ceo",companyId:"company"}],activity:[{action:"company.skill_created",entityId:"skill",agentId:"ceo"}],links:["/skills/studio/skill"],renderedLinkEvidence:[{threadTestId:"task-chat-thread",href:"/skills/studio/skill",source:"reply",conversationId:"conversation",anchorCommentId:"query",commentId:"reply"}],reply:"Created the reusable company skill, saved in the library and not assigned to any agent."} as unknown as InternalObservation;
 observed.base=o;
 const ui={card:true,library:true,studio:true,editable:true,body:markdown,changedAfterReload:false,wrongRoute:false,foreignRoute:false,directStudio:false,delayedHydration:false,inEdit:false,filesSelected:false};const events:string[]=[];
 const editor={get visible(){return ui.studio && (ui.inEdit || ui.directStudio);},get editable(){return ui.editable;},locator:()=>({evaluateAll:async()=>ui.delayedHydration&&editorReads++===0?[]:(ui.changedAfterReload&&reloads?"Lost checklist":ui.body).split("\n")})};
 const page={url:()=>current,getByRole:(role:string,options?:{name?:string})=>{
  if(role==="textbox")return editor;
  if(role==="article")return{getByRole:()=>({first:()=>({click:async()=>{if(options?.name!==`Skill created: ${skill.name}`||!ui.card)throw Error("No Skill created card");events.push("skill-card");}})})};
  if(role==="button" && options?.name==="Open in Skill Studio")return{click:async()=>{if(!events.includes("skill-card"))throw Error("Skill panel is closed");events.push("open-in-studio");current="https://fixture.test/ACORN/skills/studio/skill";}};
  if(role==="tab" && options?.name==="Files")return{click:async()=>{ui.filesSelected=true;events.push("Files");}};
  if(role==="button" && options?.name==="Edit")return{click:async()=>{if(!ui.editable||!ui.filesSelected)throw Error("No Edit control outside Files");ui.inEdit=true;events.push("Edit");}};
  if(role==="link")return{first:()=>({click:async()=>{events.push(options!.name!);current=options?.name==="Skills"?"https://fixture.test/ACORN/skills":"https://fixture.test/ACORN/skills/studio";}})};
  return{filter:()=>({first:()=>({get visible(){return ui.library;},click:async()=>{events.push("open-skill");current=ui.foreignRoute?"https://fixture.test/FOREIGN/skills/website-review-checklist":ui.wrongRoute?"https://fixture.test/ACORN/skills/other":ui.directStudio?"https://fixture.test/ACORN/skills/studio/skill":"https://fixture.test/ACORN/skills/website-review-checklist";}})})};
 },getByText:()=>({first:()=>({get visible(){return ui.studio;}})}),locator:()=>({}),getByTestId:()=>({get visible(){return current===source;},filter:()=>({locator:(selector:string)=>({first:()=>({click:async()=>{if(!selector.includes('"/skills/studio/skill"'))throw Error("Not the rendered skill link");events.push("reply-link");current="https://fixture.test/ACORN/skills/studio/skill";}})})})}),reload:async()=>{reloads++;ui.inEdit=false;ui.filesSelected=false;events.push("reload");},goto:async(url:string)=>{current=url;events.push("return-chat");}};
 const after=structuredClone(skill),get=vi.fn(async(route:string)=>{
  if(route.endsWith("/skills"))return[{id:"skill"}];
  if(route.endsWith("/skills/skill"))return after;
  if(route.endsWith("/versions"))return[{...version,fileInventory:[{path:"SKILL.md",kind:"skill"}]}];
  if(route.endsWith("/versions/revision"))return version;
  if(route.endsWith("/skill-policy"))return{};
  throw Error("Unexpected public inspection read");
 });const post=vi.fn(async()=>({allowed:true})),evidence=vi.fn();
 const ctx={scenario:{id:"skills.author-skill"},observationDeadlineAt:Date.now()+270000,input:{fixtures:{company:{id:"company",issuePrefix:"ACORN"},agent:{id:"ceo"}},api:{baseURL:o.origin,get,post},page,evidence},refreshIssue:async()=>{},issue:()=>({conversationState:"waiting"}),allRuns:async()=>o.runs} as unknown as ChatCatalogContext;
 return{ctx,state,o,skill,version,ui,events,after,get,post,evidence};
}
it("the actual authoring act performs nonmutating canonical-library/Edit inspection and keeps a single native/human turn",async()=>{
 const f=fixture(),d=integratorSkillsCases.find(x=>x.scenarioId==="skills.author-skill")!;
 await d.act!(f.ctx,f.state);
 expect(f.events).toEqual(["reply-link","My Skills","open-skill","Files","Edit","reload","Files","Edit","return-chat"]);
 expect(f.state.authoredSkillInspection).toMatchObject({skillId:"skill",versionId:"revision",editorSurface:"detail",editorVisible:true,readbackMatched:true});
 expect(gradeIntegratorSkills({...f.o,state:f.state}).passed).toBe(true);
 expect(d.expectedRunCount).toBe(1);expect(d.expectedHumanMessageCount).toBe(1);
 expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/companies/company/skill-policy/evaluate",expect.anything());
});
it.each(["missing library","missing Studio","readonly","wrong UI route","foreign UI route","wrong UI content","lost after reload","wrong saved version","wrong author","foreign company","no saved version"])("rejects %s before recording inspection success",async invalid=>{
 const f=fixture();
 if(invalid==="missing library")f.ui.library=false;
 if(invalid==="missing Studio")f.ui.studio=false;
 if(invalid==="readonly")f.ui.editable=false;
 if(invalid==="wrong UI route")f.ui.wrongRoute=true;
 if(invalid==="foreign UI route")f.ui.foreignRoute=true;
 if(invalid==="wrong UI content")f.ui.body="Review the site.";
 if(invalid==="lost after reload")f.ui.changedAfterReload=true;
 if(invalid==="wrong saved version")f.after.currentVersionId="other";
 if(invalid==="wrong author")f.version.authorAgentId="other";
 if(invalid==="foreign company")f.skill.companyId="foreign";
 if(invalid==="no saved version")f.skill.currentVersionId="missing";
 await expect(inspectAuthoredSkill(f.ctx,f.state,f.o)).rejects.toThrow();expect(f.state.authoredSkillInspection).toBeUndefined();
});
it("rejects invented inspection receipts and keeps other skill cases on their original contract",()=>{
 const f=fixture();expect(gradeIntegratorSkills(f.o).passed).toBe(false);
 f.state.authoredSkillInspection={companyId:"company",skillId:"other",versionId:"revision",libraryVisible:true,studioVisible:true,editable:true,checklistVisible:true,reloaded:true,readbackMatched:true};
 expect(gradeIntegratorSkills(f.o).passed).toBe(false);
 expect(integratorSkillsCases.find(x=>x.scenarioId==="skills.explicit-restriction")!.oracleVersion).toBe("paperclip.chat-catalog.skill-restriction.structural.v2");
 expect(integratorSkillsCases.find(x=>x.scenarioId==="skills.author-skill")!.oracleVersion).toBe("paperclip.chat-catalog.skill-authoring.v7");
});
it("opens the skill from its Skill created card when the reply has no skill link",async()=>{
 const f=fixture();Object.assign(f.o,{links:[],renderedLinkEvidence:[]});
 await inspectAuthoredSkill(f.ctx,f.state,f.o);
 expect(f.events.slice(0,4)).toEqual(["skill-card","open-in-studio","My Skills","open-skill"]);
 expect(f.state.authoredSkillInspection).toMatchObject({readbackMatched:true});
});
it.each(["no link","link to another skill"])("rejects %s and no Skill created card before inspection succeeds",async fault=>{
 const f=fixture(),href=fault==="no link"?null:"/skills/studio/other";f.ui.card=false;
 Object.assign(f.o,{links:href?[href]:[],renderedLinkEvidence:href?[{threadTestId:"task-chat-thread",href,source:"reply",conversationId:"conversation",anchorCommentId:"query",commentId:"reply"}]:[]});
 await expect(inspectAuthoredSkill(f.ctx,f.state,f.o)).rejects.toThrow("No Skill created card");expect(f.state.authoredSkillInspection).toBeUndefined();
});
it("cannot extend an exhausted original case budget to inspect a finished artifact",async()=>{
 const f=fixture();Object.assign(f.ctx,{observationDeadlineAt:Date.now()-1});
 await expect(inspectAuthoredSkill(f.ctx,f.state,f.o)).rejects.toThrow("budget");expect(f.events).toEqual([]);
});

it("waits for actual saved editor content instead of rejecting its visible empty hydration shell",async()=>{
 const f=fixture();f.ui.delayedHydration=true;
 await expect(inspectAuthoredSkill(f.ctx,f.state,f.o)).resolves.toBeUndefined();
 expect(f.state.authoredSkillInspection).toMatchObject({checklistVisible:true,reloaded:true});
});

it("inspects real rich-text blocks without applying Markdown marker assumptions to unrelated prefaces", () => {
 const blocks=["Do not mark a check passed without evidence.",...websiteChecklist];
 expect(preservesVisibleWebsiteChecklist(blocks)).toBe(true);
 expect(preservesVisibleWebsiteChecklist([blocks[0]!,...websiteChecklist.toReversed()])).toBe(false);
 for(let index=0;index<4;index++)expect(preservesVisibleWebsiteChecklist(websiteChecklist.filter((_,i)=>i!==index))).toBe(false);
 expect(preservesVisibleWebsiteChecklist(["Website review checklist","Type here to edit"])).toBe(false);
 expect(preservesVisibleWebsiteChecklist([...websiteChecklist.slice(0,3),"375 pixel viewport"])).toBe(false);
});

it("retains exact direct Studio card navigation when the UI uses it", async()=>{ const f=fixture();f.ui.directStudio=true;await inspectAuthoredSkill(f.ctx,f.state,f.o);expect(f.events).toEqual(["reply-link","My Skills","open-skill","reload","return-chat"]);expect(f.state.authoredSkillInspection).toMatchObject({readbackMatched:true,editorSurface:"studio"}); });

it.each([undefined, null, ""])("rejects missing company prefix %s before any UI navigation", async prefix => {
 const f=fixture();Object.assign(f.ctx.input.fixtures.company,{issuePrefix:prefix});
 await expect(inspectAuthoredSkill(f.ctx,f.state,f.o)).rejects.toThrow("company prefix");
 expect(f.events).toEqual([]);expect(f.state.authoredSkillInspection).toBeUndefined();
});

const { JSDOM } = createRequire(import.meta.url)("../../../server/node_modules/jsdom");
const sectionMarkup = `<h3>Keyboard-only navigation</h3><ul><li>Do not use a mouse or touch input.</li><li>Press Tab through every interactive control.</li></ul>
<h3>Visible form labels</h3><ul><li>Locate every form field.</li><li>Confirm each field has a visible label.</li></ul>
<h3>WCAG AA text contrast</h3><ul><li>Check text contrast meets WCAG AA.</li></ul>
<h3>375px viewport without horizontal scrolling</h3><ul><li>Load the landing page at a 375 pixel wide viewport.</li><li>Confirm no horizontal scrollbar appears.</li></ul>`;
function renderedSections(markup: string) {
 const document = new JSDOM(`<aside>375px viewport without horizontal scrolling</aside><div role="textbox" aria-label="editable markdown">${markup}</div>`).window.document;
 return authoredChecklistTextBlocks(Array.from(document.querySelector('[role="textbox"]')!.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li")) as Element[]);
}
it("reads actual editor heading context with its following steps rather than isolated list items",()=>{
 expect(preservesVisibleWebsiteChecklist(renderedSections(sectionMarkup))).toBe(true);
});
it.each(["wrong section","missing check","heading only","negated directive","negated keyboard"])("rejects incomplete editor sections: %s",fault=>{
 let markup=sectionMarkup;
 if(fault==="wrong section")markup=markup.replace("<h3>375px viewport without horizontal scrolling", "<h3>Archived dimensions</h3><p>The earlier width was 375 pixels.</p><h3>Responsive review").replace("375 pixel wide viewport","wide viewport");
 if(fault==="missing check")markup=markup.replace(/<h3>WCAG AA text contrast<\/h3><ul>.*?<\/ul>/,"");
 if(fault==="heading only")markup=markup.replace("<ul><li>Load the landing page at a 375 pixel wide viewport.</li><li>Confirm no horizontal scrollbar appears.</li></ul>","");
 if(fault==="negated directive")markup=markup.replace("Load the landing page", "Do not test the landing page");
 if(fault==="negated keyboard")markup=markup.replace("Do not use a mouse or touch input.", "Do not use the keyboard.");
 expect(preservesVisibleWebsiteChecklist(renderedSections(markup))).toBe(false);
});
