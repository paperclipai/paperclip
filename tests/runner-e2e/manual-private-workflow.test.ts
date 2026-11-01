import { expect, it } from "vitest";
import { readFile, writeFile, mkdir, mkdtemp, rm, stat, realpath, symlink, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { models as claudeModels } from "../../packages/adapters/claude-local/src/index.js";
import YAML from "yaml";
import { MAX_MANUAL_PRIVATE_CELLS, MANUAL_PRIVATE_EXECUTIONS } from "./manual-private-retention.js";
const source=await readFile(new URL("../../.github/workflows/runner-full-stack-e2e.yml",import.meta.url),"utf8");
const jobs=YAML.parse(source).jobs;
const step=(job:string,name:string)=>jobs[job].steps.find((row:{name?:string})=>row.name===name);
function condition(expression:string, state:any, previousStatus:"success"|"failure"|"cancelled"="success"){
 const value=expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
 const gated=/\b(?:always|cancelled|failure|success)\s*\(/.test(value)?value:`success() && (${value})`;
 return Function("always","success","failure","cancelled","needs","steps","matrix","secrets","env",`return (${gated})`)(()=>true,()=>previousStatus==="success",()=>previousStatus==="failure",()=>previousStatus==="cancelled",state.needs,state.steps,state.matrix,state.secrets,state.env);
}
it("never uploads staged manual cell or merged evidence to public Actions on private failure",()=>{
 const state={needs:{catalog:{outputs:{operations_cadence:""}},authorize:{outputs:{evidence_retention:"private"}}},steps:{manual_cell_route:{outputs:{route:"private"}},manual_private_verified:{outcome:"failure"}}};
 for(const [job,name]of[["test","Upload nonprivate packaged cell evidence"],["report","Upload nonprivate merged report"]]){
  expect(condition(step(job!,name!).if,state)).toBe(false);
  const publicState={...state,needs:{...state.needs,authorize:{outputs:{evidence_retention:"actions"}}},steps:{...state.steps,manual_cell_route:{outputs:{route:"actions"}}}};
  expect(condition(step(job!,name!).if,publicState)).toBe(true);
 }
 const noGuard={...state,needs:{...state.needs,authorize:{outputs:{evidence_retention:"actions"}}},steps:{...state.steps,manual_cell_route:{outputs:{}}}};
 expect(condition(step("test","Upload nonprivate packaged cell evidence").if,noGuard)).toBe(false);
 expect(jobs.publish_history.if).toContain("evidence_retention == 'actions'");
});
it("keeps archive authority in explicit protected jobs and the workflow-pinned transfer runtime",()=>{
 expect(jobs.test.permissions["id-token"]).toBeUndefined();
 expect(jobs.test_manual_private.environment.name).toBe("runner-e2e-private-paid");
 expect(jobs.test_manual_private.if).toContain("evidence_retention == 'private'");
 const steps=jobs.test_manual_private.steps;
 const checkout=steps.find((row:any)=>row.with?.path===".manual-private-trusted");expect(checkout.with.ref).toBe("${{ github.sha }}");
 const runtime=step("test_manual_private","Prepare workflow-pinned private transfer runtime before archive credentials");expect(runtime.run).toContain("--ignore-scripts --store-dir");
 expect(steps.indexOf(runtime)).toBeLessThan(steps.indexOf(step("test_manual_private","Obtain exact-key manual archive session")));
 const verified=steps.indexOf(step("test_manual_private","Verify restricted complete evidence storage before model or fixture secrets"));
 expect(verified).toBeLessThan(steps.findIndex((row:any)=>row.run==="pnpm install --frozen-lockfile --ignore-scripts"));
 for(const name of["Bind protected original run and compatible target evidence protocol","Verify restricted complete evidence storage before model or fixture secrets","Retain complete approved manual originals with no public fallback"]){
  const row=step("test_manual_private",name);expect(row.workingDirectory??row["working-directory"]).toBe(".manual-private-trusted");expect(row.run).toContain('$GITHUB_WORKSPACE/.manual-private-trusted/cli/node_modules/tsx/dist/cli.mjs');expect(row.env.NODE_OPTIONS).toBe("");expect(row.env.NODE_PATH).toBe("");
 }
 expect(step("test_manual_private","Run paid cell").env.AWS_ACCESS_KEY_ID).toBeUndefined();
 expect(step("test_manual_private","Run paid cell").if).toContain("manual_private_verified.outcome == 'success'");
});
it("the actual private paid shell withholds launcher diagnostics on abnormal exit",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"manual-shell-test-"));
 try{const shell=step("test","Run paid cell").run.replaceAll('${{ matrix.executionId }}',"test");
 const result=spawnSync("bash",["-c",`pnpm(){ printf '%s\\n' 'synthetic-private-diagnostic'; return 7; };\n${shell}`],{encoding:"utf8",env:{PATH:process.env.PATH,PRIVATE_EVIDENCE_ROOT:root,PAPERCLIP_RUNNER_E2E_PRIVATE_PREFLIGHT:"bound"}});
 expect(result.status).toBe(7);expect(result.stdout+result.stderr).not.toContain("synthetic-private-diagnostic");expect(await readFile(path.join(root,"launcher-output.log"),"utf8")).toContain("synthetic-private-diagnostic");
 }finally{await rm(root,{recursive:true,force:true});}
});
it("requires downloaded complete private cell receipts before retaining merged report",()=>{
 expect(step("report","Retain complete manual merged evidence only in restricted storage").if).toContain("manual_cells_downloaded.outcome == 'success'");
 expect(step("report","Aggregate normalized campaign results").run).toContain('"$EVIDENCE_RETENTION" = private');
 expect(step("report","Merge Playwright HTML and JUnit").run).toContain('> runner-e2e-merged-report/merge.log 2>&1');
});

