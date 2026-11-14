import { describe, it, expect } from "vitest";
import { questionEvidencePasses } from "./basic-evidence.js";
import { parseTargetConfig } from "./catalog.js";

function evidence() {
  return { companyId: "company", agentId: "agent", environmentId: "daytona", marker: "answer", model: "model", provider: "opencode", runtimeMode: "native",
    issue: { id: "task", companyId: "company", workMode: "ask", status: "done", assigneeAgentId: "agent" },
    runs: [{ id: "run", companyId: "company", agentId: "agent", issueId: "task", status: "succeeded", runtimeMode: "native",
      contextSnapshot: { paperclipEnvironment: { id: "daytona" } }, runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: "model" } } } }],
    comments: [{ authorAgentId: "agent", body: "answer" }] };
}
describe("attached basic journey oracle", () => {
  it("accepts the bound saved answer and rejects plausible false passes", () => {
    expect(questionEvidencePasses(evidence())).toBe(true);
    const changes = [
      (e: ReturnType<typeof evidence>) => { e.issue.companyId = "other"; },
      (e: ReturnType<typeof evidence>) => { e.issue.workMode = "standard"; },
      (e: ReturnType<typeof evidence>) => { e.runs[0]!.issueId = "other"; },
      (e: ReturnType<typeof evidence>) => { e.runs[0]!.status = "failed"; },
      (e: ReturnType<typeof evidence>) => { e.runs.push(e.runs[0]!); },
      (e: ReturnType<typeof evidence>) => { e.runs[0]!.contextSnapshot.paperclipEnvironment.id = "local"; },
      (e: ReturnType<typeof evidence>) => { e.runs[0]!.runnerProfileJson.nativeExecutionInput.provider.model = "other"; },
      (e: ReturnType<typeof evidence>) => { e.runtimeMode = "legacy"; e.runs[0]!.runtimeMode = "legacy"; },
      (e: ReturnType<typeof evidence>) => { e.environmentId = ""; },
      (e: ReturnType<typeof evidence>) => { e.runs[0]!.runnerProfileJson.nativeExecutionInput.provider.kind = "other"; },
      (e: ReturnType<typeof evidence>) => { e.comments[0]!.authorAgentId = "other"; },
      (e: ReturnType<typeof evidence>) => { e.comments[0]!.body = "wrong answer"; },
      (e: ReturnType<typeof evidence>) => { e.comments = []; },
    ];
    for (const change of changes) { const e = evidence(); change(e); expect(questionEvidencePasses(e)).toBe(false); }
  });
  it("requires an explicit single work run for the attached question", () => {
    const c = { version: 1, id: "qa", mode: "existing-cloud", adapterModule: "/private/provider.mjs", journeys: ["task-create", "ask-question", "task-properties"],
      executionEnvironment: "daytona", baseline: { features: {}, connections: [] }, limits: { durationMs: 600_000, modelBudgetCents: 100, maxRuns: 1 } };
    expect(parseTargetConfig(c).journeys).toEqual(c.journeys);
    expect(() => parseTargetConfig({ ...c, limits: { ...c.limits, maxRuns: 2 } })).toThrow("question_requires_one_bounded_run");
    expect(() => parseTargetConfig({ ...c, limits: { ...c.limits, modelBudgetCents: 0 } })).toThrow("question_requires_one_bounded_run");
  });
});
