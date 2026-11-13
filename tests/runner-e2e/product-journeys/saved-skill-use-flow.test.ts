import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalProviderEventsFromOpenCodePart } from "../../../packages/paperclip-runner/src/provider-events.js";
import { createPrpSemanticToolInputEnvelope, createPrpSemanticToolResultEnvelope } from "../../../packages/paperclip-runner/src/protocol/semantic-tool-receipts.js";
import { parseFrontmatterMarkdown } from "../../../packages/shared/src/frontmatter.js";
import { agentSkillSyncSchema } from "../../../packages/shared/src/validators/adapter-skills.js";
import { createTaskThroughUi } from "../user-actions.js";
import { runSavedSkillUse } from "./saved-skill-use-flow.js";
import { savedSkillFixture, type SavedSkillFixture } from "./saved-skill-use-evidence.js";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./types.js";

type Row = Record<string, any>;
vi.mock("../user-actions.js", async original => ({ ...await original<object>(), createTaskThroughUi: vi.fn() }));
vi.mock("./task-document-flow.js", async original => ({ ...await original<object>(), openDocumentAuthoring: vi.fn() }));
vi.mock("@playwright/test", () => ({ expect: (locator: { textContent(): Promise<string> }) => ({
  async toContainText(text: string) { expect(await locator.textContent()).toContain(text); },
}) }));
const directories: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function setup(change: (kind: string, row: any) => any = (_kind, row) => row, campaignId = "campaign", betaSkillsEnabled = false,
  wrappedRead: boolean | "assigned" | "codex" = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saved-skill-flow-")); directories.push(directory);
  let fixture: SavedSkillFixture;
  let skill: Row, assigned = false, issueCreated = false, reloaded = false;
  const savedSkills: Row[] = [];
  const own = vi.fn(async (_resource: Row) => {});
  const evidence = { checks: [] } as unknown as JourneyEvidence;
  const api = {
    origin: "https://qa.example.test",
    post: vi.fn(async (route: string, body: Row) => {
      if (route === "/api/companies/company/skills") {
        const reference = /receipt reference is ([a-f0-9]{32})/.exec(body.markdown)![1]!;
        fixture = savedSkillFixture(campaignId, reference);
        // createLocalSkill gives the parsed frontmatter name precedence over the API input name.
        const savedName = parseFrontmatterMarkdown(body.markdown).frontmatter.name;
        skill = { id: "skill", companyId: "company", key: `company/company/${fixture.slug}`, sourceType: "managed", slug: fixture.slug,
          name: typeof savedName === "string" && savedName.trim() ? savedName.trim() : body.name,
          markdown: body.markdown, currentVersionId: "version" };
        savedSkills.push(structuredClone(skill));
        return change("create-skill", structuredClone(skill));
      }
      if (route === "/api/agents/agent/skills/sync?companyId=company") {
        const parsed = agentSkillSyncSchema.parse(body);
        // Core normalizes a string selection to Latest; only a non-null pin requires Beta skills.
        const selections = parsed.desiredSkills.map(value => typeof value === "string" ? { key: value, versionId: null } : value);
        if (!betaSkillsEnabled && selections.some(entry => entry.versionId !== null)) throw new Error("Beta skill version pins require Beta skills");
        expect(parsed).toEqual({ desiredSkills: [skill.key], mode: "add" });
        assigned = true; return {};
      }
      throw new Error(`Unexpected mutation ${route}`);
    }),
    get: vi.fn(async (route: string) => {
      if (route === "/api/instance/settings/experimental") return { enableBetaSkills: betaSkillsEnabled };
      if (route === "/api/companies/company/skills/skill") return change(reloaded ? "retained-skill" : "skill", structuredClone(skill));
      if (route === "/api/companies/company/skills/skill/versions/version") return change(reloaded ? "retained-version" : "version", {
        id: "version", companyId: "company", companySkillId: "skill", fileInventory: [{ path: "SKILL.md", content: fixture.markdown }],
      });
      if (route === "/api/agents/agent/skills?companyId=company") return change("assignment", {
        desiredSkillEntries: assigned ? [{ key: skill.key, versionId: null }] : [],
        entries: assigned ? [{ key: skill.key, versionId: "version", runtimeName: `${fixture.slug}--0123456789` }] : [],
      });
      if (!issueCreated) throw new Error("Measured result was read before browser dispatch");
      if (route === "/api/issues/issue") return { id: "issue", identifier: "QA-1", companyId: "company", assigneeAgentId: "agent", status: "done",
        description: change("description", vi.mocked(createTaskThroughUi).mock.calls.at(-1)![0].prompt) };
      if (route === "/api/issues/issue/runs") return change("runs", [{ runId: "run" }]);
      if (route === "/api/issues/issue/comments?order=asc" || route === "/api/issues/issue/interactions") return [];
      if (route === "/api/heartbeat-runs/run") return change("run", { id: "run", companyId: "company", agentId: "agent", issueId: "issue",
        status: "succeeded", runtimeMode: "native", nativePhase: "committed", resultJson: null,
        runnerInstanceId: "instance", nativeSessionId: "session",
        contextSnapshot: { paperclipEnvironment: { id: "environment" }, skillSelectionSnapshot: true, skillVersions: { [skill.key]: "version" } },
        runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: "model" },
          runtimeContext: { skills: [{ key: skill.key, versionId: "version", runtimeName: `${fixture.slug}--0123456789` }] } } } });
      if (route.startsWith("/api/heartbeat-runs/run/events?")) {
        if (wrappedRead === "codex") {
          const correlation = { runId: "run", normalizedSessionId: "session", turnId: "turn", itemId: "item" };
          const input = { skill: skill.key };
          const result = change("assigned-read", { skill: skill.key, versionId: skill.currentVersionId,
            path: "SKILL.md", text: fixture.markdown, sha256: createHash("sha256").update(fixture.markdown).digest("hex"),
            byteSize: Buffer.byteLength(fixture.markdown), nextOffset: null });
          const semantic = [{ ...createPrpSemanticToolInputEnvelope({ operationId: "read_assigned_skill", callId: "load",
            correlation, content: input }), input }, createPrpSemanticToolResultEnvelope({ operationId: "read_assigned_skill",
            callId: "load", correlation, content: result, outcome: "succeeded", code: "semantic_tool_succeeded",
            retryable: false, authorizationBoundary: "active_task", operationReceiptId: "operation_load" })];
          return semantic.map((value, i) => change("event", { runId: "run", companyId: "company", agentId: "agent",
            seq: i + 1, sourceSeq: i + 1, sourceEventId: `event-${i}`, sourceInstanceId: "instance", protocolSchemaVersion: 1,
            eventType: `semantic_tool.${value.phase}`, payload: { prpEvent: { ...correlation,
              schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceSeq: i + 1,
              sourceEventId: `event-${i}`, sourceInstanceId: "instance", eventType: `semantic_tool.${value.phase}`,
              payload: { semantic_tool: value } } } }));
        }
        return ["pending", "completed"].map((status, i) => {
          const p = canonicalProviderEventsFromOpenCodePart({ id: "load", type: "tool", tool: "skill", state: {
            status, output: `<skill_content name="${fixture.slug}">\n${fixture.procedure}\n</skill_content>`,
          } })[0]!;
          if (wrappedRead === true) {
            const output = `<path>/workspace/.claude/skills/${fixture.slug}--0123456789/SKILL.md</path>\n<type>file</type>\n<content>\n`
              + fixture.markdown.trimEnd().split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n")
              + "\n(End of file - total 12 lines)\n</content>";
            Object.assign(p.payload, { name: "read", operation: "unknown", readOnly: true, target: null,
              output: status === "completed" ? output : "", outputBytes: status === "completed" ? Buffer.byteLength(output) : 0 });
          }
          if (wrappedRead === "assigned") {
            const result = { skill: skill.key, versionId: skill.currentVersionId, path: "SKILL.md", text: fixture.markdown,
              sha256: createHash("sha256").update(fixture.markdown).digest("hex"), byteSize: Buffer.byteLength(fixture.markdown), nextOffset: null };
            const output = JSON.stringify({ type: "inputText", text: JSON.stringify(change("assigned-read", result)) });
            Object.assign(p.payload, { name: "paperclip_read_assigned_skill", operation: "unknown", readOnly: true, target: null,
              output: status === "completed" ? output : "", outputBytes: status === "completed" ? Buffer.byteLength(output) : 0 });
          }
          return change("event", { runId: "run", companyId: "company", agentId: "agent", seq: i + 1, eventType: p.eventType,
            sourceEventId: `event-${i}`, sourceInstanceId: "instance", sourceSeq: i + 1, protocolSchemaVersion: 1,
            payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", runId: "run", turnId: "turn",
              eventType: p.eventType, sourceEventId: `event-${i}`, sourceInstanceId: "instance", sourceSeq: i + 1, payload: p.payload } } });
        });
      }
      if (route === "/api/issues/issue/documents") return change("documents", [{ key: fixture.key }]);
      if (route === `/api/issues/issue/documents/${fixture.key}`) return { id: "document", companyId: "company", issueId: "issue",
        key: fixture.key, format: "markdown", body: JSON.stringify(fixture.expected), latestRevisionId: "revision", latestRevisionNumber: 1,
        createdByAgentId: "agent", createdByUserId: null, updatedByAgentId: "agent", updatedByUserId: null };
      if (route === `/api/issues/issue/documents/${fixture.key}/revisions/revision`) return change("revision", {
        id: "revision", companyId: "company", issueId: "issue", documentId: "document", key: fixture.key, format: "markdown", revisionNumber: 1,
        createdByRunId: "run", createdByAgentId: "agent", createdByUserId: null, body: JSON.stringify(fixture.expected),
      });
      throw new Error(`Unexpected observation ${route}`);
    }),
  };
  const page = { goto: vi.fn(async () => {}), reload: vi.fn(async () => { reloaded = true; }),
    locator: vi.fn(() => ({ async textContent() { return JSON.stringify(fixture.expected); } })) };
  vi.mocked(createTaskThroughUi).mockImplementation(async input => {
    expect(assigned).toBe(true); expect(input.prompt).not.toContain(fixture.expected.reference);
    await input.beforeDispatch?.(); issueCreated = true; return { issueId: "issue", submittedAtMs: Date.now() };
  });
  const context = { api, page, company: { id: "company", issuePrefix: "QA" }, user: { id: "owner", name: "Owner" },
    environmentId: "environment", capabilities: ["company", "board-user", "task-write", "agent", "skill-write"],
    agent: { id: "agent", name: "Owned agent", provider: "opencode", model: "model", runtimeMode: "native" } } as unknown as JourneyContext;
  return { context, api, page, own, evidence, directory, savedSkills,
    run: (timeoutMs = 5000) => runSavedSkillUse(context, { own } as unknown as TargetSession, campaignId, evidence,
      { deadlineAt: Date.now() + timeoutMs, directory }) };
}

