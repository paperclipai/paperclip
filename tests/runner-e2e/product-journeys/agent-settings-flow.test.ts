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

async function fixture(nativeFailure = false) {
  let f = settingsEvidenceFixture(), content = f.original, rendered = content, draft = content, dirty = false, dispatched = false;
  const saves: string[] = [], owns: any[] = [], apiWrites: string[] = [];
  const current = () => content === f.original
    ? dispatched ? f.evidence.restored! : f.evidence.original!
    : dispatched ? f.evidence.afterWork! : f.evidence.saved!;
  const editor = { visible: true, value: () => draft, async fill(value: string) { draft = value; dirty = true; } };
  const raw = { visible: true, async textContent() { return rendered; } };
  const edit = { visible: true, async click() { draft = content; } };
  const save = { enabled: () => dirty, async click() {
    content = draft; saves.push(content); dirty = false;
    const nonce = /reference equal to ([a-f0-9]+),/.exec(content)?.[1];
    if (nonce) f = settingsEvidenceFixture(nonce);
  } };
  const document = { visible: true, async textContent() { return f.evidence.task!.document.body; } };
  const page = { async goto() { rendered = content; }, async reload() { rendered = content; },
    getByTestId(id: string) { expect(id).toBe("instructions-raw-source"); return raw; },
    getByRole(role: string, options: { name: string }) {
      if (role === "button" && options.name === "Edit AGENTS.md") return edit;
      if (role === "button" && options.name === "Save changes") return save;
      if (role === "textbox" && options.name === "Instruction file editor") return editor;
      throw new Error("unexpected_locator");
    }, locator(selector: string) { expect(selector).toBe("#document-settings-proof"); return document; } };
  const api = { origin: "https://qa.example.test", async get(route: string) {
    if (route === "/api/agents/agent") return structuredClone(current().agent);
    if (route === "/api/agents/agent/instructions-bundle") return structuredClone(current().bundle);
    if (route === "/api/agents/agent/instructions-bundle/file?path=AGENTS.md") return structuredClone(current().file);
    if (route.includes("/heartbeat-runs?agentId=agent")) return structuredClone(current().runs);
    if (route.includes("/activity?entityType=agent")) return structuredClone(current().activity);
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
  return { context, session, evidence, directory, saves, owns, apiWrites, original: f.original,
    currentContent: () => content, options: { directory, deadlineAt: Date.now() + 30000 } };
}

describe("agent settings production-surface orchestration", () => {
  it("saves and restores only through browser controls, then leaves the result ready for screenshot", async () => {
    const f = await fixture();
    await runAgentSettings(f.context, f.session, "campaign-1", f.evidence, f.options);
    expect(f.evidence.checks).toHaveLength(7); expect(f.evidence.checks.every(row => row.passed)).toBe(true);
    expect(f.saves).toHaveLength(2); expect(f.saves[1]).toBe(f.original); expect(f.apiWrites).toEqual([]);
    expect(f.owns.map(row => row.id ?? "intent")).toEqual(["intent", "task"]);
    const artifact = await readFile(path.join(f.directory, "agent-settings-observations.json"), "utf8");
    expect(artifact).not.toContain(f.original); expect(artifact).not.toContain("adapterConfig");
    const saved = JSON.parse(artifact); expect(saved.checks.every((row: any) => row.passed)).toBe(true);
    expect(saved.checkpoints.original.contentHash).toBe(saved.checkpoints.restored.contentHash);
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
