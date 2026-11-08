import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PLAN_CASES, PLAN_MAX_RUNS, PLAN_SKILLS, PLAN_VARIANTS, parsePlanCase, planHash, planScenario } from "./plan-task-cases.js";
import { gradePlanTask, planDocumentJson, type PlanObservation } from "./plan-task-scoring.js";
import { runnerSuites, runnerMatrix } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

const t = (n: number) => `2026-10-05T12:00:${String(n).padStart(2, "0")}.000Z`;
function valid(caseId: typeof PLAN_CASES[number]) {
  const o: PlanObservation = { issues: [], runs: [], documents: [], comments: [], activity: [], interactions: [], wakes: [] };
  function add(id: string, agentId: string, value: unknown, start: number, end: number) {
    const body = JSON.stringify(value), runId = `run-${id}`, documentId = `doc-${id}`, revisionId = `rev-${id}`;
    o.issues.push({ id, identifier: `T-${id}`, assigneeAgentId: agentId, status: "done", createdAt: t(0), completedAt: t(end) });
    o.runs.push({ id: runId, agentId, status: "succeeded", runtimeMode: "native", runnerInstanceId: "runner", nativeSessionId: "session", nativeIssueId: id, startedAt: t(start), finishedAt: t(end) });
    o.documents.push({ id: documentId, issueId: id, key: "result", body, latestRevisionId: revisionId, latestRevisionNumber: 1,
      revisions: [{ id: revisionId, body, createdByAgentId: agentId }] });
    o.activity.push({ action: "issue.document_created", entityId: id, agentId, runId, details: { key: "result", documentId, revisionNumber: 1 } });
    o.wakes.push({ issueId: id, events: [], truncated: false });
  }
  const marker = "PLANfixture", order = { marker, units: 5, total: 29 };
  let output: unknown = order;
  if (caseId === "parallel") {
    add("alex", "alex-agent", { marker, seats: 24 }, 2, 10);
    add("riley", "riley-agent", { marker, welcome: "Hola, equipo" }, 3, 12);
    output = { marker, seats: 24, welcome: "Hola, equipo" };
  } else if (caseId === "dependency") {
    add("alex", "alex-agent", order, 2, 10);
    output = { marker, releasedTotal: 29, sourceRevisionId: "rev-alex" };
    add("riley", "riley-agent", output, 11, 15);
  } else if (caseId === "review") {
    output = { marker, verdict: "reject", correctTotal: 29, difference: 1 };
    add("riley", "riley-agent", output, 2, 10);
  }
  add("parent", "lead", output, 16, 20);
  o.comments.push({ issueId: "parent", authorAgentId: "lead", body: "[Result](/T/issues/T-parent#document-result)" });
  return { caseId, marker, parentId: "parent", leadId: "lead", alexId: "alex-agent", rileyId: "riley-agent", observation: o, maxRuns: PLAN_MAX_RUNS, origin: "http://127.0.0.1:3100" };
}

const passed = (value: ReturnType<typeof valid>, id: string) => gradePlanTask(value).checks.find(c => c.id === id)?.passed;