describe("saved skill journey orchestration", () => {
  it.each([{ kind: "codex" }, { kind: "acpx", agent: "cursor" }, { kind: "cursor_cloud" }])(
    "binds a common semantic read for provider %j without an OpenCode directory", async provider => {
      const f = await setup((kind, row) => {
        if (kind === "run") Object.assign(row.runnerProfileJson.nativeExecutionInput.provider, provider);
        return row;
      }, "campaign", false, provider.kind === "codex" ? "codex" : "assigned");
      f.context.agent!.provider = provider.kind;
      await f.run();
      expect(f.evidence.checks).toHaveLength(7);
      expect(f.evidence.checks.every(check => check.passed)).toBe(true);
      expect(f.page.reload).toHaveBeenCalledOnce();
    });
  it.each(["codex", "acpx", "cursor_cloud"])("rejects missing or foreign semantic assignment evidence for %s", async provider => {
    const changes: Array<{ target: string; mutate(row: Row): void }> = [
      { target: "assignment", mutate: row => { row.entries = []; } },
      { target: "run", mutate: row => { row.runnerProfileJson.nativeExecutionInput.runtimeContext.skills = []; } },
      { target: "run", mutate: row => { row.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0].versionId = "foreign"; } },
      { target: "assigned-read", mutate: row => { row.versionId = "foreign"; } },
    ];
    for (const { target, mutate } of changes) {
      const f = await setup((kind, row) => {
        if (kind === "run") Object.assign(row.runnerProfileJson.nativeExecutionInput.provider, { kind: provider,
          ...(provider === "acpx" ? { agent: "cursor" } : {}) });
        if (kind === target) mutate(row);
        return row;
      }, "campaign", false, provider === "codex" ? "codex" : "assigned");
      f.context.agent!.provider = provider;
      await expect(f.run()).rejects.toMatchObject({ outcome: "failed", code: "saved_skill_native_read_attributed" });
      expect(f.api.get.mock.calls.some(([route]) => route.includes("/documents"))).toBe(false);
      expect(f.page.reload).not.toHaveBeenCalled();
    }
  });
  it("verifies the ordinary semantic assigned-skill read through all seven checks with Beta skills off", async () => {
    const f = await setup(undefined, "campaign", false, "assigned"); await f.run();
    expect(f.evidence.checks).toHaveLength(7);
    expect(f.evidence.checks.every(check => check.passed)).toBe(true);
    expect(f.page.reload).toHaveBeenCalledOnce();
    expect(f.api.post).toHaveBeenCalledTimes(2);
    expect(createTaskThroughUi).toHaveBeenCalledOnce();
    expect(f.api.get.mock.calls.some(([route]) => route.includes("/settings/"))).toBe(false);
    const receipt = JSON.parse(await readFile(path.join(f.directory, "saved-skill-use-checks.json"), "utf8"));
    expect(receipt.receipts).toEqual([{ runId: "run", executionId: "load", seq: 2 }]);
    expect(receipt.reopened).toEqual(receipt.document);
    expect(receipt.retainedSkill).toEqual(receipt.skill);
  });
  it.each([
    ["wrong receipt key", "assigned-read", (r: Row) => { r.skill = "foreign"; }],
    ["wrong receipt version", "assigned-read", (r: Row) => { r.versionId = "stale"; }],
    ["partial source page", "assigned-read", (r: Row) => { r.nextOffset = r.text.length; }],
    ["semantic failure", "assigned-read", (r: Row) => { r.outcome = "failed"; }],
    ["wrong assigned version", "assignment", (r: Row) => { r.entries[0].versionId = "stale"; }],
    ["missing admitted skill", "run", (r: Row) => { r.runnerProfileJson.nativeExecutionInput.runtimeContext.skills = []; }],
    ["wrong admitted version", "run", (r: Row) => { r.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0].versionId = "stale"; }],
  ] as const)("rejects a semantic assigned-skill read with %s before reading its document", async (_label, target, mutate) => {
    const f = await setup((kind, row) => { if (kind === target) mutate(row); return row; }, "campaign", false, "assigned");
    await expect(f.run()).rejects.toMatchObject({ outcome: "failed", code: "saved_skill_native_read_attributed" });
    expect(f.api.get.mock.calls.some(([route]) => route.includes("/documents"))).toBe(false);
    expect(f.page.reload).not.toHaveBeenCalled();
  });
  it("assigns the input before browser dispatch and verifies native use, saved result and reload without setup supplying output", async () => {
    const f = await setup(); await f.run();
    expect(f.own.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({ kind: "skill", journeyId: "saved-skill-use" }),
      expect.objectContaining({ kind: "skill", id: "skill" }),
      expect.objectContaining({ kind: "issue", journeyId: "saved-skill-use" }),
      expect.objectContaining({ kind: "issue", id: "issue" }),
    ]);
    expect(f.api.post).toHaveBeenCalledTimes(2);
    expect(createTaskThroughUi).toHaveBeenCalledTimes(1);
    expect(f.page.reload).toHaveBeenCalledTimes(1);
    expect(f.evidence.checks).toHaveLength(7);
    expect(f.evidence.checks.every(check => check.passed)).toBe(true);
    const receipt = JSON.parse(await readFile(path.join(f.directory, "saved-skill-use-checks.json"), "utf8"));
    expect(receipt.receipts).toEqual([{ runId: "run", executionId: "load", seq: 2 }]);
    expect(receipt.reopened).toEqual(receipt.document);
    expect(receipt.retainedSkill).toEqual(receipt.skill);
    expect(receipt.retainedVersion).toEqual(receipt.version);
    expect(receipt.retainedAssignments).toEqual(receipt.assignments);
  });
  it("verifies the deployed wrapped native read and then independently checks the saved result and reload", async () => {
    const f = await setup(undefined, "campaign", false, true); await f.run();
    expect(f.evidence.checks).toHaveLength(7);
    expect(f.evidence.checks.every(check => check.passed)).toBe(true);
    expect(f.page.reload).toHaveBeenCalledOnce();
    expect(f.api.get.mock.calls.some(([route]) => route.includes("/documents/saved-skill-result/revisions/"))).toBe(true);
  });
  it.each([
    ["missing native skill", "run", (row: Row) => { row.runnerProfileJson.nativeExecutionInput.runtimeContext.skills = []; }],
    ["wrong native version", "run", (row: Row) => { row.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0].versionId = "stale"; }],
    ["wrong native name", "run", (row: Row) => { row.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0].runtimeName = "foreign"; }],
    ["wrong assigned version", "assignment", (row: Row) => { row.entries[0].versionId = "stale"; }],
    ["wrong assigned name", "assignment", (row: Row) => { row.entries[0].runtimeName = "foreign"; }],
  ] as const)("rejects a complete wrapped read with %s before inspecting its document", async (_label, target, mutate) => {
    const f = await setup((kind, row) => { if (kind === target) mutate(row); return row; }, "campaign", false, true);
    await expect(f.run()).rejects.toMatchObject({ outcome: "failed", code: "saved_skill_native_read_attributed" });
    expect(f.api.get.mock.calls.some(([route]) => route.includes("/documents"))).toBe(false);
    expect(f.page.reload).not.toHaveBeenCalled();
  });
  it.each([false, true])("uses ordinary Latest assignment with Beta skills %s and no setting read or write", async betaSkillsEnabled => {
    const f = await setup(undefined, "campaign", betaSkillsEnabled); await f.run();
    expect(f.api.post.mock.calls[1]).toEqual(["/api/agents/agent/skills/sync?companyId=company",
      { desiredSkills: [f.savedSkills[0]!.key], mode: "add" }]);
    expect(f.api.get.mock.calls.some(([route]) => route.includes("/settings/"))).toBe(false);
    expect(f.api.post.mock.calls.some(([route]) => route.includes("/settings/"))).toBe(false);
    expect(f.evidence.checks).toHaveLength(7);
    expect(f.evidence.checks.every(check => check.passed)).toBe(true);
  });
  it.each([
    ["missing snapshot", (row: Row) => { delete row.contextSnapshot.skillSelectionSnapshot; }],
    ["false snapshot", (row: Row) => { row.contextSnapshot.skillSelectionSnapshot = false; }],
    ["missing versions", (row: Row) => { delete row.contextSnapshot.skillVersions; }],
    ["null versions", (row: Row) => { row.contextSnapshot.skillVersions = null; }],
    ["array versions", (row: Row) => { row.contextSnapshot.skillVersions = []; }],
    ["foreign key", (row: Row) => { row.contextSnapshot.skillVersions = { foreign: "version" }; }],
    ["wrong version", (row: Row) => { Object.keys(row.contextSnapshot.skillVersions).forEach(key => { row.contextSnapshot.skillVersions[key] = "stale"; }); }],
  ] as const)("rejects an admitted run with %s before trusting its read or result", async (_label, mutate) => {
    const f = await setup((kind, row) => { if (kind === "run") mutate(row); return row; });
    await expect(f.run()).rejects.toMatchObject({ outcome: "failed", code: "saved_skill_run_version_mismatch" });
    expect(f.api.get.mock.calls.some(([route]) => route.includes("/events?") || route.includes("/documents"))).toBe(false);
    expect(f.page.reload).not.toHaveBeenCalled();
  });
  it.each([undefined, "stale"])("rejects a created-version receipt %s that cannot bind the immutable input", async currentVersionId => {
    const f = await setup((kind, row) => kind === "create-skill" ? { ...row, currentVersionId } : row);
    await expect(f.run()).rejects.toMatchObject({ outcome: "failed", code: "saved_skill_created_version_mismatch" });
    expect(f.api.post).toHaveBeenCalledTimes(1);
    expect(createTaskThroughUi).not.toHaveBeenCalled();
    expect(f.own).toHaveBeenCalledTimes(2);
  });
  it("rejects Latest source drift between creation and dispatch", async () => {
    let reads = 0;
    const f = await setup((kind, row) => kind === "skill" && ++reads === 2 ? { ...row, currentVersionId: "changed" } : row);
    await expect(f.run()).rejects.toMatchObject({ outcome: "failed", code: "saved_skill_assignment_bound" });
    expect(reads).toBe(2);
    expect(createTaskThroughUi).not.toHaveBeenCalled();
  });
  it("rejects another skill's complete native output even when the receipt document would be correct", async () => {
    const f = await setup((kind, row) => {
      if (kind === "event" && row.eventType === "tool.execution.completed") {
        const payload = row.payload.prpEvent.payload;
        payload.output = payload.output.replace(/<skill_content name="[^"]+">/, '<skill_content name="foreign">');
        payload.outputBytes = Buffer.byteLength(payload.output);
      }
      return row;
    });
    await expect(f.run()).rejects.toMatchObject({ outcome: "failed", code: "saved_skill_native_read_attributed" });
    expect(f.api.get.mock.calls.some(([route]) => route.includes("/documents"))).toBe(false);
  });
  it.each([null, { presentationDecision: { commentAction: "none" } }])(
    "qualifies authoritative committed finalization with optional resultJson %j", async resultJson => {
      const f = await setup((kind, row) => kind === "run" ? { ...row, resultJson } : row);
      await f.run();
      expect(f.evidence.checks).toHaveLength(7);
      expect(f.evidence.checks.every(check => check.passed)).toBe(true);
    });
  it.each([
    [null, null],
    [undefined, { presentationDecision: { commentAction: "none" } }],
    ["workspace_finalizing", null],
    ["retryable_failure", { finalizationPhase: "committed" }],
  ])("does not qualify Done and succeeded before native phase %s is committed", async (nativePhase, resultJson) => {
    const f = await setup((kind, row) => kind === "run" ? { ...row, nativePhase, resultJson } : row);
    await expect(f.run(250)).rejects.toMatchObject({ outcome: "failed", code: "saved_skill_task_not_completed" });
    expect(f.api.get.mock.calls.some(([route]) => route === "/api/heartbeat-runs/run")).toBe(true);
    expect(f.api.get.mock.calls.some(([route]) => route.includes("/events?") || route.includes("/documents"))).toBe(false);
    expect(f.page.reload).not.toHaveBeenCalled();
    const receipt = JSON.parse(await readFile(path.join(f.directory, "saved-skill-use-checks.json"), "utf8"));
    expect(receipt.state.taskRuns[0].nativePhase).toBe(nativePhase);
  });
  it("waits for native commit before qualifying the already saved current-run result", async () => {
    let runReads = 0;
    const f = await setup((kind, row) => {
      if (kind === "run") return { ...row, nativePhase: ++runReads === 1 ? "workspace_finalizing" : "committed",
        resultJson: { finalizationPhase: "committed" } };
      if (kind === "documents") expect(runReads).toBe(2);
      return row;
    });
    await f.run();
    expect(runReads).toBe(2);
    expect(f.evidence.checks.every(check => check.passed)).toBe(true);
  });
  it.each([
    ["assignment", "saved_skill_assignment_bound", (row: Row) => ({ ...row, desiredSkillEntries: [{ key: "unknown", versionId: null }] })],
    ["assignment", "saved_skill_assignment_bound", (row: Row) => ({ ...row, desiredSkillEntries: row.desiredSkillEntries.map((entry: Row) => ({ ...entry, versionId: "stale" })) })],
    ["assignment", "saved_skill_assignment_bound", (row: Row) => ({ ...row, desiredSkillEntries: row.desiredSkillEntries.map(({ key }: Row) => ({ key })) })],
    ["assignment", "saved_skill_assignment_bound", (row: Row) => ({ ...row, desiredSkillEntries: [] })],
    ["skill", "saved_skill_assignment_bound", (row: Row) => ({ ...row, sourceType: "local_path" })],
    ["version", "saved_skill_assignment_bound", (row: Row) => ({ ...row, fileInventory: [{ path: "SKILL.md", content: "changed source" }] })],
    ["runs", "saved_skill_run_limit_exceeded", (row: Row[]) => [...row, { runId: "extra" }]],
    ["event", "saved_skill_native_read_attributed", (row: Row) => ({ ...row, companyId: "foreign" })],
    ["documents", "saved_skill_unexpected_documents", (row: Row[]) => [...row, { key: "unrelated" }]],
    ["revision", "saved_skill_result_authored_by_run", (row: Row) => ({ ...row, createdByRunId: "foreign" })],
    ["retained-skill", "saved_skill_source_preserved", (row: Row) => ({ ...row, currentVersionId: "changed" })],
    ["retained-version", "saved_skill_source_preserved", (row: Row) => ({ ...row, fileInventory: [] })],
  ] as const)("fails closed on changed %s evidence and retains its failure checkpoint", async (kind, code, change) => {
    const f = await setup((which, row) => which === kind ? change(row as never) : row);
    await expect(f.run()).rejects.toMatchObject({ outcome: "failed", code });
    expect(await readFile(path.join(f.directory, "saved-skill-use-checks.json"), "utf8")).toContain("fixture");
    if (kind === "assignment" || kind === "version" || kind === "skill") expect(createTaskThroughUi).not.toHaveBeenCalled();
    else expect(createTaskThroughUi).toHaveBeenCalledTimes(1);
  });
  it("journals uncertain creation once without replaying it or dispatching a task", async () => {
    const f = await setup(); f.api.post.mockRejectedValueOnce(new Error("Response lost after POST"));
    await expect(f.run()).rejects.toThrow("Response lost after POST");
    expect(f.api.post).toHaveBeenCalledTimes(1);
    expect(f.own).toHaveBeenCalledTimes(1);
    expect(createTaskThroughUi).not.toHaveBeenCalled();
  });
  it("recovers the exact persisted frontmatter name after a successful creation response is lost", async () => {
    const campaignId = "journey-1793701020304-a1b2c3d4";
    const f = await setup((kind, row) => {
      if (kind === "create-skill") throw new Error("Response lost after successful creation");
      return row;
    }, campaignId);
    await expect(f.run()).rejects.toThrow("Response lost after successful creation");
    expect(f.savedSkills).toHaveLength(1);
    expect(f.api.post).toHaveBeenCalledTimes(1);
    expect(f.own).toHaveBeenCalledTimes(1);
    expect(createTaskThroughUi).not.toHaveBeenCalled();
    const intent = f.own.mock.calls[0]![0];
    const recovered = f.savedSkills.filter(row => row.companyId === f.context.company.id && row.name === intent.name);
    expect(recovered).toEqual([f.savedSkills[0]]);
    expect(intent.name).toContain(campaignId);
    expect(f.savedSkills[0]!.name).toContain(campaignId);
    expect(f.api.post.mock.calls[0]![1].name).toBe(f.savedSkills[0]!.name);
  });
});
