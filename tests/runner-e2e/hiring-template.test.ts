import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { buildRunnerE2EProcessEnvironment } from "./harness-env.js";
import { canonicalProviderEventsFromAcpxRuntimeEvent, canonicalProviderEventsFromCodex } from "../../packages/paperclip-runner/src/provider-events.js";
import { loadDefaultAgentInstructionsBundle } from "../../server/src/services/default-agent-instructions.js";
import { HIRING_TEMPLATE_READ_FILES, HIRING_TEMPLATE_SKILL_KEY, hiringTemplateInputs, hiringTemplateScenario } from "./hiring-template-cases.js";
import { readHiringInstructions, readHiringTemplateSources, renderHiringCoderExample } from "./hiring-template-flow.js";
import { gradeHiringTemplate, hiringTemplateHash, hiringTemplateReadReceipts, type HiringTemplateEvidence } from "./hiring-template-scoring.js";
import type { RunnerApi } from "./api.js";

const beforeHire = "2026-10-01T12:00:00.000Z", hiredAt = "2026-10-01T12:01:00.000Z";
const binding = { provider: "openai", method: "api_key", mode: "responsible_user" };
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
function validEvidence(): HiringTemplateEvidence {
  const sourceFiles = [...HIRING_TEMPLATE_READ_FILES.map(file => `skills/paperclip-create-agent/${file}`),
    "skills/paperclip-create-agent/references/baseline-role-guide.md", "server/src/onboarding-assets/ceo/AGENTS.md"];
  const hashes = Object.fromEntries(sourceFiles.map(file => [file, hiringTemplateHash(file)]));
  const tasks = ["first", "second"].map(id => ({ id, companyId: "company", title: id, status: "done", assigneeAgentId: "coder", projectId: "project", parentId: null }));
  const runs = ["lead-1", "lead-2", "lead-3", "first", "second"].map(id => ({ id, companyId: "company", agentId: id.startsWith("lead") ? "lead" : "coder",
    status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: id.startsWith("lead") ? "chat" : id, aiConnection: { connectionId: "account" } } }));
  const document = (issueId: string, reference: string, outputs: string[]) => ({ issueId, key: "fixture", latestRevisionId: `${issueId}-revision`, createdByAgentId: "coder",
    body: JSON.stringify({ reference, entries: hiringTemplateInputs.map((input, index) => ({ input, value: outputs[index] })) }) });
  const first = document("first", "HIREfixture", values);
  return { leadId: "lead", chatIssueId: "chat", hireName: "Casey", marker: "HIREfixture", projectId: "project", inputs: hiringTemplateInputs,
    expectedCeoFiles: ceo, leadInstructions: { mode: "managed", entryFile: "AGENTS.md", files: ceo },
    expectedSourceHashes: hashes, servedSourceHashes: { ...hashes }, assignedSkills: [HIRING_TEMPLATE_SKILL_KEY], coderExample: coder,
    hiredInstructions: { mode: "managed", entryFile: "AGENTS.md", files: { "AGENTS.md": coder } },
    hiredInstructionsAfterReuse: { mode: "managed", entryFile: "AGENTS.md", files: { "AGENTS.md": coder } },
    hiredSkills: [], hiredSkillsAfterReuse: [],
    agents: [{ id: "lead", name: "CEO", adapterConfig: { model: "model" } },
      { id: "coder", name: "Casey", role: "engineer", reportsTo: "lead", adapterType: "paperclip_runner", createdAt: hiredAt,
        adapterConfig: { model: "model" }, runtimeConfig: { aiConnection: binding } }],
    connectionId: "account", binding, tasks, runs, first, firstAfterReuse: { ...first }, second: document("second", "REUSEHIREfixture", reuseValues),
    readRuns: [{ runId: "lead-1", agentId: "lead", events: HIRING_TEMPLATE_READ_FILES.flatMap(commandEvents) }] };
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

  it("requires the real hired identity, account, two distinct tasks and exactly five successful turns", () => {
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
    fails({ ...e, runs: e.runs.slice(1) }, "five-successful-turns");
    fails({ ...e, runs: [...e.runs, { ...e.runs[0]!, id: "extra" }] }, "five-successful-turns");
    fails({ ...e, runs: e.runs.map(r => r.id === "second" ? { ...r, contextSnapshot: { issueId: "second", aiConnection: { connectionId: "other" } } } : r) }, "five-successful-turns");
    fails({ ...e, runs: e.runs.map(r => r.id === "lead-3" ? { ...r, agentId: "coder" } : r) }, "five-successful-turns");
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
    for (const patch of [{ readRuns: [] }, { assignedSkills: [] }, { expectedSourceHashes: {} }, { servedSourceHashes: {} },
      { servedSourceHashes: { ...e.servedSourceHashes, "skills/paperclip-create-agent/SKILL.md": hiringTemplateHash("other checkout") } }]) {
      expect(gradeHiringTemplate({ ...e, ...patch })).toMatchObject({ outcomePassed: true, comparisonStatus: "uncomparable" });
    }
    const incomplete = { ...e.expectedSourceHashes };
    delete incomplete["skills/paperclip-create-agent/references/agents/coder.md"];
    fails({ ...e, expectedSourceHashes: incomplete }, "source-fingerprints");
  });

  it("requires a completed pre-hire lead read rather than an echoed path, failed read or listing", () => {
    const e = validEvidence(), good = e.readRuns[0]!;
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

describe("production hiring fixture wiring and source observations", () => {
  it("keeps two explicit local native cells, production permissions and five-turn scope", () => {
    const cells = runnerMatrix.filter(cell => cell.suite.id === "hiring-templates");
    expect(cells.map(cell => cell.id)).toEqual(["hiring-templates.runner-codex.local.hire-coder-template-reuse", "hiring-templates.runner-acpx-claude.local.hire-coder-template-reuse"]);
    expect(runnerSuites.find(suite => suite.id === "hiring-templates")?.manualOnly).toBe(true);
    for (const cell of cells) {
      expect(cell.task.expectedRunCount).toBe(5);
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