it("uses one exact read session per approved cell and a distinct write-only report session",()=>{
 const report=jobs.report.steps;
 expect(MAX_MANUAL_PRIVATE_CELLS).toBe(8);
 expect(MANUAL_PRIVATE_EXECUTIONS).toHaveLength(244);
 const indices=report.filter((row:any)=>/^manual_read_credentials_/.test(row.id??""))
  .map((row:any)=>Number(row.id.replace("manual_read_credentials_","")));
 expect(indices).toEqual(Array.from({length:MAX_MANUAL_PRIVATE_CELLS},(_,i)=>i));
 expect(report.filter((row:any)=>/^Download restricted manual cell /.test(row.name??""))
  .map((row:any)=>Number(row.env.SELECTED_CELL_INDEX))).toEqual(indices);
 for(let index=0;index<MAX_MANUAL_PRIVATE_CELLS;index++){
  const credentials=report.find((row:any)=>row.id===`manual_read_credentials_${index}`);
  expect(credentials.with["inline-session-policy"]).toBe("${{ steps.manual_report.outputs.read_policy_"+index+" }}");
  expect(credentials.if).toContain(`cell_count) > ${index}`);
  const read=step("report",`Download restricted manual cell ${index}`);
  expect(read.env.SELECTED_CELL_INDEX).toBe(String(index));expect(read.env.AWS_ACCESS_KEY_ID).toBe("${{ steps.manual_read_credentials_"+index+".outputs.aws-access-key-id }}");
 }
 expect(step("report","Obtain exact current manual report archive session").with["inline-session-policy"]).toBe("${{ steps.manual_report.outputs.session_policy }}");
 expect(step("report","Verify all approved private cell transfers before merging").run).toContain("verify-downloads");
});

const chooseClaude = "chat-features.runner-opencode.local.onboarding.choose-first-runtime";
const hireClaude = "chat-features.runner-opencode.local.agents.hire-claude-code";
function secondaryClaudeState(executionId = hireClaude) {
 return {
  needs:{catalog:{outputs:{operations_cadence:""}}},
  matrix:{executionId,profileId:"runner-opencode",environmentId:"local",credentialName:"OPENROUTER_API_KEY"},
  steps:{manual_cell_route:{outputs:{route:"private"}},manual_private_verified:{outcome:"success"},claude_cli:{outcome:"success"},claude_feature_inputs:{outcome:"success"}},
  secrets:{ANTHROPIC_API_KEY:"synthetic-secondary-claude-key"}, env:{},
 };
}
function producer(name:string) {
 const run=step("test_manual_private",name).run as string;
 const body=run.split("<<'NODE'\n")[1]?.split("\nNODE")[0];
 if(!body)throw new Error("Actual workflow producer is missing");
 return body;
}
function runProducer(name:string,env:NodeJS.ProcessEnv) {
 return spawnSync(process.execPath,["--input-type=module","-e",producer(name)],{
  encoding:"utf8",env:{PATH:process.env.PATH,...env},
 });
}
async function claudeProducerFixture() {
 const directory=await mkdtemp(path.join(os.tmpdir(),"claude-producer-test-"));
 const root=await realpath(directory), packageRoot=path.join(root,"package");await mkdir(packageRoot);
 const executable=path.join(packageRoot,"cli-wrapper.cjs"), output=path.join(root,"output"), githubEnv=path.join(root,"env");
 await writeFile(path.join(packageRoot,"package.json"),JSON.stringify({name:"@anthropic-ai/claude-code",version:"2.1.277"}));
 await writeFile(executable,"// synthetic CLI artifact: never executed\n",{mode:0o700});
 await writeFile(output,"");await writeFile(githubEnv,"");
 const identityEnv={CLAUDE_CLI_PACKAGE_ROOT:packageRoot,CLAUDE_CLI_COMMAND:executable,CLAUDE_CLI_VERSION:"2.1.277 (Claude Code)",GITHUB_OUTPUT:output};
 const inputsEnv={SELECTED_EXECUTION_ID:hireClaude,CLAUDE_CLI_COMMAND:executable,CLAUDE_CLI_VERSION:"2.1.277",CLAUDE_CLI_SHA256:createHash("sha256").update(await readFile(executable)).digest("hex"),RUNNER_TEMP:root,GITHUB_ENV:githubEnv};
 return{root,packageRoot,executable,output,githubEnv,identityEnv,inputsEnv};
}
function envLines(value:string){return Object.fromEntries(value.trim().split("\n").filter(Boolean).map(row=>{const at=row.indexOf("=");return[row.slice(0,at),row.slice(at+1)];}));}

