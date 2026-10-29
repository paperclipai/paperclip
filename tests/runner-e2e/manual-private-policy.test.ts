import { expect, it, vi } from "vitest";
import { manualEvidenceRouting, authorizeManualCellRoute } from "./manual-private-policy.mjs";
import { MANUAL_PRIVATE_EXECUTIONS } from "./manual-private-retention.js";
vi.mock("./catalog.js",()=>({runnerMatrix:[]}));
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import type { MatrixExecution } from "./types.js";
const env={EVENT_NAME:"workflow_dispatch",EVAL_CADENCE:"manual",TEST_RUNNER:"runs-on/fleet=paperclip-public-pr-x64/env=public-ci"};
it.each(["chat-features"," chat-features ","first-task, chat-features "])("rejects broad sensitive suite %s before credentials",suite=>expect(()=>manualEvidenceRouting({...env,SELECT_SUITE:suite})).toThrow());
it("classifies exact private IDs without granting run approval",()=>expect(manualEvidenceRouting({...env,SELECT_ID:` ${MANUAL_PRIVATE_EXECUTIONS[0]} `})).toEqual({retention:"private",executionIds:[MANUAL_PRIVATE_EXECUTIONS[0]]}));
it.each(["chat-features","chat-features.runner-opencode.local.*","chat-features.runner-opencode.local.unknown"])("rejects partial or unsupported sensitive ID %s",id=>expect(()=>manualEvidenceRouting({...env,SELECT_ID:id})).toThrow());
it("keeps selector exclusivity equal to the actual catalog producer",()=>expect(()=>manualEvidenceRouting({...env,SELECT_ID:MANUAL_PRIVATE_EXECUTIONS[0],SELECT_SUITE:" "})).toThrow());
it("retains nonprivate suite and exact-cell routes but requires a successful trusted cell guard",()=>{
 expect(manualEvidenceRouting({...env,SELECT_SUITE:"first-task"})).toMatchObject({retention:"actions"});
 expect(authorizeManualCellRoute("actions","first-task.runner-opencode.local.create","[]")).toBe("actions");
 expect(()=>authorizeManualCellRoute("actions",MANUAL_PRIVATE_EXECUTIONS[0],"[]")).toThrow();
 expect(()=>authorizeManualCellRoute(undefined,"first-task.runner-opencode.local.create","[]")).toThrow();
});
it("rejects target-selected foreign private cells and unsupported compute",()=>{
 expect(()=>authorizeManualCellRoute("private",MANUAL_PRIVATE_EXECUTIONS[1],JSON.stringify([MANUAL_PRIVATE_EXECUTIONS[0]]))).toThrow();
 expect(()=>manualEvidenceRouting({...env,TEST_RUNNER:"ubuntu-latest",SELECT_ID:MANUAL_PRIVATE_EXECUTIONS[0]})).toThrow();
});

it.each(["33-known-ids","duplicate-known-id"])("preserves actual nonprivate catalog semantics for %s through classifier and cell guard",kind=>{
 const matrix=Array.from({length:33},(_,i)=>({id:`first-task.runner-opencode.local.fixture-${i}`,groups:[],suite:{id:"first-task"},profile:{id:"runner-opencode"},environment:{id:"local"},task:{id:`fixture-${i}`}} as unknown as MatrixExecution));
 const ids=kind==="duplicate-known-id"?[matrix[0]!.id,matrix[0]!.id]:matrix.map(row=>row.id);
 const options=parseRunnerSelectors(["--matrix-json","--max-parallel","1",...ids.flatMap(id=>["--id",id])]);
 const selected=selectRunnerExecutions(options,matrix);expect(selected.length).toBe(kind==="duplicate-known-id"?1:33);
 const route=manualEvidenceRouting({...env,SELECT_ID:ids.join(",")});expect(route).toEqual({retention:"actions",executionIds:ids});
 for(const row of selected)expect(authorizeManualCellRoute(route.retention,row.id,"[]")).toBe("actions");
});
