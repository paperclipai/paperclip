import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./types.js";
import { settingsEvidenceFixture } from "./agent-settings-test-fixture.js";
import { settingsTaskPrompt } from "./agent-settings-evidence.js";

const controls = vi.hoisted(() => ({ createTask: vi.fn(), openDocument: vi.fn() }));
vi.mock("../user-actions.js", () => ({ createTaskThroughUi: controls.createTask }));
vi.mock("./task-document-flow.js", () => ({ openDocumentAuthoring: controls.openDocument }));
vi.mock("@playwright/test", () => ({ expect: (locator: any) => ({
  async toBeVisible() { expect(locator.visible).toBe(true); },
  async toBeEnabled() { expect(locator.enabled()).toBe(true); },
  async toBeDisabled() { expect(locator.enabled()).toBe(false); },
  async toHaveValue(value: string) { expect(locator.value()).toBe(value); },
  async toContainText(value: string) { expect(await locator.textContent()).toContain(value); },
}) }));
import { runAgentSettings } from "./agent-settings-flow.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture(nativeFailure = false, unscopedActivity = false, delayedRestore = false, original?: string, entryFile = "AGENTS.md") {
  let f = settingsEvidenceFixture(undefined, original, entryFile), content = f.original, rendered = content, draft = content, dirty = false, dispatched = false;
  const originalContent = f.original;
  const availablePaths = new Set(f.evidence.original!.bundle.files.map((file: any) => file.path));
  const neighbor = "# AGENTS.md sibling must remain unchanged\n";
  let selectedFile = "AGENTS.md";
  const expandedDirs = new Set<string>(), selectedPaths: string[] = [], savedPaths: string[] = [];
  let pendingContent: string | undefined;
  const saves: string[] = [], owns: any[] = [], apiWrites: string[] = [], activityReads: string[] = [];
  const unrelatedActivity = Array.from({ length: 600 }, (_, index) => ({ id: `unrelated-${index}`,
    companyId: f.scope.companyId, entityType: "agent", entityId: "another-agent", details: {} }));
  const current = () => content === f.original
    ? dispatched ? f.evidence.restored! : f.evidence.original!
    : dispatched ? f.evidence.afterWork! : f.evidence.saved!;
  const editor = { visible: true, value: () => draft, async inputValue() { return draft; }, async fill(value: string) { draft = value; dirty = true; } };
  const raw = { get visible() { return Boolean(rendered.trim()); }, async textContent() { return rendered; } };
  const edit = { get visible() { return selectedFile === entryFile; }, async click() { draft = content; } };
  const save = { enabled: () => dirty, async click() {
    expect(selectedFile).toBe(entryFile); savedPaths.push(selectedFile);
    saves.push(draft); dirty = false;
    if (delayedRestore && saves.length === 2) pendingContent = draft;
    else content = draft;
    const nonce = /reference equal to ([a-f0-9]+),/.exec(draft)?.[1];
    if (nonce) f = settingsEvidenceFixture(nonce, originalContent, entryFile);
  } };
  const document = { visible: true, async textContent() { return f.evidence.task!.document.body; } };
  const page = { async goto() {
    if (pendingContent !== undefined) throw new Error("navigation_before_save_committed");
    selectedFile = "AGENTS.md"; expandedDirs.clear(); rendered = entryFile === "AGENTS.md" ? content : neighbor;
  }, async reload() { selectedFile = "AGENTS.md"; expandedDirs.clear(); rendered = entryFile === "AGENTS.md" ? content : neighbor; },
    getByTestId(id: string) { expect(id).toBe("instructions-raw-source"); return raw; },
    getByRole(role: string, options: { name: string }) {
      if (role === "button" && options.name === `Edit ${entryFile}`) return edit;
      if (role === "button" && options.name === `Stop editing ${entryFile}`) return { async click() {} };
      if (role === "button" && options.name === "Save changes") return save;
      if (role === "textbox" && options.name === "Instruction file editor") return editor;
      throw new Error("unexpected_locator");
    }, locator(selector: string) {
      if (selector === "#document-settings-proof") return document;
      const match = /^\[role="treeitem"\]\[data-file-tree-path=("(?:\\.|[^"\\])*")\]$/.exec(selector);
      if (!match) throw new Error("unexpected_selector:" + selector);
      const filePath: string = JSON.parse(match[1]!);
      const directory = entryFile.startsWith(`${filePath}/`);
      const parents = filePath.split("/").slice(0, -1);
      return { get visible() { return (directory || availablePaths.has(filePath))
        && parents.every((_, index) => expandedDirs.has(parents.slice(0, index + 1).join("/"))); },
      async getAttribute(name: string) { expect(name).toBe("aria-expanded"); return directory ? String(expandedDirs.has(filePath)) : null; },
      async click() {
        if (directory) expandedDirs.add(filePath);
        else { selectedFile = filePath; selectedPaths.push(filePath); rendered = filePath === entryFile ? content : neighbor; }
      } };
    } };
  const api = { origin: "https://qa.example.test", async get(route: string) {
    if (route === "/api/agents/agent") return structuredClone(current().agent);
    if (route === "/api/agents/agent/instructions-bundle") return structuredClone(current().bundle);
    if (route === `/api/agents/agent/instructions-bundle/file?path=${encodeURIComponent(entryFile)}`) {
      if (pendingContent !== undefined) { content = pendingContent; pendingContent = undefined; }
      return structuredClone(current().file);
    }
    if (route.includes("/heartbeat-runs?agentId=agent")) return structuredClone(current().runs);
    if (route.startsWith("/api/companies/company/activity?")) {
      activityReads.push(route);
      const query = new URL(route, api.origin).searchParams;
      expect(query.get("entityType")).toBe("agent"); expect(query.get("entityId")).toBe("agent");
      expect(query.get("limit")).toBe("200");
      if (unscopedActivity) return [unrelatedActivity[0]];
      return structuredClone([...unrelatedActivity, ...current().activity]
        .filter(row => row.entityType === query.get("entityType") && row.entityId === query.get("entityId"))
        .slice(0, Number(query.get("limit"))).map(row => ({ ...row,
          details: { ...row.details, privateFixturePayload: "must-not-be-retained" } })));
    }
    if (route === "/api/issues/task") return structuredClone(f.evidence.task!.issue);
    if (route === "/api/issues/task/runs") return [{ runId: "run" }];
    if (route === "/api/issues/task/interactions") return [];
    if (route === "/api/heartbeat-runs/run") return { ...structuredClone(f.run), ...(nativeFailure ? { status: "failed" } : {}) };
    if (route === "/api/issues/task/documents/settings-proof") return structuredClone(f.evidence.task!.document);
    if (route === "/api/issues/task/documents/settings-proof/revisions/document-revision") return structuredClone(f.evidence.task!.revision);
    throw new Error("unexpected_read:" + route);
  }, async put() { apiWrites.push("put"); throw new Error("tested save must use browser"); },
  async patch() { apiWrites.push("patch"); throw new Error("tested save must use browser"); } };
  const context = { page, api, company: { id: "company", issuePrefix: "QA" }, user: { id: "user", name: "QA" },
    agent: { id: "agent", name: "Owned agent campaign-1", provider: "opencode", model: "model", runtimeMode: "native" },
    environmentId: "environment", capabilities: ["company", "board-user", "task-write", "agent", "agent-settings-write"] } as unknown as JourneyContext;
  controls.createTask.mockReset(); controls.openDocument.mockReset();
  controls.createTask.mockImplementation(async (input: any) => {
    expect(saves).toHaveLength(1); expect(input.prompt).toBe(settingsTaskPrompt);
    expect(input.prompt).not.toContain(f.scope.reference);
    await input.beforeDispatch(); dispatched = true; return { issueId: "task" };
  });
  const session = { async own(resource: any) { owns.push(resource); } } as TargetSession;
  const evidence: JourneyEvidence = { outcome: "passed", startingState: "recipe", phases: [], checks: [], resourceDisposition: "retained", privacy: "private" };
  const directory = await mkdtemp(path.join(os.tmpdir(), "qa-settings-flow-")); directories.push(directory);
  return { context, session, evidence, directory, saves, savedPaths, selectedPaths, availablePaths, owns, apiWrites, activityReads, unrelatedActivity, original: f.original,
    currentContent: () => content, options: { directory, deadlineAt: Date.now() + 30000 } };
}

