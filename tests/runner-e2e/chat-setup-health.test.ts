import { appendFile, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerApi } from "./api.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { CHAT_OPENCODE_MODEL } from "./chat-runtime-profile.js";
import { CHAT_SETUP_HEALTH_ID, CHAT_SETUP_HEALTH_SUITE, gradeSetupHealth, runChatSetupHealth, requestSetupHealthStop, stopSetupHealthIfRequested, SetupHealthAbort, captureSetupHealthProfile } from "./chat-setup-health.js";
const valid = (): Parameters<typeof gradeSetupHealth>[0] => ({ ready: true, agentCount: 1, configMatches: true, issues: 0, conversations: 0, comments: 0, humanComments: 0, runs: 0,
  probes: [{ schema: "paperclip.chat-readiness-probe/v1", companyId: "company", sequence: 1, status: "pass", thrown: false,
    checks: [{ code: "opencode_hello_probe_passed", level: "info", category: "unknown" as const }], errorCategory: "unknown" as const }] });
describe("explicit setup-only diagnostic cell", () => {
  it("selects one exact-profile retry-zero cell outside the catalog and --all", () => {
    const cell = runnerMatrix.find(row => row.id === CHAT_SETUP_HEALTH_ID)!;
    expect(cell).toBeDefined();
    expect(cell.profile).toBe(runnerSuites.find(row => row.id === "chat-features")!.profiles[0]);
    expect(cell).toMatchObject({ suite: { id: CHAT_SETUP_HEALTH_SUITE, manualOnly: true }, profile: {
      id: "runner-opencode", model: CHAT_OPENCODE_MODEL, provider: "opencode", credential: "OPENROUTER_API_KEY" },
      task: { flow: "setup_health", expectedRunCount: 0, automaticRetryPolicy: "single_attempt" } });
    expect(cell.task.buildPrompt("nonce")).toBe("");
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"]), runnerMatrix).some(row => row.id === cell.id)).toBe(false);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--id", CHAT_SETUP_HEALTH_ID]), runnerMatrix)).toEqual([cell]);
    expect(runnerMatrix.filter(row => row.suite.id === "chat-features" && row.profile.id === "runner-opencode").length).toBe(244);
  });
  it("accepts one real successful setup without any chat/task/native work", () => expect(gradeSetupHealth(valid()).every(check => check.passed)).toBe(true));
  it.each(["ready", "configMatches", "agentCount", "issues", "conversations", "comments", "humanComments", "runs"])("rejects wrong %s", field => {
    const state = valid(); Object.assign(state, { [field]: ["ready", "configMatches"].includes(field) ? false : 2 });
    expect(gradeSetupHealth(state).some(check => !check.passed)).toBe(true);
  });
  it("rejects missing/repeated/failed/unknown or non-hello probes", () => {
    for (const probes of [[], [...valid().probes, ...valid().probes], [{ ...valid().probes[0]!, status: "fail" }],
      [{ ...valid().probes[0]!, status: "unknown" }], [{ ...valid().probes[0]!, checks: [] }]]) {
      expect(gradeSetupHealth({ ...valid(), probes }).some(check => !check.passed)).toBe(true);
    }
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it.each([[false, false], [true, false], [false, true]])("uses only readiness GET plus cleanup; failure=%s lateProbe=%s", async (failed, lateProbe) => {
  const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "setup-health-offline-"))); roots.push(temporaryRoot);
  await mkdir(path.join(temporaryRoot, "artifacts-private"));
  const companyId = "11111111-1111-4111-8111-111111111111";
  const probe = { ...valid().probes[0]!, companyId, status: failed ? "fail" : "pass" };
  await writeFile(path.join(temporaryRoot, "artifacts-private", "chat-readiness-probes.jsonl"), JSON.stringify(probe));
  const agent = { id: "agent", companyId, defaultEnvironmentId: "environment", adapterType: "paperclip_runner",
    adapterConfig: { provider: "opencode", model: CHAT_OPENCODE_MODEL }, status: "idle", lifecycleState: failed ? "verifying" : "ready",
    lifecycleError: failed ? "Execution configuration check failed" : null };
  const get = vi.fn(async (route: string) => {
    if (route === "/api/agents/agent") return agent;
    if (route.endsWith("/agents")) return [agent];
    if (route === "/api/instance/settings/experimental") return { enableAgentChat: true };
    return [];
  });
  const post = vi.fn(async (route: string) => {
    expect(route).toBe("/api/agents/agent/pause");
    if (lateProbe) await appendFile(path.join(temporaryRoot, "artifacts-private", "chat-readiness-probes.jsonl"), `\n${JSON.stringify({ ...probe, sequence: 2 })}`);
    return {};
  });
  const evidence = vi.fn(async (_name: string, _value: unknown) => {});
  const operation = runChatSetupHealth({ api: { get, post } as unknown as RunnerApi,
    fixtures: { company: { id: companyId }, agent: { id: "agent" }, environment: { id: "environment" } } as LiveFixtureValues,
    temporaryRoot, evidence });
  if (failed || lateProbe) await expect(operation).rejects.toThrow("Setup health failed"); else await operation;
  expect(post).toHaveBeenCalledTimes(1);
  expect(get.mock.calls.every(([route]) => !route.includes("test-environment") && !route.includes("/chats/"))).toBe(true);
  expect(evidence).toHaveBeenCalledTimes(3);
  expect((evidence.mock.calls[1]![1] as { state: { probes: unknown[] } }).state.probes).toHaveLength(lateProbe ? 2 : 1);
  expect(evidence.mock.calls[1]![1]).toMatchObject({ canonicalQueries: 0, state: { issues: 0, conversations: 0, runs: 0 } });
  expect(evidence.mock.calls[2]).toEqual(["api-state.json", expect.objectContaining({ scope: "diagnostic-outside-244", capturePhase: "after-public-pause",
    observed: expect.objectContaining({ issues: 0, conversations: 0, runs: 0, configMatches: true }) })]);
});

