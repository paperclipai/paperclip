import { expect, it } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { MAX_MANUAL_PRIVATE_CELLS, MANUAL_PRIVATE_EXECUTIONS } from "./manual-private-retention.js";
const source=await readFile(new URL("../../.github/workflows/runner-full-stack-e2e.yml",import.meta.url),"utf8");
const jobs=YAML.parse(source).jobs;
const step=(job:string,name:string)=>jobs[job].steps.find((row:{name?:string})=>row.name===name);
function condition(expression:string, state:unknown){return Function("always","needs","steps",`return (${expression})`)(()=>true,(state as {needs:unknown}).needs,(state as {steps:unknown}).steps);}
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
