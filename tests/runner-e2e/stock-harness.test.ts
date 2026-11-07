import { describe, expect, it } from "vitest";
import { runnerMatrix, runnerProfiles, suiteDefinitionHash } from "./catalog.js";
import { captureStockHarness, gradeStockHarness as gradeSourceHarness, gradeStockHire as gradeSourceHire, STOCK_HIRE_IDENTITY, type StockHarnessEvidence } from "./stock-harness.js";
import { readFileSync } from "node:fs";
import { classifyStockInstructionManual, readStockInstructionVariant } from "./stock-harness-instruction-variant.mjs";

const reduced = classifyStockInstructionManual(STOCK_HIRE_IDENTITY);
const gradeStockHire = (evidence: Parameters<typeof gradeSourceHire>[0]) => gradeSourceHire(evidence, reduced);
const gradeStockHarness = (evidence: StockHarnessEvidence) => gradeSourceHarness(evidence, reduced);

function recording(generation: "legacy" | "native" = "legacy"): StockHarnessEvidence {
  return {
    schema: "paperclip.stock-harness.v1", generation, agentId: "agent",
    budgets: { companyMonthlyCents: 1_000, agentMonthlyCents: 1_000 },
    bundle: { entryFile: "AGENTS.md", files: [{ path: "AGENTS.md", content: STOCK_HIRE_IDENTITY }] },
    runIds: ["fresh", "resumed"],
    invocations: generation === "native" ? [] : [
      { runId: "fresh", conversationMode: false, prompt: "You are agent agent (QA).\nConnection tools:\nUse connections_search.\nCurrent assignment.", promptMetrics: { heartbeatPromptChars: 113 } },
      { runId: "resumed", conversationMode: false, prompt: "## Paperclip Resume Delta\nCurrent ordered comments.", promptMetrics: { heartbeatPromptChars: 0 } },
    ],
  };
}

