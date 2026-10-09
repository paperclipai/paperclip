import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { buildRunnerE2EProcessEnvironment } from "./harness-env.js";
import { canonicalProviderEventsFromAcpxRuntimeEvent, canonicalProviderEventsFromCodex } from "../../packages/paperclip-runner/src/provider-events.js";
import { loadDefaultAgentInstructionsBundle } from "../../server/src/services/default-agent-instructions.js";
import { HIRING_TEMPLATE_READ_FILES, HIRING_TEMPLATE_SKILL_KEY, hiringTemplateInputs, hiringTemplateScenario } from "./hiring-template-cases.js";
import { readHiringInstructions, readHiringTemplateSources, renderHiringCoderExample, waitForSettledHiringObservation } from "./hiring-template-flow.js";
import { gradeHiringTemplate, hiringTemplateHash, hiringTemplateReadReceipts, type HiringTemplateEvidence } from "./hiring-template-scoring.js";
import type { RunnerApi } from "./api.js";
import { createHiringTemplateTurnFixture } from "./hiring-template-turn-fixture.js";
import { assertChatFlowRunCount } from "./chat-flow.js";

const beforeHire = "2026-10-01T12:00:00.000Z", hiredAt = "2026-10-01T12:01:00.000Z";
const binding = { provider: "anthropic", method: "api_key", mode: "responsible_user" };
const ceo = { "AGENTS.md": "You are the CEO. Lead the company." };
const coder = "You are Casey, a software engineer at Fixture Company. Own software implementation and maintenance.";
// Expected values are stated independently of the implementation under test.
const values = ["launch-queue", "api-key-rotation", "mixed-case-42", "already-ready"];
const reuseValues = ["launch_queue", "api_key_rotation", "mixed_case_42", "already_ready"];
function commandEvents(file: string) {
  return canonicalProviderEventsFromCodex("item/completed", { item: {
    type: "commandExecution", id: `read-${file}`, status: "completed", exitCode: 0,
    command: `cat /workspace/.agents/skills/paperclip-create-agent/${file}`, aggregatedOutput: "source bytes",
  } }).map(event => ({ eventType: event.eventType, createdAt: beforeHire, payload: { prpEvent: event } }));
}
function validEvidence(notificationCount = 0): HiringTemplateEvidence {
  const turnFixture = createHiringTemplateTurnFixture(notificationCount);
  const sourceFiles = [...HIRING_TEMPLATE_READ_FILES.map(file => `skills/paperclip-create-agent/${file}`),
    "skills/paperclip-create-agent/references/baseline-role-guide.md", "server/src/onboarding-assets/ceo/AGENTS.md"];
  const hashes = Object.fromEntries(sourceFiles.map(file => [file, hiringTemplateHash(file)]));
  const tasks = turnFixture.evidence.tasks;
  const runs = turnFixture.evidence.runs;
  const document = (issueId: string, reference: string, outputs: string[]) => ({ issueId, key: "fixture", latestRevisionId: `${issueId}-revision`, createdByAgentId: "coder",
    body: JSON.stringify({ reference, entries: hiringTemplateInputs.map((input, index) => ({ input, value: outputs[index] })) }) });
  const first = document("first-task", "HIREfixture", values);
  return { leadId: "lead", chatIssueId: "chat", hireName: "Casey", marker: "HIREfixture", projectId: "project", inputs: hiringTemplateInputs,
    expectedCeoFiles: ceo, leadInstructions: { mode: "managed", entryFile: "AGENTS.md", files: ceo },
    expectedSourceHashes: hashes, servedSourceHashes: { ...hashes }, assignedSkills: [HIRING_TEMPLATE_SKILL_KEY], coderExample: coder,
    hiredInstructions: { mode: "managed", entryFile: "AGENTS.md", files: { "AGENTS.md": coder } },
    hiredInstructionsAfterReuse: { mode: "managed", entryFile: "AGENTS.md", files: { "AGENTS.md": coder } },
    hiredSkills: [], hiredSkillsAfterReuse: [],
    agents: [{ ...turnFixture.evidence.agents[0], id: "lead", name: "CEO", adapterConfig: { model: "model" } },
      { ...turnFixture.evidence.agents[1], id: "coder", name: "Casey", role: "engineer", reportsTo: "lead", adapterType: "paperclip_runner", createdAt: hiredAt,
        adapterConfig: { model: "model" }, runtimeConfig: { aiConnection: binding } }],
    connectionId: "account", binding, tasks, runs, first, firstAfterReuse: { ...first }, second: document("second-task", "REUSEHIREfixture", reuseValues),
    turnApiState: turnFixture.apiState,
    readRuns: [...turnFixture.evidence.readRuns, { runId: "lead-1", agentId: "lead", events: HIRING_TEMPLATE_READ_FILES.flatMap(commandEvents) }] };
}
function fails(evidence: HiringTemplateEvidence, id: string) {
  expect(gradeHiringTemplate(evidence).checks.find(check => check.id === id)?.passed, id).toBe(false);
}