it("delivers secondary Claude only to the two verified private OpenCode feature cells",()=>{
 const installer=step("test_manual_private","Install pinned Claude CLI for setup verification");
 const paid=step("test_manual_private","Run paid cell");
 for(const id of[chooseClaude,hireClaude]){
  const state=secondaryClaudeState(id);
  expect(condition(installer.if,state)).toBe(true);
  expect(condition(paid.env.ANTHROPIC_API_KEY,state)).toBe(state.secrets.ANTHROPIC_API_KEY);
  for(const change of[(s:any)=>s.matrix.executionId+="-extra",(s:any)=>s.matrix.profileId="runner-codex",(s:any)=>s.matrix.environmentId="daytona",(s:any)=>s.steps.manual_cell_route.outputs.route="actions",(s:any)=>s.steps.manual_private_verified.outcome="failure",(s:any)=>s.needs.catalog.outputs.operations_cadence="daily"]){
   const wrong=structuredClone(state);change(wrong);
   expect(condition(installer.if,wrong)).toBe(false);expect(condition(paid.env.ANTHROPIC_API_KEY,wrong)).toBe("");
  }
  const cliFailed=structuredClone(state);cliFailed.steps.claude_cli.outcome="failure";
  expect(condition(paid.env.ANTHROPIC_API_KEY,cliFailed)).toBe("");
 }
 const unrelated=secondaryClaudeState("chat-features.runner-opencode.local.agents.hire-needs-account");
 expect(condition(installer.if,unrelated)).toBe(false);expect(condition(paid.env.ANTHROPIC_API_KEY,unrelated)).toBe("");
 const failedConfig=secondaryClaudeState();failedConfig.steps.claude_feature_inputs.outcome="failure";
 expect(condition(paid.env.ANTHROPIC_API_KEY,failedConfig)).toBe("");
 const choose=secondaryClaudeState(chooseClaude);choose.steps.claude_feature_inputs.outcome="skipped";
 expect(condition(paid.env.ANTHROPIC_API_KEY,choose)).toBe(choose.secrets.ANTHROPIC_API_KEY);
 for(const profileId of["legacy-claude","runner-acpx-claude"]){
  const primary=secondaryClaudeState("existing-primary-claude");primary.matrix.profileId=profileId;primary.matrix.credentialName="ANTHROPIC_API_KEY";
  primary.steps.manual_cell_route.outputs.route="actions";primary.steps.manual_private_verified.outcome="skipped";
  expect(condition(installer.if,primary)).toBe(true);expect(condition(paid.env.ANTHROPIC_API_KEY,primary)).toBe(primary.secrets.ANTHROPIC_API_KEY);
 }
});

it("keeps Claude preparation before keys and cleans private config before any evidence transfer",()=>{
 const rows=jobs.test_manual_private.steps;
 const installer=step("test_manual_private","Install pinned Claude CLI for setup verification");
 const prepare=step("test_manual_private","Prepare selected Claude hiring inputs");
 const paid=step("test_manual_private","Run paid cell"),cleanup=step("test_manual_private","Remove selected Claude hiring input files");
 const verified=step("test_manual_private","Verify restricted complete evidence storage before model or fixture secrets");
 expect(rows.indexOf(verified)).toBeLessThan(rows.indexOf(installer));expect(rows.indexOf(installer)).toBeLessThan(rows.indexOf(prepare));
 expect(rows.indexOf(prepare)).toBeLessThan(rows.indexOf(paid));expect(rows.indexOf(paid)).toBeLessThan(rows.indexOf(cleanup));
 expect(rows.indexOf(cleanup)).toBeLessThan(rows.indexOf(step("test_manual_private","Upload nonprivate packaged cell evidence")));
 for(const row of[installer,prepare])expect(Object.values(row.env??{}).some(v=>String(v).includes("secrets."))).toBe(false);
 expect(condition(prepare.if,secondaryClaudeState())).toBe(true);expect(condition(prepare.if,secondaryClaudeState(chooseClaude))).toBe(false);
 const failed=secondaryClaudeState();failed.env={PAPERCLIP_CLAUDE_FEATURE_INPUT_ROOT:"owned-private-root"};
 expect(condition(cleanup.if,failed)).toBe(true);
});