describe("stock harness Product E2E", () => {
  it("registers 26 explicit local cells with the original cases and two focused delivery repair cells", () => {
    const cells = runnerMatrix.filter(row => row.suite.id === "stock-harness");
    expect(cells).toHaveLength(26);
    expect(new Set(cells.map(row => row.profile.id))).toEqual(new Set([
      "legacy-codex", "legacy-claude", "legacy-opencode", "legacy-acp-codex", "legacy-acp-claude",
      "runner-codex", "runner-acpx-claude", "runner-opencode",
    ]));
    expect(new Set(cells.map(row => row.task.id))).toEqual(new Set([
      "ordered-comment-continuation", "assigned-skill-explicit-invocation", "continuity-restart",
      "assigned-skill-paperclip-document",
    ]));
    expect(cells.every(row => row.suite.manualOnly && row.environment.id === "local")).toBe(true);
    expect(cells.every(row => row.task.automaticRetryPolicy === "single_attempt")).toBe(true);
    expect(cells[0]!.suite.definitionMetadata).toMatchObject({ automaticRetryPolicy: "single_attempt", maximumAttemptsPerCell: 1 });
    expect(cells.reduce((turns, row) => turns + row.task.expectedRunCount, 0)).toBe(50);
    expect(cells.filter(row => row.task.id === "assigned-skill-paperclip-document").map(row => row.profile.id).sort()).toEqual(["legacy-claude", "legacy-opencode"]);
    expect(cells[0]!.suite.definitionMetadata?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["legacy-codex", "legacy-claude", "legacy-opencode", "runner-codex", "runner-acpx-claude", "runner-opencode"])(
    "omits the custom QA bundle for %s while preserving runtime, auth and skills configuration", (profileId) => {
      const profile = runnerMatrix.find(row => row.suite.id === "stock-harness" && row.profile.id === profileId)!.profile;
      const original = runnerProfiles.find(row => row.id === profileId)!;
      const input = { executionId: "test", workspacePath: "/workspace", environmentId: "environment", environmentFixtureId: "local" as const,
        secretRefs: { [profile.credential]: { type: "secret_ref" as const, secretId: "secret", version: "latest" as const } } };
      const expected = original.buildAgent(input);
      const { instructionsBundle: _manual, ...withoutManual } = expected;
      expect(profile.buildAgent(input)).toEqual(withoutManual);
      expect(profile.buildAgent(input)).not.toHaveProperty("instructionsBundle");
    },
  );

  it.each(["legacy", "native"] as const)("accepts complete %s evidence without interpreting task success as vendor-base proof", (generation) => {
    expect(gradeStockHarness(recording(generation)).every(check => check.passed)).toBe(true);
    expect(gradeStockHarness(recording(generation)).some(check => /vendor|base/.test(check.id))).toBe(false);
  });

  it("checks the hire before paid execution without treating that receipt as provider evidence", () => {
    const hire = recording();
    hire.runIds = [];
    hire.invocations = [];
    expect(gradeStockHire(hire).every(check => check.passed)).toBe(true);
    expect(gradeStockHarness(hire)).toContainEqual(expect.objectContaining({ id: "provider-runs-present", passed: false }));
    hire.bundle.files[0]!.content += "Old operating manual.";
    expect(gradeStockHire(hire)).toContainEqual(expect.objectContaining({ id: "default-hire-bundle", passed: false }));
  });

  it("keeps historical instruction observations separate from the unchanged behavioral oracle", () => {
    const historical = classifyStockInstructionManual(readFileSync(new URL("fixtures/stock-harness/historical-default-agents.md", import.meta.url), "utf8"));
    const evidence = recording();
    evidence.bundle.files[0]!.content = historical.content;
    evidence.invocations[0]!.prompt += "\nExecution contract:\nFinal disposition checklist:";
    evidence.invocations[1]!.prompt += "\nExecution contract: take concrete action\na successful process exit or final response is not sufficient";
    expect(gradeSourceHarness(evidence, historical).every(check => check.passed)).toBe(true);
    expect(gradeSourceHarness(evidence, historical)).toContainEqual(expect.objectContaining({ id: "historical-continuation-contract", passed: true }));
    expect(gradeSourceHarness(evidence, reduced)).toContainEqual(expect.objectContaining({ id: "default-hire-bundle", passed: false }));
    evidence.invocations[0]!.prompt = "You are agent agent. Connection tools: connections_search";
    expect(gradeSourceHarness(evidence, historical)).toContainEqual(expect.objectContaining({ id: "historical-startup-contract", passed: false }));
    const current = readStockInstructionVariant();
    evidence.bundle.files[0]!.content = current.content;
    expect(gradeSourceHire(evidence).every(check => check.passed)).toBe(true);
  });

  it("cannot use valid historical startup to conceal a missing task continuation or misclassified mode", () => {
    const historical = classifyStockInstructionManual(readFileSync(new URL("fixtures/stock-harness/historical-default-agents.md", import.meta.url), "utf8"));
    const evidence = recording();
    evidence.bundle.files[0]!.content = historical.content;
    evidence.invocations[0]!.prompt += "\nExecution contract:\nFinal disposition checklist:";
    expect(gradeSourceHarness(evidence, historical)).toContainEqual(expect.objectContaining({ id: "historical-startup-contract", passed: true }));
    expect(gradeSourceHarness(evidence, historical)).toContainEqual(expect.objectContaining({ id: "historical-continuation-contract", passed: false }));
    evidence.invocations[1]!.prompt += "\nExecution contract: take concrete action\na successful process exit or final response is not sufficient";
    delete evidence.invocations[1]!.conversationMode;
    expect(gradeSourceHarness(evidence, historical)).toContainEqual(expect.objectContaining({ id: "historical-invocation-classification", passed: false }));
  });

  it("checks historical conversation startup and resume separately without injecting the task contract", () => {
    const historical = classifyStockInstructionManual(readFileSync(new URL("fixtures/stock-harness/historical-default-agents.md", import.meta.url), "utf8"));
    const evidence = recording();
    evidence.bundle.files[0]!.content = historical.content;
    for (const row of evidence.invocations) row.conversationMode = true;
    evidence.invocations[0]!.prompt += "\nContinue your Paperclip conversation using the supplied chat mode directive.\nAfter 2 consecutive failures of the same control-plane write";
    expect(gradeSourceHarness(evidence, historical).every(check => check.passed)).toBe(true);
    evidence.invocations[1]!.prompt += "\nExecution contract:";
    expect(gradeSourceHarness(evidence, historical)).toContainEqual(expect.objectContaining({ id: "historical-continuation-contract", passed: false }));
  });

  it.each([
    ["manual-regrew", (e: StockHarnessEvidence) => { e.bundle.files[0]!.content += "Always comment and delegate."; }, "default-hire-bundle"],
    ["extra-file", (e: StockHarnessEvidence) => { e.bundle.files.push({ path: "HEARTBEAT.md", content: "Do everything again." }); }, "default-hire-bundle"],
    ["wrong-entry", (e: StockHarnessEvidence) => { e.bundle.entryFile = "OTHER.md"; }, "default-hire-bundle"],
    ["missing-runs", (e: StockHarnessEvidence) => { e.runIds = []; }, "provider-runs-present"],
    ["missing-invocation", (e: StockHarnessEvidence) => { e.invocations.pop(); }, "invocation-evidence-complete"],
    ["empty-prompt", (e: StockHarnessEvidence) => { e.invocations[1]!.prompt = ""; }, "invocation-evidence-complete"],
    ["malformed-prompt", (e: StockHarnessEvidence) => { e.invocations[1]!.prompt = { text: "hidden" }; }, "invocation-evidence-complete"],
    ["old-startup", (e: StockHarnessEvidence) => { e.invocations[0]!.prompt += "\nExecution contract:"; }, "generic-procedures-absent"],
    ["old-resume", (e: StockHarnessEvidence) => { e.invocations[1]!.prompt += "\na successful process exit or final response is not sufficient"; }, "generic-procedures-absent"],
    ["missing-connections", (e: StockHarnessEvidence) => { e.invocations[0]!.prompt = "You are agent agent."; }, "fresh-default-delivered"],
    ["missing-fresh-evidence", (e: StockHarnessEvidence) => { e.invocations[0]!.promptMetrics = {}; }, "fresh-default-delivered"],
    ["wrong-budget", (e: StockHarnessEvidence) => { e.budgets.agentMonthlyCents = 0; }, "budget-hard-stops"],
  ] as const)("fails closed for %s", (_name, mutate, failedId) => {
    const evidence = recording();
    mutate(evidence);
    expect(gradeStockHarness(evidence)).toContainEqual(expect.objectContaining({ id: failedId, passed: false }));
  });

  it("captures actual public bundle and invocation receipts, ignoring unrelated events", async () => {
    const paths: string[] = [];
    const api = { async get<T>(url: string): Promise<T> {
      paths.push(url);
      if (url.endsWith("/instructions-bundle")) return { entryFile: "AGENTS.md", files: [{ path: "AGENTS.md" }] } as T;
      if (url.includes("/file?")) return { content: STOCK_HIRE_IDENTITY } as T;
      if (url.includes("/events?")) return [
        { eventType: "adapter.invoke", payload: { prompt: "Actual prompt", promptMetrics: { heartbeatPromptChars: 10 } } },
        { eventType: "assistant", payload: { prompt: "Model claims about instructions" } },
      ] as T;
      if (url.endsWith("/heartbeat-runs/run")) return { id: "run", companyId: "company", agentId: "agent", contextSnapshot: { conversationMode: false } } as T;
      return { budgetMonthlyCents: 1_000 } as T;
    } };
    const evidence = await captureStockHarness({ api, companyId: "company", agentId: "agent", generation: "legacy", runIds: ["run"] });
    expect(evidence.bundle.files[0]?.content).toBe(STOCK_HIRE_IDENTITY);
    expect(evidence.invocations).toHaveLength(1);
    expect(evidence.invocations[0]).toMatchObject({ runId: "run", prompt: "Actual prompt" });
    expect(paths).toContain("/api/heartbeat-runs/run/events?limit=1000");
  });

  it("does not hide evidence API failures", async () => {
    const api = { async get<T>(): Promise<T> { throw new Error("Public API unavailable"); } };
    await expect(captureStockHarness({ api, companyId: "company", agentId: "agent", generation: "legacy", runIds: ["run"] }))
      .rejects.toThrow("Public API unavailable");
  });

  it("normalizes an omitted conversationMode only from a complete scoped task snapshot", async () => {
    const api = { async get<T>(url: string): Promise<T> {
      return (url.endsWith("/instructions-bundle") ? { entryFile: "AGENTS.md", files: [] }
        : url.endsWith("/heartbeat-runs/run") ? { id: "run", companyId: "company", agentId: "agent", contextSnapshot: { taskId: "task", issueId: "task" } }
        : url.includes("/events?") ? [{ eventType: "adapter.invoke", payload: { prompt: "Task context", promptMetrics: { heartbeatPromptChars: 1 } } }]
        : { budgetMonthlyCents: 1000 }) as T;
    } };
    const result = await captureStockHarness({ api, companyId: "company", agentId: "agent", generation: "legacy", runIds: ["run"] });
    expect(result.invocations[0]?.conversationMode).toBe(false);
  });

  it.each([
    { id: "other", companyId: "company", agentId: "agent", contextSnapshot: {} },
    { id: "run", companyId: "other", agentId: "agent", contextSnapshot: {} },
    { id: "run", companyId: "company", agentId: "other", contextSnapshot: {} },
    { id: "run", companyId: "company", agentId: "agent" },
    { id: "run", companyId: "company", agentId: "agent", contextSnapshot: "invalid" },
    { id: "run", companyId: "company", agentId: "agent", contextSnapshot: [] },
    { id: "run", companyId: "company", agentId: "agent", contextSnapshot: { conversationMode: "unknown" } },
  ])("rejects missing or mismatched public invocation mode attribution %#", async run => {
    const api = { async get<T>(url: string): Promise<T> {
      return (url.endsWith("/instructions-bundle") ? { entryFile: "AGENTS.md", files: [] }
        : url.endsWith("/heartbeat-runs/run") ? run : url.includes("/events?") ? [] : { budgetMonthlyCents: 1000 }) as T;
    } };
    await expect(captureStockHarness({ api, companyId: "company", agentId: "agent", generation: "legacy", runIds: ["run"] }))
      .rejects.toThrow("mode receipt");
  });

  it("changes the definition hash when the grader digest changes", () => {
    const suite = runnerMatrix.find(row => row.suite.id === "stock-harness")!.suite;
    expect(suiteDefinitionHash({ ...suite, definitionMetadata: { ...suite.definitionMetadata, sourceDigest: "changed" } }))
      .not.toBe(suiteDefinitionHash(suite));
  });
});