describe("agent settings production-surface orchestration", () => {
  it.each(["WORKFLOW.md", "team guide/qa [settings].md", "team/nested/INSTRUCTIONS.md"])(
    "selects configured entry %s when AGENTS.md also exists and is initially selected", async entryFile => {
      const f = await fixture(false, false, false, undefined, entryFile);
      expect(f.availablePaths).toEqual(new Set(["AGENTS.md", entryFile]));
      await runAgentSettings(f.context, f.session, "campaign-1", f.evidence, f.options);
      expect(f.evidence.checks.every(row => row.passed)).toBe(true);
      expect(f.savedPaths).toEqual([entryFile, entryFile]);
      expect(f.selectedPaths.length).toBeGreaterThan(2); expect(new Set(f.selectedPaths)).toEqual(new Set([entryFile]));
      expect(f.currentContent()).toBe(f.original); expect(f.apiWrites).toEqual([]);
      const receipt = JSON.parse(await readFile(path.join(f.directory, "agent-settings-observations.json"), "utf8"));
      expect(receipt.saveAudits.saved.path).toBe(entryFile); expect(receipt.saveAudits.restored.path).toBe(entryFile);
    });
  it.each(["", " \n\t\n"])("reads and restores the exact empty-file editor value %j", async original => {
    const f = await fixture(false, false, false, original);
    await runAgentSettings(f.context, f.session, "campaign-1", f.evidence, f.options);
    expect(f.saves).toHaveLength(2); expect(f.saves[1]).toBe(original); expect(f.currentContent()).toBe(original);
    expect(f.evidence.checks.every(row => row.passed)).toBe(true);
  });
  it("saves and restores only through browser controls, then leaves the result ready for screenshot", async () => {
    const f = await fixture();
    await runAgentSettings(f.context, f.session, "campaign-1", f.evidence, f.options);
    expect(f.evidence.checks).toHaveLength(7); expect(f.evidence.checks.every(row => row.passed)).toBe(true);
    expect(f.saves).toHaveLength(2); expect(f.saves[1]).toBe(f.original); expect(f.apiWrites).toEqual([]);
    expect(f.owns.map(row => row.id ?? "intent")).toEqual(["intent", "task"]);
    const artifact = await readFile(path.join(f.directory, "agent-settings-observations.json"), "utf8");
    expect(artifact).not.toContain(f.original); expect(artifact).not.toContain("adapterConfig");
    expect(artifact).not.toContain("must-not-be-retained");
    const saved = JSON.parse(artifact); expect(saved.checks.every((row: any) => row.passed)).toBe(true);
    expect(saved.checkpoints.original.contentHash).toBe(saved.checkpoints.restored.contentHash);
    expect(saved.saveAudits).toEqual({ saved: { id: "save", companyId: "company", actorType: "user", actorId: "user",
      agentId: null, runId: null, action: "agent.files_updated", entityType: "agent", entityId: "agent", path: "AGENTS.md",
      contentHash: saved.checkpoints.saved.contentHash, source: "board" }, restored: { id: "restore", companyId: "company",
      actorType: "user", actorId: "user", agentId: null, runId: null, action: "agent.files_updated", entityType: "agent",
      entityId: "agent", path: "AGENTS.md", contentHash: saved.checkpoints.restored.contentHash, source: "board" } });
    expect(f.unrelatedActivity).toHaveLength(600); expect(f.activityReads.length).toBeGreaterThan(0);
  });
  it("rejects a wrongly unscoped activity response before any settings edit", async () => {
    const f = await fixture(false, true);
    await expect(runAgentSettings(f.context, f.session, "campaign-1", f.evidence, f.options)).rejects.toThrow("agent_settings_read_coverage_unavailable");
    expect(f.saves).toEqual([]); expect(f.owns).toEqual([]);
  });
  it("confirms a delayed restore audit and bytes before navigating away from the editor", async () => {
    const f = await fixture(false, false, true);
    await runAgentSettings(f.context, f.session, "campaign-1", f.evidence, f.options);
    expect(f.saves).toHaveLength(2); expect(f.currentContent()).toBe(f.original);
    expect(f.evidence.checks.every(row => row.passed)).toBe(true);
  });
  it("requires scoped settings-write capability before any configuration edit", async () => {
    const f = await fixture(); f.context.capabilities = ["company", "board-user", "task-write", "agent"];
    await expect(runAgentSettings(f.context, f.session, "campaign-1", f.evidence, f.options)).rejects.toThrow("owned_agent_settings_capability_required");
    expect(f.saves).toEqual([]); expect(f.owns).toEqual([]);
  });
  it("preserves a native failure and does not restore instructions while failed work may require cleanup", async () => {
    const f = await fixture(true);
    await expect(runAgentSettings(f.context, f.session, "campaign-1", f.evidence, f.options)).rejects.toThrow("agent_settings_native_run_failed");
    expect(f.saves).toHaveLength(1); expect(f.currentContent()).not.toBe(f.original);
    expect(JSON.parse(await readFile(path.join(f.directory, "agent-settings-observations.json"), "utf8")).checks.every((row: any) => row.passed)).toBe(false);
    expect(f.apiWrites).toEqual([]);
  });
});