it("only an exact owned health stop request invokes the existing cleanup callback", async () => {
  const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "setup-health-stop-"))); roots.push(temporaryRoot);
  await mkdir(path.join(temporaryRoot, "artifacts-private"));
  const stop = vi.fn(async () => {});
  await requestSetupHealthStop(temporaryRoot);
  expect(await stopSetupHealthIfRequested({ executionIds: ["chat-features.runner-opencode.local.create-backlog"], temporaryRoot, stop })).toBe(false);
  expect(stop).not.toHaveBeenCalled();
  await writeFile(path.join(temporaryRoot, "artifacts-private", "chat-setup-health-stop.json"), JSON.stringify({ executionId: CHAT_SETUP_HEALTH_ID, temporaryRoot: "wrong-root" }));
  expect(await stopSetupHealthIfRequested({ executionIds: [CHAT_SETUP_HEALTH_ID], temporaryRoot, stop })).toBe(false);
  expect(stop).not.toHaveBeenCalled();
  await rm(path.join(temporaryRoot, "artifacts-private", "chat-setup-health-stop.json"));
  await requestSetupHealthStop(temporaryRoot);
  expect(await stopSetupHealthIfRequested({ executionIds: [CHAT_SETUP_HEALTH_ID], temporaryRoot, stop })).toBe(true);
  expect(stop).toHaveBeenCalledTimes(1);
});
it("pause failure requests owned stop before extra oracle reads, even if initial evidence fails", async () => {
  const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "setup-health-stop-"))); roots.push(temporaryRoot);
  await mkdir(path.join(temporaryRoot, "artifacts-private"));
  const get = vi.fn(async () => ({ lifecycleState: "ready", status: "idle" }));
  const post = vi.fn(async () => { throw new Error("private-api-error"); });
  const evidence = vi.fn(async () => { throw new Error("private-storage-error"); });
  await expect(runChatSetupHealth({ api: { get, post } as unknown as RunnerApi,
    fixtures: { company: { id: "11111111-1111-4111-8111-111111111111" }, agent: { id: "agent" } } as LiveFixtureValues,
    temporaryRoot, evidence })).rejects.toBeInstanceOf(SetupHealthAbort);
  expect(get).toHaveBeenCalledTimes(1); expect(post).toHaveBeenCalledTimes(1);
  const stop = vi.fn(async () => {});
  expect(await stopSetupHealthIfRequested({ executionIds: [CHAT_SETUP_HEALTH_ID], temporaryRoot, stop })).toBe(true);
  expect(stop).toHaveBeenCalledTimes(1);
});

it("captures the actual scoped readonly profile only after its visible identity loads", async () => {
  let current = "", visible = false;
  const waitFor = vi.fn(async () => { visible = true; });
  const heading = vi.fn(() => ({ waitFor }));
  const page = { goto: vi.fn(async (url: string) => { current = url; }), url: () => current,
    getByRole: vi.fn(() => ({ getByRole: heading })) };
  const get = vi.fn(async (route: string) => route.includes("/companies/") ? { id: "company", issuePrefix: "RUN" } : { id: "agent", companyId: "company", name: "CEO", urlKey: "ceo" });
  const capturePrivate = vi.fn(async () => { expect(visible).toBe(true); });
  const input = { executionId: CHAT_SETUP_HEALTH_ID, api: { baseURL: "http://127.0.0.1:3100", get } as unknown as RunnerApi,
    page: page as unknown as import("@playwright/test").Page, companyId: "company", agentId: "agent", capturePrivate };
  await captureSetupHealthProfile(input);
  expect(page.goto).toHaveBeenCalledWith("http://127.0.0.1:3100/RUN/agents/ceo/overview", { waitUntil: "domcontentloaded" });
  expect(heading).toHaveBeenCalledWith("heading", { name: "CEO", exact: true });
  expect(capturePrivate).toHaveBeenCalledExactlyOnceWith("setup-health-final-state", "final-state.png");
  capturePrivate.mockClear();
  await expect(captureSetupHealthProfile({ ...input, executionId: "chat-features.runner-opencode.local.create-backlog" })).rejects.toThrow("exact diagnostic cell");
  get.mockResolvedValue({ id: "foreign", issuePrefix: "OTHER" });
  await expect(captureSetupHealthProfile(input)).rejects.toThrow("resource mismatch");
  expect(capturePrivate).not.toHaveBeenCalled();
});
