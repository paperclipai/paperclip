import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { authorizeShippedChat, shippedChatEvidenceAuthority } from "./testops-chat-admission.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const wrapperDirectories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(readFileSync).mockImplementation(actual.readFileSync);
  for (const directory of wrapperDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const id = "chat-features.runner-opencode-deepseek-1017.local.create-backlog";
function fixture() {
  const env: NodeJS.ProcessEnv = { PAPERCLIP_TESTOPS_CHAT_MAIN_ADMISSION: "v1", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "paperclipai/paperclip", GITHUB_REF: "refs/heads/master", GITHUB_WORKFLOW_REF: "paperclipai/paperclip/.github/workflows/chat-feature-testops.yml@refs/heads/master",
    GITHUB_JOB: "chat", GITHUB_SHA: "a".repeat(40), TARGET_SHA: "a".repeat(40), TESTOPS_ADMITTED_SHA: "a".repeat(40), GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_ACTOR_ID: "123", TESTOPS_TRIGGERING_ACTOR_ID: "123", TESTOPS_ALLOWED_ACTOR_IDS: "[123]", MANUAL_PRIVATE_IDS: JSON.stringify([id]), SELECTED_EXECUTION_ID: id };
  const event = { ref: "refs/heads/master", sender: { id: 123 }, repository: { full_name: "paperclipai/paperclip", private: false, default_branch: "master" }, inputs: { ALLURE_JOB_RUN_ID: "789", operation: "evaluate" } as Record<string, string> };
  const selected = runnerMatrix.find(row => row.id === id)!;
  return { env, event, selected };
}
it("binds the actual shipped selection to immutable main admission without candidate approval variables", () => {
  const f = fixture(); const result = authorizeShippedChat(f.env, f.event, f.selected, "b".repeat(64));
  expect(result).toMatchObject({ authority: "paperclip.shipped-chat-testops/v1", private: true, runId: "12345", attempt: "1", workflowSha: f.env.GITHUB_SHA, targetSha: f.env.GITHUB_SHA, executionIds: [id] });
  expect(result.authoritySha256).toMatch(/^[a-f0-9]{64}$/);
  expect(authorizeShippedChat({ ...f.env, LATEST_MASTER_SHA: "c".repeat(40), GITHUB_JOB: "report" }, f.event, f.selected, "b".repeat(64)).authoritySha256).toBe(result.authoritySha256);
});
it.each([
  ["unknown mode", { PAPERCLIP_TESTOPS_CHAT_MAIN_ADMISSION: "unknown" }],
  ["untrusted repo", { GITHUB_REPOSITORY: "foreign/repo" }],
  ["nondefault ref", { GITHUB_REF: "refs/heads/feature" }],
  ["wrong workflow caller", { GITHUB_WORKFLOW_REF: "paperclipai/paperclip/.github/workflows/runner-full-stack-e2e.yml@refs/heads/master" }],
  ["source substitution", { TARGET_SHA: "c".repeat(40) }],
  ["admitted source mismatch", { TESTOPS_ADMITTED_SHA: "c".repeat(40) }],
  ["replay", { GITHUB_RUN_ATTEMPT: "2" }],
  ["unlisted actor", { TESTOPS_ALLOWED_ACTOR_IDS: "[456]" }],
  ["untrusted job", { GITHUB_JOB: "build" }],
  ["foreign selector", { SELECTED_EXECUTION_ID: "other" }],
])("rejects %s", (_name, patch) => { const f = fixture(); expect(() => authorizeShippedChat({ ...f.env, ...patch }, f.event, f.selected, "b".repeat(64))).toThrow(); });
it.each(["target_branch", "profile", "model", "retries", "timeout"])("rejects the undeclared %s input", field => {
  const f = fixture(); f.event.inputs[field] = "override"; expect(() => authorizeShippedChat(f.env, f.event, f.selected, "b".repeat(64))).toThrow();
});
it("rejects metadata bootstrap as an evaluation admission", () => { const f = fixture(); f.event.inputs.operation = "bootstrap"; expect(() => authorizeShippedChat(f.env, f.event, f.selected, "b".repeat(64))).toThrow(); });
it("rejects forged event sender and foreign event source", () => {
  const f = fixture(); f.event.sender.id = 456; expect(() => authorizeShippedChat(f.env, f.event, f.selected, "b".repeat(64))).toThrow();
  f.event.sender.id = 123; f.event.repository.full_name = "foreign/repo"; expect(() => authorizeShippedChat(f.env, f.event, f.selected, "b".repeat(64))).toThrow();
});
it("rejects the existing production OpenCode backlog cell", () => {
  const f = fixture();
  const stock = runnerMatrix.find(row => row.id === "chat-features.runner-opencode.local.create-backlog")!;
  expect(() => authorizeShippedChat(f.env, f.event, stock, "b".repeat(64))).toThrow("Unexpected shipped chat selection or bounds");
});
it.each(["model", "provider", "work", "clock", "retry", "budget"])("rejects changed selected %s", field => {
  const f = fixture(); const selected = { ...f.selected, profile: { ...f.selected.profile }, task: { ...f.selected.task }, suite: { ...f.selected.suite, definitionMetadata: { ...f.selected.suite.definitionMetadata } } };
  if (field === "model") selected.profile.model = "other/model";
  if (field === "provider") selected.profile.provider = "codex";
  if (field === "work") selected.task.expectedRunCount = 2;
  if (field === "clock") selected.task.turnTimeoutMs = 121000;
  if (field === "retry") selected.task.automaticRetryPolicy = undefined;
  if (field === "budget") selected.suite.definitionMetadata.companyAndAgentBudgetCents = 1000;
  expect(() => authorizeShippedChat(f.env, f.event, selected, "b".repeat(64))).toThrow();
});

async function wrapperFixture() {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const directory = mkdtempSync(path.join(tmpdir(), "testops-chat-authority-"));
  wrapperDirectories.push(directory);
  const f = fixture(), eventPath = path.join(directory, "event.json"), launchPath = path.join(directory, "launch.ts");
  const canonicalLaunch = new URL("./launch.ts", import.meta.url);
  writeFileSync(eventPath, JSON.stringify(f.event));
  writeFileSync(launchPath, actual.readFileSync(canonicalLaunch));
  vi.mocked(readFileSync).mockImplementation(actual.readFileSync).mockClear();
  const env: NodeJS.ProcessEnv = { ...f.env, GITHUB_EVENT_PATH: eventPath };
  return { ...f, env, directory, eventPath, launchPath, canonicalLaunch, actual };
}

it("admits the real filesystem wrapper with the actual catalog and canonical launcher without fixture callbacks", async () => {
  const f = await wrapperFixture();
  const callbacks = [vi.spyOn(f.selected.profile, "buildAgent"), vi.spyOn(f.selected.task, "buildPrompt")];
  const result = shippedChatEvidenceAuthority(f.env);
  expect(result).toMatchObject({ authority: "paperclip.shipped-chat-testops/v1", workflowSha: f.env.GITHUB_SHA,
    targetSha: f.env.GITHUB_SHA, runId: f.env.GITHUB_RUN_ID, attempt: "1", executionIds: [id], private: true,
    launchSha256: createHash("sha256").update(f.actual.readFileSync(f.canonicalLaunch)).digest("hex") });
  expect(Object.isFrozen(result)).toBe(true);
  expect(callbacks.every(callback => callback.mock.calls.length === 0)).toBe(true);
  expect(vi.mocked(readFileSync).mock.calls.map(([file]) => String(file))).toEqual([f.eventPath, String(f.canonicalLaunch)]);
});

it.each(["missing", "absent", "directory", "symlink", "oversize", "invalid-json"])("rejects %s event custody through the real wrapper", async kind => {
  const f = await wrapperFixture();
  if (kind === "missing") delete f.env.GITHUB_EVENT_PATH;
  if (kind === "absent") rmSync(f.eventPath);
  if (kind === "directory") { rmSync(f.eventPath); mkdirSync(f.eventPath); }
  if (kind === "symlink") {
    const target = path.join(f.directory, "real-event.json"); writeFileSync(target, JSON.stringify(f.event));
    rmSync(f.eventPath); symlinkSync(target, f.eventPath);
  }
  if (kind === "oversize") writeFileSync(f.eventPath, " ".repeat(65_537));
  if (kind === "invalid-json") writeFileSync(f.eventPath, "{invalid");
  expect(() => shippedChatEvidenceAuthority(f.env)).toThrow();
  expect(vi.mocked(readFileSync).mock.calls.some(([file]) => String(file) === String(f.canonicalLaunch))).toBe(false);
});

it.each(["sender", "bootstrap", "model-input", "source"])("rejects a tampered %s through event parsing and wrapper admission", async kind => {
  const f = await wrapperFixture();
  if (kind === "sender") f.event.sender.id = 456;
  if (kind === "bootstrap") f.event.inputs.operation = "bootstrap";
  if (kind === "model-input") f.event.inputs.model = "foreign/model";
  if (kind === "source") f.env.TARGET_SHA = "c".repeat(40);
  writeFileSync(f.eventPath, JSON.stringify(f.event));
  expect(() => shippedChatEvidenceAuthority(f.env)).toThrow("Invalid shipped chat authority");
});

it.each(["missing", "model"])("rejects %s selected catalog metadata in the actual wrapper", async kind => {
  const f = await wrapperFixture();
  const find = vi.spyOn(runnerMatrix, "find");
  if (kind === "missing") find.mockReturnValue(undefined);
  else find.mockReturnValue({ ...f.selected, profile: { ...f.selected.profile, model: "foreign/model" } });
  expect(() => shippedChatEvidenceAuthority(f.env)).toThrow(kind === "missing" ? "Shipped chat execution is absent" : "Unexpected shipped chat selection or bounds");
});

it.each(["absent", "directory", "denied"])("propagates a %s launcher read from a test-only filesystem port", async kind => {
  const f = await wrapperFixture();
  if (kind === "absent") rmSync(f.launchPath);
  if (kind === "directory") { rmSync(f.launchPath); mkdirSync(f.launchPath); }
  vi.mocked(readFileSync).mockImplementation((file, options) => {
    if (String(file) !== String(f.canonicalLaunch)) return f.actual.readFileSync(file, options);
    if (kind === "denied") throw Object.assign(new Error("Owned launcher unreadable"), { code: "EACCES" });
    return f.actual.readFileSync(f.launchPath, options);
  });
  expect(() => shippedChatEvidenceAuthority(f.env)).toThrow(expect.objectContaining({ code: kind === "absent" ? "ENOENT" : kind === "directory" ? "EISDIR" : "EACCES" }));
});

it("binds changed real launcher bytes to new authority rather than inventing an independent trusted hash", async () => {
  const f = await wrapperFixture();
  vi.mocked(readFileSync).mockImplementation((file, options) => f.actual.readFileSync(
    String(file) === String(f.canonicalLaunch) ? f.launchPath : file, options));
  const original = shippedChatEvidenceAuthority(f.env);
  writeFileSync(f.launchPath, "source-only changed launcher bytes\n");
  const changed = shippedChatEvidenceAuthority(f.env);
  expect(changed.launchSha256).toBe(createHash("sha256").update(f.actual.readFileSync(f.launchPath)).digest("hex"));
  expect(changed.launchSha256).not.toBe(original.launchSha256);
  expect(changed.authoritySha256).not.toBe(original.authoritySha256);
});
