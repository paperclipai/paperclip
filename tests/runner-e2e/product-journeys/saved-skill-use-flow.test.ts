import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalProviderEventsFromOpenCodePart } from "../../../packages/paperclip-runner/src/provider-events.js";
import { parseFrontmatterMarkdown } from "../../../packages/shared/src/frontmatter.js";
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

async function setup(change: (kind: string, row: any) => any = (_kind, row) => row, campaignId = "campaign") {
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
        skill = { id: "skill", companyId: "company", key: "local:skill", slug: fixture.slug,
          name: typeof savedName === "string" && savedName.trim() ? savedName.trim() : body.name,
          markdown: body.markdown, currentVersionId: "version" };
        savedSkills.push(structuredClone(skill));
        return change("create-skill", { id: skill.id });
      }
      if (route === "/api/agents/agent/skills/sync?companyId=company") {
        expect(body).toEqual({ desiredSkills: [{ key: skill.key, versionId: "version" }], mode: "add" });
        assigned = true; return {};
      }
      throw new Error(`Unexpected mutation ${route}`);
    }),
    get: vi.fn(async (route: string) => {
      if (route === "/api/companies/company/skills/skill") return change(reloaded ? "retained-skill" : "skill", structuredClone(skill));
      if (route === "/api/companies/company/skills/skill/versions/version") return {
        id: "version", companyId: "company", companySkillId: "skill", fileInventory: [{ path: "SKILL.md", content: fixture.markdown }],
      };
      if (route === "/api/agents/agent/skills?companyId=company") return change("assignment", {
        desiredSkillEntries: assigned ? [{ key: skill.key, versionId: "version" }] : [],
      });
      if (!issueCreated) throw new Error("Measured result was read before browser dispatch");
      if (route === "/api/issues/issue") return { id: "issue", identifier: "QA-1", companyId: "company", assigneeAgentId: "agent", status: "done",
        description: change("description", vi.mocked(createTaskThroughUi).mock.calls.at(-1)![0].prompt) };
      if (route === "/api/issues/issue/runs") return change("runs", [{ runId: "run" }]);
      if (route === "/api/issues/issue/comments?order=asc" || route === "/api/issues/issue/interactions") return [];
      if (route === "/api/heartbeat-runs/run") return { id: "run", companyId: "company", agentId: "agent", issueId: "issue",
        status: "succeeded", runtimeMode: "native", contextSnapshot: { paperclipEnvironment: { id: "environment" } },
        runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: "model" } } } };
      if (route.startsWith("/api/heartbeat-runs/run/events?")) {
        return ["pending", "completed"].map((status, i) => {
          const p = canonicalProviderEventsFromOpenCodePart({ id: "load", type: "tool", tool: "skill", state: {
            status, output: `<skill_content name="${fixture.slug}">\n${fixture.procedure}\n</skill_content>`,
          } })[0]!;
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
    run: () => runSavedSkillUse(context, { own } as unknown as TargetSession, campaignId, evidence, { deadlineAt: Date.now() + 5000, directory }) };
}

describe("saved skill journey orchestration", () => {
  it("pins the input before browser dispatch and verifies native use, saved result and reload without setup supplying output", async () => {
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
  });
  it.each([
    ["assignment", "saved_skill_version_pinned", (row: Row) => ({ ...row, desiredSkillEntries: [{ key: "local:skill", versionId: "stale" }] })],
    ["runs", "saved_skill_run_limit_exceeded", (row: Row[]) => [...row, { runId: "extra" }]],
    ["event", "saved_skill_native_read_attributed", (row: Row) => ({ ...row, companyId: "foreign" })],
    ["documents", "saved_skill_unexpected_documents", (row: Row[]) => [...row, { key: "unrelated" }]],
    ["revision", "saved_skill_result_authored_by_run", (row: Row) => ({ ...row, createdByRunId: "foreign" })],
    ["retained-skill", "saved_skill_source_preserved", (row: Row) => ({ ...row, currentVersionId: "changed" })],
  ] as const)("fails closed on changed %s evidence and retains its failure checkpoint", async (kind, code, change) => {
    const f = await setup((which, row) => which === kind ? change(row as never) : row);
    await expect(f.run()).rejects.toMatchObject({ outcome: "failed", code });
    expect(await readFile(path.join(f.directory, "saved-skill-use-checks.json"), "utf8")).toContain("fixture");
    if (kind === "assignment") expect(createTaskThroughUi).not.toHaveBeenCalled();
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