it.each(["failure","cancelled"] as const)("actual Claude input cleanup survives %s and rejects missing always",status=>{
 const state=secondaryClaudeState();state.env={PAPERCLIP_CLAUDE_FEATURE_INPUT_ROOT:"synthetic-owned-root"};
 const cleanup=step("test_manual_private","Remove selected Claude hiring input files");
 expect(condition(cleanup.if,state,status)).toBe(true);
 expect(condition(cleanup.if.replace(/\balways\(\)\s*&&\s*/,""),state,status)).toBe(false);
});

it("the actual installer metadata producer binds canonical package bytes without running the CLI",async()=>{
 const f=await claudeProducerFixture();
 try{
  const result=runProducer("Install pinned Claude CLI for setup verification",f.identityEnv);
  expect(result.status,result.stderr).toBe(0);
  expect(envLines(await readFile(f.output,"utf8"))).toEqual({executable:f.executable,version:"2.1.277",executable_sha256:f.inputsEnv.CLAUDE_CLI_SHA256});
  await writeFile(f.output,"");
  for(const patch of[{CLAUDE_CLI_VERSION:"2.1.278 (Claude Code)"},{CLAUDE_CLI_VERSION:"2.1.2779 (Claude Code)"},{CLAUDE_CLI_COMMAND:process.execPath}]){
   const wrong=runProducer("Install pinned Claude CLI for setup verification",{...f.identityEnv,...patch});
   expect(wrong.status).toBe(1);expect(await readFile(f.output,"utf8")).toBe("");
  }
  await writeFile(path.join(f.packageRoot,"package.json"),JSON.stringify({name:"unrelated-package",version:"2.1.277"}));
  expect(runProducer("Install pinned Claude CLI for setup verification",f.identityEnv).status).toBe(1);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

it("the actual hiring producer writes only declared logical refs and a real prepared executable",async()=>{
 const f=await claudeProducerFixture();
 try{
  const result=runProducer("Prepare selected Claude hiring inputs",f.inputsEnv);expect(result.status,result.stderr).toBe(0);
  const env=envLines(await readFile(f.githubEnv,"utf8")),config=JSON.parse(await readFile(env.PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG!,"utf8"));
  expect(config).toEqual({schemaVersion:1,providers:{claude:{disposable:true,resourceIds:["fixture.environment"],credentialEnv:[],prerequisites:{targetRef:"fixture.environment",harnessExecutable:f.executable,model:"claude-sonnet-4-6",accountBindingRef:"selected.ANTHROPIC_API_KEY"}}}});
  expect(claudeModels.some(model=>model.id===config.providers.claude.prerequisites.model)).toBe(true);
  expect((await stat(env.PAPERCLIP_CLAUDE_FEATURE_INPUT_ROOT!)).mode&0o777).toBe(0o700);
  expect((await stat(env.PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG!)).mode&0o777).toBe(0o600);
  const cleanup=runProducer("Remove selected Claude hiring input files",{...f.inputsEnv,...env});expect(cleanup.status,cleanup.stderr).toBe(0);
  await expect(access(env.PAPERCLIP_CLAUDE_FEATURE_INPUT_ROOT!)).rejects.toMatchObject({code:"ENOENT"});
  expect(envLines(await readFile(f.githubEnv,"utf8")).PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG).toBe("");
 }finally{await rm(f.root,{recursive:true,force:true});}
});

it("rejects foreign selection, changed bytes and unsafe cleanup ownership in the actual producers",async()=>{
 const f=await claudeProducerFixture();
 try{
  for(const patch of[{SELECTED_EXECUTION_ID:chooseClaude},{CLAUDE_CLI_SHA256:"0".repeat(64)},{CLAUDE_CLI_VERSION:"2.1.278"}]){
   expect(runProducer("Prepare selected Claude hiring inputs",{...f.inputsEnv,...patch}).status).toBe(1);
   expect(await readFile(f.githubEnv,"utf8")).toBe("");
  }
  const link=path.join(f.root,"link");await symlink(f.executable,link);
  expect(runProducer("Prepare selected Claude hiring inputs",{...f.inputsEnv,CLAUDE_CLI_COMMAND:link}).status).toBe(1);
  const foreign=path.join(f.root,"unrelated");await mkdir(foreign);
  expect(runProducer("Remove selected Claude hiring input files",{...f.inputsEnv,PAPERCLIP_CLAUDE_FEATURE_INPUT_ROOT:foreign}).status).toBe(1);
  expect((await stat(foreign)).isDirectory()).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