describe("production hiring template oracle", () => {
  it("independently grades the child fixtures and accepts JSON object key order", () => {
    const e = validEvidence();
    expect(gradeHiringTemplate(e)).toMatchObject({ outcomePassed: true, comparisonStatus: "comparable" });
    e.first!.body = `\`\`\`json\n${JSON.stringify({ entries: hiringTemplateInputs.map((input, index) => ({ value: values[index], input })), reference: e.marker })}\n\`\`\``;
    e.firstAfterReuse = { ...e.first! };
    expect(gradeHiringTemplate(e).outcomePassed).toBe(true);
    for (const wrongBody of ["{}", "not JSON", JSON.stringify({ reference: e.marker, entries: [{ input: hiringTemplateInputs[0], value: "launch-queue" }] }),
      JSON.stringify({ reference: e.marker, entries: hiringTemplateInputs.map(input => ({ input, value: input.toLowerCase() })) })]) {
      fails({ ...e, first: { ...e.first!, body: wrongBody } }, "initial-json-artifact");
    }
    fails({ ...e, second: { ...e.second!, body: e.first!.body } }, "reused-json-artifact");
    fails({ ...e, first: { ...e.first!, createdByAgentId: "lead" } }, "initial-json-artifact");
  });

  it("requires the real hired identity, account, two distinct tasks and exactly five required successful work turns", () => {
    const e = validEvidence();
    fails({ ...e, agents: [...e.agents, { ...e.agents[1]!, id: "replacement" }] }, "one-coder-hire");
    for (const wrong of [{ role: "qa" }, { reportsTo: "somebody" }, { adapterType: "codex_local" }, { name: "Another coder" }]) {
      fails({ ...e, agents: [e.agents[0]!, { ...e.agents[1]!, ...wrong }] }, "one-coder-hire");
    }
    fails({ ...e, agents: [e.agents[0]!, { ...e.agents[1]!, adapterConfig: { model: "different" } }] }, "execution-account");
    fails({ ...e, agents: [e.agents[0]!, { ...e.agents[1]!, runtimeConfig: { aiConnection: { ...binding, mode: "company" } } }] }, "execution-account");
    for (const patch of [{ assigneeAgentId: "lead" }, { parentId: "chat" }, { projectId: "other" }, { status: "backlog" }]) {
      fails({ ...e, tasks: [e.tasks[0]!, { ...e.tasks[1]!, ...patch }] }, "two-worker-tasks");
    }
    fails({ ...e, runs: e.runs.slice(1) }, "bounded-work-and-completion-turns");
    fails({ ...e, runs: [...e.runs, { ...e.runs[0]!, id: "extra" }] }, "bounded-work-and-completion-turns");
    fails({ ...e, runs: e.runs.map(r => r.id === "worker-reuse" ? { ...r, contextSnapshot: { issueId: "second-task", aiConnection: { connectionId: "other" } } } : r) }, "bounded-work-and-completion-turns");
    fails({ ...e, runs: e.runs.map(r => r.id === "lead-status" ? { ...r, agentId: "coder" } : r) }, "bounded-work-and-completion-turns");
    fails({ ...e, firstAfterReuse: { ...e.first!, latestRevisionId: "modified" } }, "original-preserved");
  });

  it("compares each revision's bundle and example without imposing candidate length on baseline", async () => {
    const historical = validEvidence();
    const oldFiles = { "AGENTS.md": "A long historical CEO role.\n".repeat(40), "HEARTBEAT.md": "Heartbeat", "SOUL.md": "Identity", "TOOLS.md": "Tools" };
    historical.expectedCeoFiles = oldFiles;
    historical.leadInstructions!.files = oldFiles;
    for (const file of Object.keys(oldFiles)) historical.expectedSourceHashes[`server/src/onboarding-assets/ceo/${file}`] = historical.servedSourceHashes[`server/src/onboarding-assets/ceo/${file}`] = hiringTemplateHash(oldFiles[file as keyof typeof oldFiles]);
    // Exact baseline source: skills/paperclip-create-agent/references/agents/coder.md
    // at d7bdfc422cadcc407f2945e211833a8382b80117. Its SHA-256 below
    // preserves the actual historical text and all four placeholder kinds.
    const historicalReference = await readFile(new URL("./fixtures/hiring-templates/coder.d7bdfc4.md", import.meta.url), "utf8");
    expect(hiringTemplateHash(historicalReference)).toBe("766c6f5db907f3dc2e317d540feb80e77358202c59d759449228a32450fa6202");
    historical.coderExample = renderHiringCoderExample(historicalReference, "Casey", "Fixture Company", "CEO", "FIX");
    expect(historical.coderExample).not.toMatch(/\{\{[^}]+\}\}/);
    expect(historical.coderExample).toContain("You report to CEO.");
    expect(historical.coderExample.match(/\/FIX\/agents\//g)).toHaveLength(3);
    historical.hiredInstructions!.files["AGENTS.md"] = historical.hiredInstructionsAfterReuse!.files["AGENTS.md"] = historical.coderExample;
    const result = gradeHiringTemplate(historical);
    expect(result).toMatchObject({ outcomePassed: true, comparisonStatus: "comparable" });
    expect(result.instructionSizes.coder.words).toBeGreaterThan(200);
    const e = validEvidence();
    fails({ ...e, leadInstructions: { ...e.leadInstructions!, files: { "AGENTS.md": "Custom fixture lead" } } }, "production-ceo-bundle");
    fails({ ...e, leadInstructions: { ...e.leadInstructions!, files: { ...ceo, "SOUL.md": "unexpected legacy file" } } }, "production-ceo-bundle");
    fails({ ...e, hiredInstructions: { ...e.hiredInstructions!, files: { "AGENTS.md": "Generic default worker instructions" } } }, "supplied-coder-instructions");
    fails({ ...e, hiredInstructionsAfterReuse: undefined }, "hired-instructions-durable");
    fails({ ...e, hiredSkillsAfterReuse: ["changed"] }, "hired-skills-durable");
  });

  it("separates successful workflow outcomes from missing or mismatched source coverage", () => {
    const e = validEvidence();
    for (const patch of [{ readRuns: e.readRuns.filter(run => run.runId !== "lead-1") }, { assignedSkills: [] }, { expectedSourceHashes: {} }, { servedSourceHashes: {} },
      { servedSourceHashes: { ...e.servedSourceHashes, "skills/paperclip-create-agent/SKILL.md": hiringTemplateHash("other checkout") } }]) {
      expect(gradeHiringTemplate({ ...e, ...patch })).toMatchObject({ outcomePassed: true, comparisonStatus: "uncomparable" });
    }
    const incomplete = { ...e.expectedSourceHashes };
    delete incomplete["skills/paperclip-create-agent/references/agents/coder.md"];
    fails({ ...e, expectedSourceHashes: incomplete }, "source-fingerprints");
  });

  it("requires a completed pre-hire lead read rather than an echoed path, failed read or listing", () => {
    const e = validEvidence(), good = e.readRuns.find(run => run.runId === "lead-1")!;
    for (const command of ["echo /workspace/.agents/skills/paperclip-create-agent/SKILL.md", "ls /workspace/.agents/skills/paperclip-create-agent/SKILL.md",
      "cat /workspace/.agents/skills/wrong-skill/SKILL.md", "cat $SKILL/SKILL.md", "cat /workspace/.agents/skills/paperclip-create-agent/SKILL.md > /dev/null",
      ...["cat --help", "cat --version", "head --help", "tail --version", "head -n 0", "tail -c 0", "sed -n ''", "sed -n '1q'", "sed -n 'q'", "sed --help", "sed -n '1,200w /tmp/other'", "cat -n"].map(prefix => `${prefix} /workspace/.agents/skills/paperclip-create-agent/SKILL.md`),
      'cat "/workspace/.agents/skills/paperclip-create-agent/SKILL.md""suffix"' ]) {
      const events = commandEvents("SKILL.md");
      const payload = events[0]!.payload.prpEvent.payload as Record<string, unknown>;
      payload.name = command;
      expect(hiringTemplateReadReceipts([{ ...good, events }], "lead"), command).toHaveLength(0);
    }
    fails({ ...e, readRuns: [{ ...good, agentId: "coder" }] }, "production-source-reads");
    fails({ ...e, readRuns: [{ ...good, events: good.events.slice(1) }] }, "production-source-reads");
    fails({ ...e, readRuns: [{ ...good, events: good.events.map(event => ({ ...event, createdAt: "2026-10-01T12:02:00Z" })) }] }, "production-source-reads");
    fails({ ...e, readRuns: [{ ...good, events: good.events.map(event => ({ ...event, createdAt: undefined })) }] }, "production-source-reads");
    const failed = commandEvents("SKILL.md");
    (failed[0]!.payload.prpEvent.payload as Record<string, unknown>).exitCode = 1;
    expect(hiringTemplateReadReceipts([{ ...good, events: failed }], "lead")).toHaveLength(0);
    const noOutput = commandEvents("SKILL.md");
    (noOutput[0]!.payload.prpEvent.payload as Record<string, unknown>).outputBytes = 0;
    expect(hiringTemplateReadReceipts([{ ...good, events: noOutput }], "lead")).toHaveLength(0);
  });

  it("accepts only supported direct read arguments and does not trust process read hints", () => {
    const path = "/workspace/.agents/skills/paperclip-create-agent/SKILL.md";
    for (const command of [`cat ${path}`, `cat -- '${path}'`, `head -n 200 ${path}`, `head -n200 ${path}`, `tail -c 200 ${path}`,
      `sed -n '1,200p' ${path}`, `sed -n -e 'p' ${path}`]) {
      const events = commandEvents("SKILL.md");
      (events[0]!.payload.prpEvent.payload as Record<string, unknown>).name = command;
      expect(hiringTemplateReadReceipts([{ runId: "lead-1", agentId: "lead", events }], "lead"), command).toHaveLength(1);
    }
    const events = commandEvents("SKILL.md");
    Object.assign(events[0]!.payload.prpEvent.payload, { name: `cat --help ${path}`, operation: "read", readOnly: true, target: ".agents/skills/paperclip-create-agent/SKILL.md" });
    expect(hiringTemplateReadReceipts([{ runId: "lead-1", agentId: "lead", events }], "lead")).toHaveLength(0);
  });

  it("uses the production ACPX event mapper and leaves redacted absolute read paths uncomparable", () => {
    const events = HIRING_TEMPLATE_READ_FILES.flatMap(file => canonicalProviderEventsFromAcpxRuntimeEvent({
      type: "tool_call", tag: "tool_call_update", toolCallId: `read-${file}`, title: "Read", kind: "read", status: "completed",
      locations: [{ path: `.agents/skills/paperclip-create-agent/${file}` }], rawOutput: "Source bytes",
    } as never, `read-${file}`).map(event => ({ eventType: event.eventType, createdAt: beforeHire, payload: { prpEvent: event } })));
    expect(gradeHiringTemplate({ ...validEvidence(), readRuns: [{ runId: "lead-1", agentId: "lead", events }] }).comparisonStatus).toBe("comparable");
    const absolute = canonicalProviderEventsFromAcpxRuntimeEvent({ type: "tool_call", tag: "tool_call_update", toolCallId: "read", title: "Read", kind: "read", status: "completed",
      locations: [{ path: "/workspace/.agents/skills/paperclip-create-agent/SKILL.md" }], rawOutput: "Source bytes" } as never, "read");
    expect(hiringTemplateReadReceipts([{ runId: "lead-1", agentId: "lead", events: absolute.map(event => ({ eventType: event.eventType, payload: { prpEvent: event } })) }], "lead")).toHaveLength(0);
  });
});

describe("executable hiring lifecycle count guards", () => {
  const task = { expectedRunCount: 7, minimumExpectedRunCount: 5 };
  it("grades and admits five required work turns with zero, batched or distinct completion turns", () => {
    for (const count of [0, 1, 2]) {
      const evidence = validEvidence(count);
      const result = gradeHiringTemplate(evidence);
      expect(result).toMatchObject({ outcomePassed: true, comparisonStatus: "comparable", turnAccounting: {
        passed: true, counts: { requestedLeadTurns: 3, coderTurns: 2, completionTurns: count,
          actualRunCount: 5 + count, costAccountingRunCount: 5 + count, unclassifiedTurns: 0 },
      } });
      expect(assertChatFlowRunCount({ suiteId: "hiring-templates", task, runs: evidence.runs,
        hiringEvidence: evidence, hiringApiState: evidence.turnApiState })?.passed).toBe(true);
    }
  });
  it("rejects an arbitrary same-count wake in both executable paths", () => {
    const evidence = validEvidence(2);
    const notification = evidence.runs.find(run => run.contextSnapshot?.wakeReason === "chat_task_completed")!;
    notification.contextSnapshot!.wakeReason = "heartbeat_timer";
    (evidence.turnApiState as { runs: unknown[] }).runs = structuredClone(evidence.runs);
    fails(evidence, "bounded-work-and-completion-turns");
    expect(() => assertChatFlowRunCount({ suiteId: "hiring-templates", task, runs: evidence.runs,
      hiringEvidence: evidence, hiringApiState: evidence.turnApiState })).toThrow();
  });
  it("rejects unrelated notification document writes in both executable paths", () => {
    const evidence = validEvidence(2);
    const ledger = evidence.readRuns.find(run => run.runId === "notify-1")!;
    for (const event of ledger.events) {
      const payload = (event.payload as Record<string, any>).prpEvent.payload;
      if (payload.name) payload.name = "write_document";
      if (payload.item?.name) payload.item.name = "write_document";
    }
    fails(evidence, "bounded-work-and-completion-turns");
    expect(() => assertChatFlowRunCount({ suiteId: "hiring-templates", task, runs: evidence.runs,
      hiringEvidence: evidence, hiringApiState: evidence.turnApiState })).toThrow();
    expect(gradeHiringTemplate(evidence).turnAccounting.actionEvidence.status).toBe("violated");
  });
  it("requires public lifecycle observations and preserves source/template coverage failures", () => {
    const evidence = validEvidence(2);
    fails({ ...evidence, turnApiState: undefined }, "bounded-work-and-completion-turns");
    expect(() => assertChatFlowRunCount({ suiteId: "hiring-templates", task, runs: evidence.runs,
      hiringEvidence: evidence })).toThrow();
    const changedInstructions = { ...evidence.hiredInstructions!, files: { "AGENTS.md": `${coder} Changed punctuation.` } };
    const result = gradeHiringTemplate({ ...evidence, readRuns: evidence.readRuns.filter(run => run.runId !== "lead-1"), hiredInstructions: changedInstructions,
      hiredInstructionsAfterReuse: structuredClone(changedInstructions) });
    expect(result).toMatchObject({ outcomePassed: true, comparisonStatus: "uncomparable", turnAccounting: { passed: true } });
    expect(result.checks.filter(check => check.dimension === "coverage" && !check.passed).map(check => check.id))
      .toEqual(["production-source-reads", "supplied-coder-instructions"]);
  });
  it("keeps every non-hiring chat count guard unchanged", () => {
    const runs = validEvidence(2).runs;
    for (const suiteId of ["agent-chat", "agent-chat-hardening", "agent-chat-qualification", "context-integrity"]) {
      expect(() => assertChatFlowRunCount({ suiteId, task: { expectedRunCount: 2 }, runs: runs.slice(0, 2) })).not.toThrow();
      expect(() => assertChatFlowRunCount({ suiteId, task: { expectedRunCount: 2 }, runs: runs.slice(0, 3) })).toThrow();
    }
  });
});

describe("production hiring fixture wiring and source observations", () => {
  it("keeps two explicit local native cells, production permissions and bounded five-work-turn scope", () => {
    const cells = runnerMatrix.filter(cell => cell.suite.id === "hiring-templates");
    expect(cells.map(cell => cell.id)).toEqual(["hiring-templates.runner-codex.local.hire-coder-template-reuse", "hiring-templates.runner-acpx-claude.local.hire-coder-template-reuse"]);
    expect(runnerSuites.find(suite => suite.id === "hiring-templates")?.manualOnly).toBe(true);
    for (const cell of cells) {
      expect(cell.task.expectedRunCount).toBe(7);
      expect(cell.task.minimumExpectedRunCount).toBe(5);
      expect(cell.task.attemptTimeoutMs?.local).toBe(15 * 60_000);
      expect(buildRunnerE2EProcessEnvironment({}, [cell]).PAPERCLIP_RUNNER_API_TOOLS_ENABLED).toBe("true");
      const payload = cell.profile.buildAgent({ executionId: "fixture", workspacePath: "/workspace", environmentId: "env", environmentFixtureId: "local",
        secretRefs: { [cell.profile.credential]: { type: "secret_ref", secretId: "secret", version: "latest" } } });
      expect(payload).toMatchObject({ role: "ceo", adapterType: "paperclip_runner" });
      expect(payload).not.toHaveProperty("instructionsBundle");
      expect(payload.adapterConfig).not.toHaveProperty("instructionsBundleMode");
      expect(payload.adapterConfig).not.toHaveProperty("codexPermissionMode");
      expect(payload.adapterConfig).not.toHaveProperty("acpxPermissionMode");
    }
    const scenario = hiringTemplateScenario("matched-fixture", "Project");
    expect(scenario.initialPrompt).toBe(hiringTemplateScenario("matched-fixture", "Project").initialPrompt);
    expect(scenario.reusePrompt("TASK-1")).toBe(hiringTemplateScenario("matched-fixture", "Project").reusePrompt("TASK-1"));
  });

  it("reads the actual default CEO selection and served hiring files through public APIs", async () => {
    const files = await loadDefaultAgentInstructionsBundle("ceo");
    const get = async (path: string) => {
      if (path.endsWith("/instructions-bundle")) return { mode: "managed", entryFile: "AGENTS.md", files: Object.keys(files).map(path => ({ path })) };
      if (path.includes("instructions-bundle/file?")) return { content: files[new URL(path, "http://fixture").searchParams.get("path")!] };
      if (path === "/api/companies/company/skills") return [{ id: "creator", key: HIRING_TEMPLATE_SKILL_KEY }];
      if (path === "/api/agents/lead/skills?companyId=company") return { desiredSkills: [HIRING_TEMPLATE_SKILL_KEY] };
      if (path.startsWith("/api/companies/company/skills/creator/files?")) return { content: await readFile(new URL(`../../skills/paperclip-create-agent/${new URL(path, "http://fixture").searchParams.get("path")}`, import.meta.url), "utf8") };
      throw new Error(`Unexpected public read ${path}`);
    };
    const api = { get } as Pick<RunnerApi, "get">;
    const source = await readHiringTemplateSources(api, "company", "lead");
    expect(source.leadInstructions.files).toEqual(files);
    expect(source.expectedCeoFiles).toEqual(files);
    expect(source.servedSourceHashes).toEqual(source.expectedSourceHashes);
    expect(source.assignedSkills).toContain(HIRING_TEMPLATE_SKILL_KEY);
    expect(source.loaderHash).toMatch(/^[a-f0-9]{64}$/);
    expect(renderHiringCoderExample(source.coderReference, "Casey", "Company", "CEO", "FIX")).not.toContain("{{");
    const wrongApi = { get: async (path: string) => path.includes("/files?") ? { content: "different revision" } : get(path) } as Pick<RunnerApi, "get">;
    const wrongSource = await readHiringTemplateSources(wrongApi, "company", "lead");
    expect(wrongSource.servedSourceHashes).not.toEqual(wrongSource.expectedSourceHashes);
  });

  it("retains baseline policy files while excluding binary files and generated personal notes", async () => {
    const api = { get: async (path: string) => path.endsWith("/instructions-bundle")
      ? { mode: "managed", entryFile: "AGENTS.md", files: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md", "notes/today.md"].map(path => ({ path, binary: false })).concat([{ path: "image.png", binary: true }]) }
      : { content: new URL(path, "http://fixture").searchParams.get("path") } } as Pick<RunnerApi, "get">;
    expect(Object.keys((await readHiringInstructions(api, "lead")).files)).toEqual(["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"]);
    expect(renderHiringCoderExample("Historical example\n```md\nYou are {{agentName}} at {{companyName}}. Report to {{managerTitle}}.\nLarge manual content.\n```", "Casey", "Company", "CEO", "FIX"))
      .toBe("You are Casey at Company. Report to CEO.\nLarge manual content.");
    expect(() => renderHiringCoderExample("No example", "Casey", "Company", "CEO", "FIX")).toThrow();
  });
});

describe("settled hiring observation", () => {
  function observation(count = 2) {
    const f = createHiringTemplateTurnFixture(count);
    const apiState = { ...f.apiState, issue: { ...f.apiState.issue, title: "Hiring fixture", status: "in_review", conversationState: "waiting" },
      wakes: { events: [], truncated: false } };
    return { agents: f.evidence.agents, tasks: f.evidence.tasks, runs: f.evidence.runs,
      readRuns: [], apiState, finalApiState: structuredClone(apiState) };
  }
  it("retries the whole snapshot when a completion appears between ledger reads", async () => {
    const racing = observation(), settled = observation();
    racing.runs = racing.runs.filter(run => run.id !== "notify-2");
    racing.apiState.runs = structuredClone(racing.runs);
    let reads = 0;
    const value = await waitForSettledHiringObservation(async () => ++reads === 1 ? racing : settled,
      { deadlineAt: Date.now() + 1000, intervalMs: 0 });
    expect(reads).toBe(3);
    expect(value.runs).toHaveLength(7);
  });
  it("awaits pending completion wakes and then two stable observations", async () => {
    const pending = observation(), settled = observation();
    const wakes = { events: [{ kind: "wake_request", status: "queued", finishedAt: null }], truncated: false };
    pending.apiState.wakes = pending.finalApiState.wakes = wakes as typeof pending.apiState.wakes;
    let reads = 0;
    await waitForSettledHiringObservation(async () => ++reads === 1 ? pending : settled,
      { deadlineAt: Date.now() + 1000, intervalMs: 0 });
    expect(reads).toBe(3);
  });
  it("awaits an outbox completion not yet represented by a wake or run", async () => {
    const awaitingCallback = observation(0), settled = observation(1);
    let reads = 0;
    const value = await waitForSettledHiringObservation(async () => ++reads === 1 ? awaitingCallback : settled,
      { deadlineAt: Date.now() + 1000, intervalMs: 0 });
    expect(reads).toBe(3);
    expect(value.runs).toHaveLength(6);
  });
  it("never admits truncated diagnostics, active runs or inconsistent observations", async () => {
    for (const defect of ["truncated", "active", "inconsistent"] as const) {
      const bad = observation();
      if (defect === "truncated") bad.apiState.wakes.truncated = bad.finalApiState.wakes.truncated = true;
      if (defect === "active") bad.runs[0]!.status = "running";
      if (defect === "inconsistent") bad.finalApiState.comments.pop();
      await expect(waitForSettledHiringObservation(async () => bad,
        { deadlineAt: Date.now() + 10, intervalMs: 0 })).rejects.toThrow(/Timed out/);
    }
  });
});

it("requires attributable callback replies and does not ignore unresolved coalesced or unknown wakes", async () => {
  const f = createHiringTemplateTurnFixture(2);
  const state = { ...f.apiState, issue: { ...f.apiState.issue, title: "Fixture", status: "in_review", conversationState: "waiting" },
    wakes: { events: [] as Array<{ kind: string; status: string; runId?: string }>, truncated: false } };
  const valid = { agents: f.evidence.agents, tasks: f.evidence.tasks, runs: f.evidence.runs,
    readRuns: f.evidence.readRuns, apiState: state, finalApiState: structuredClone(state) };
  for (const defect of ["reply", "coalesced", "unknown", "scheduled-retry", "duplicate-callback"] as const) {
    const bad = structuredClone(valid);
    if (defect === "reply") bad.apiState.comments = bad.finalApiState.comments = [];
    if (defect === "coalesced") bad.apiState.wakes.events = bad.finalApiState.wakes.events = [{ kind: "wake_request", status: "coalesced", runId: "missing" }];
    if (defect === "unknown") bad.apiState.wakes.events = bad.finalApiState.wakes.events = [{ kind: "wake_request", status: "other" }];
    if (defect === "scheduled-retry") bad.runs[0]!.status = "scheduled_retry";
    if (defect === "duplicate-callback") bad.runs.push(structuredClone(bad.runs.find(run => run.id === "notify-1")!));
    await expect(waitForSettledHiringObservation(async () => bad,
      { deadlineAt: Date.now() + 10, intervalMs: 0 })).rejects.toThrow(/Timed out/);
  }
});

it("admits completed and accounted coalesced wake bookkeeping after callbacks", async () => {
  const f = createHiringTemplateTurnFixture(2);
  const state = { ...f.apiState, issue: { ...f.apiState.issue, title: "Fixture", status: "in_review", conversationState: "waiting" },
    wakes: { events: [{ kind: "wake_request", status: "completed", runId: "notify-1" },
      { kind: "wake_request", status: "coalesced", runId: "notify-2" }], truncated: false } };
  const observation = { agents: f.evidence.agents, tasks: f.evidence.tasks, runs: f.evidence.runs,
    readRuns: f.evidence.readRuns, apiState: state, finalApiState: structuredClone(state) };
  let reads = 0;
  await waitForSettledHiringObservation(async () => { reads++; return observation; },
    { deadlineAt: Date.now() + 1000, intervalMs: 0 });
  expect(reads).toBe(2);
});

it("classifies absent notification action identity as uncomparable separately from unchanged source coverage", () => {
  const evidence = validEvidence(2);
  evidence.readRuns = evidence.readRuns.filter(run => run.runId === "lead-1");
  const result = gradeHiringTemplate(evidence);
  expect(result.comparisonStatus).toBe("uncomparable");
  expect(result.turnAccounting.actionEvidence.status).toBe("uncomparable");
  expect(result.checks.filter(check => check.dimension === "coverage" && !check.passed).map(check => check.id))
    .toEqual(["completion-action-attribution"]);
  expect(result.checks.find(check => check.id === "production-source-reads")?.passed).toBe(true);
});