describe("planning guidance outcome calibration", () => {
  it.each(PLAN_CASES)("accepts independently saved %s work", id => expect(gradePlanTask(valid(id)).passed).toBe(true));
  it.each(PLAN_CASES)("rejects missing %s evidence", id => {
    const input = valid(id); input.observation.documents = [];
    expect(gradePlanTask(input).passed).toBe(false);
  });
  it("does not reward copying an expected answer without the specialist's authorship", () => {
    const input = valid("parallel"); input.observation.documents[0]!.revisions[0]!.createdByAgentId = "lead";
    expect(passed(input, "alex-authorship")).toBe(false);
  });
  it.each(["missing-run", "wrong-task", "wrong-revision", "duplicate-write"])("rejects %s attribution", kind => {
    const input = valid("cohesive"), o = input.observation;
    if (kind === "missing-run") o.activity[0]!.runId = "unknown";
    if (kind === "wrong-task") o.runs[0]!.nativeIssueId = "other";
    if (kind === "wrong-revision") o.activity[0]!.details.revisionNumber = 2;
    if (kind === "duplicate-write") o.activity.push(structuredClone(o.activity[0]!));
    expect(passed(input, "parent-authorship")).toBe(false);
  });
  it("rejects a correct-looking answer with wrong arithmetic", () => {
    const input = valid("cohesive"); input.observation.documents[0]!.body = JSON.stringify({ marker: input.marker, units: 5, total: 30 });
    expect(passed(input, "parent-saved-output")).toBe(false);
  });
  it("rejects unnecessary children for cohesive work", () => {
    const input = valid("cohesive"); input.observation.issues.push({ id: "unnecessary", assigneeAgentId: "lead", status: "done" });
    expect(passed(input, "minimal-owned-work")).toBe(false);
  });
  it("rejects downstream execution before its prerequisite", () => {
    const input = valid("dependency"); input.observation.runs[1]!.startedAt = t(3);
    expect(passed(input, "prerequisite-before-execution")).toBe(false);
  });
  it("rejects an invented upstream revision", () => {
    const input = valid("dependency"); const doc = input.observation.documents[1]!;
    doc.body = doc.body.replace("rev-alex", "invented");
    expect(passed(input, "riley-saved-output")).toBe(false);
  });
  it("rejects missing dependency timestamps", () => {
    const input = valid("dependency"); delete input.observation.issues[0]!.completedAt;
    expect(passed(input, "prerequisite-before-execution")).toBe(false);
  });
  it("rejects closing the parent before the delegated output is complete", () => {
    const input = valid("review"); input.observation.issues.at(-1)!.completedAt = t(5);
    expect(passed(input, "handoff-before-parent-completion")).toBe(false);
  });
  it("rejects an adverse review stranded as blocked", () => {
    const input = valid("review"); input.observation.issues[0]!.status = "blocked";
    expect(passed(input, "tasks-completed")).toBe(false);
  });
  it("rejects reviewer writes on the parent", () => {
    const input = valid("review"); input.observation.comments.push({ issueId: "parent", authorAgentId: "riley-agent", body: "reject" });
    expect(passed(input, "review-write-boundary")).toBe(false);
  });
  it.each(["failed", "cancelled", "timed_out"])("retains %s runs as failures", status => {
    const input = valid("parallel"); input.observation.runs[0]!.status = status;
    expect(passed(input, "bounded-native-runs")).toBe(false);
  });
  it("rejects missing wake evidence and pending recovery", () => {
    const input = valid("cohesive"); input.observation.wakes = [];
    expect(passed(input, "tasks-completed")).toBe(false);
    const recovery = valid("cohesive"); recovery.observation.issues[0]!.scheduledRetry = { reason: "retry" };
    expect(passed(recovery, "tasks-completed")).toBe(false);
  });
  it.each(["/T-parent#document-result", "/T/issues/other#document-result", "https://unrelated.example/T/issues/T-parent#document-result", "/T/issues/T-parent#document-other"])("rejects unrelated result link %s", url => {
    const input = valid("cohesive"); input.observation.comments[0]!.body = `[Result](${url})`;
    expect(passed(input, "visible-result-link")).toBe(false);
  });
  it("records serial scheduling without confusing it with wrong output", () => {
    const input = valid("parallel"); input.observation.issues[1]!.createdAt = t(11);
    expect(gradePlanTask(input).measurements.parallelOfferedBeforeFirstCompletion).toBe(false);
    expect(gradePlanTask(input).passed).toBe(true);
  });
  it("parses whole JSON documents or one JSON fence without scraping arbitrary prose", () => {
    expect(planDocumentJson('```json\n{"value":1}\n```')).toEqual({ value: 1 });
    expect(planDocumentJson('Claim: {"value":1}')).toBeUndefined();
  });
});

describe("bounded planning comparison admission", () => {
  it("declares only 12 explicit local Codex cells with one attempt", () => {
    const suite = runnerSuites.find(s => s.id === "plan-task-guidance")!;
    expect(suite.manualOnly).toBe(true);
    expect(runnerMatrix.filter(e => e.suite.id === suite.id)).toHaveLength(12);
    expect(suite.tasks.every(t => t.automaticRetryPolicy === "single_attempt" && t.expectedRunCount === 8)).toBe(true);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(e => e.suite.id === suite.id)).toBe(false);
  });
  it("keeps task prompts identical across variants", () => {
    const suite = runnerSuites.find(s => s.id === "plan-task-guidance")!;
    for (const id of PLAN_CASES) expect(new Set(suite.tasks.filter(t => parsePlanCase(t.id).caseId === id).map(t => t.buildPrompt("same"))).size).toBe(1);
    expect(PLAN_VARIANTS).toHaveLength(3);
  });
  it("retains current source and materially smaller candidate guidance", () => {
    for (const skill of PLAN_SKILLS) {
      const old = readFileSync(new URL(`../../${skill.current}`, import.meta.url), "utf8");
      const short = readFileSync(new URL(`../../${skill.short}`, import.meta.url), "utf8");
      expect(Buffer.byteLength(short)).toBeLessThan(Buffer.byteLength(old) / 3);
      expect(planHash(short)).not.toBe(planHash(old));
    }
  });
  it("does not give the arithmetic or review answers in the scenario", () => {
    for (const id of PLAN_CASES) {
      const prompt = planScenario(id, "same").prompt;
      expect(prompt).not.toContain('"total":29');
      expect(prompt).not.toContain('"verdict":"reject"');
    }
  });
});
