import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import YAML from "yaml";
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

const newlyEnrolled = ["access.invite-teammate", "activity.routine-audit"].map(id => `chat-features.runner-opencode.local.${id}`);
it.each(newlyEnrolled)("enrollment routes only the exact reviewed OpenCode/local ID %s", id => {
 expect(manualEvidenceRouting({ ...env, SELECT_ID: id })).toEqual({ retention: "private", executionIds: [id] });
 expect(authorizeManualCellRoute("private", id, JSON.stringify([id]))).toBe("private");
 expect(() => authorizeManualCellRoute("actions", id, "[]")).toThrow();
 for (const other of [id.replace("runner-opencode", "runner-codex"), id.replace(".local.", ".daytona.")])
  expect(() => manualEvidenceRouting({ ...env, SELECT_ID: other })).toThrow();
});
it("enrollment keeps eight mixed cells valid and rejects nine or ten even when the bound cell is supported", () => {
 const eight = MANUAL_PRIVATE_EXECUTIONS.slice(0, 8);
 expect(manualEvidenceRouting({ ...env, SELECT_ID: eight.join(",") }).executionIds).toEqual([...eight].sort());
 expect(authorizeManualCellRoute("private", eight[0], JSON.stringify(eight))).toBe("private");
 for (const count of [9, 10]) {
  const ids = MANUAL_PRIVATE_EXECUTIONS.slice(0, count);
  expect(() => manualEvidenceRouting({ ...env, SELECT_ID: ids.join(",") })).toThrow();
  expect(() => authorizeManualCellRoute("private", ids[0], JSON.stringify(ids))).toThrow();
 }
 expect(() => manualEvidenceRouting({ ...env, SELECT_ID: "chat-features.runner-opencode.local.onboarding.future-unknown" })).toThrow();
});

function frozenExecutionIds() {
 const directory = new URL("./chat-scenarios/", import.meta.url);
 const scenarios: string[] = readdirSync(directory).filter(name => name.endsWith(".yaml")).flatMap(name => {
  const document = YAML.parse(readFileSync(new URL(name, directory), "utf8"));
  return (document.scenarios ?? []).map((row: { id: string }) => row.id);
 });
 const legacy: Record<string, string> = { "tasks.create-backlog": "create-backlog", "tasks.delegate-announcement": "delegate-announcement" };
 return scenarios.map(id => `chat-features.runner-opencode.local.${legacy[id] ?? id}`).sort();
}
it("full catalog routes every frozen execution through private classification and cell binding", () => {
 const ids = frozenExecutionIds();
 expect(ids).toHaveLength(244);
 expect(new Set(ids).size).toBe(244);
 expect(createHash("sha256").update(JSON.stringify(ids)).digest("hex")).toBe("a215d1c3b010d0cb1b72efd45a564bcb662c2caffd87a34316ff8e657b4f02e5");
 for (const id of ids) {
  expect(manualEvidenceRouting({ ...env, SELECT_ID: id })).toEqual({ retention: "private", executionIds: [id] });
  expect(authorizeManualCellRoute("private", id, JSON.stringify([id]))).toBe("private");
  expect(() => authorizeManualCellRoute("actions", id, "[]")).toThrow();
 }
 expect([...MANUAL_PRIVATE_EXECUTIONS].sort()).toEqual(ids);
});
it.each([
 "chat-features.runner-opencode.local.future.unknown",
 "chat-features.runner-opencode.local.tasks.create-backlog",
 "chat-features.runner-opencode.local.tasks.delegate-announcement",
 "chat-features.runner-codex.local.agents.choose-primary",
 "chat-features.runner-opencode.daytona.agents.choose-primary",
 "chat-features.runner-opencode.local.tasks/../private-task",
])("full catalog rejects unregistered or rewritten execution %s", id => {
 expect(() => manualEvidenceRouting({ ...env, SELECT_ID: id })).toThrow();
 expect(() => authorizeManualCellRoute("private", id, JSON.stringify([id]))).toThrow();
});
