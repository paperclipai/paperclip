import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcpRuntimeEvent } from "acpx/runtime";
import { openAntigravitySwarmRuntime, type AntigravitySwarmStage } from "./antigravity-swarm-runtime.js";
import type { AcpxRuntimePortOpenOptions } from "./runtime-host.js";
import type { AcpxTerminalSessionFailure } from "./provider-failure.js";

const FIXTURE = new URL("../../../test-fixtures/antigravity-cli/fake-agy-acp.mjs", import.meta.url).pathname;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(scenario: string, overrides: Partial<AcpxRuntimePortOpenOptions> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agy-swarm-")));
  roots.push(root);
  const log = join(root, "client.jsonl");
  const workerPidFile = join(root, "worker.pid");
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const options = {
    command: {
      spawn: (_args: readonly string[] = [], spawnOptions: Record<string, unknown> = {}) => spawn(process.execPath, [FIXTURE], {
        ...spawnOptions, detached: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, FAKE_AGY_SCENARIO: scenario, FAKE_AGY_LOG: log, FAKE_AGY_WORKER_PID_FILE: workerPidFile },
      }),
      close: async () => {},
    },
    profile: { agent: "antigravity", reportedModelId: "gemini-3.8-flash-low", qualificationModel: "gemini-3.8-flash-low" },
    cwd, stateDirectory: root, providerSessionKey: "key", permissionMode: "approve-reads", mode: "swarm",
    permissionPolicy: {}, launchEnvironment: {}, credentialFenceFds: null, activateCredentialFenceOwner: null,
    systemInstructions: "Paperclip instructions",
    mcpServers: [{ name: "paperclip", url: "http://127.0.0.1:9/mcp", bearerToken: "bridge-secret", runnerOwned: true }],
    retainFailedAdmissionCleanup: () => {},
    ...overrides,
  } as unknown as AcpxRuntimePortOpenOptions;
  const clientMessages = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { root, cwd, options, clientMessages, workerPidFile };
}

async function runTurn(scenario: string, extra: { helperWaitTimeoutMs?: number; onEvent?: (event: AcpRuntimeEvent, cancel: () => Promise<void>) => void } = {}) {
  const context = setup(scenario);
  const runtime = await openAntigravitySwarmRuntime(context.options, { helperWaitTimeoutMs: extra.helperWaitTimeoutMs ?? 5_000, cancelGraceMs: 500 });
  const failures: AcpxTerminalSessionFailure[] = [];
  const turn = runtime.startTurn({ text: "two helpers write a.txt and b.txt", requestId: "run-1:turn-1", onTerminalSessionFailure: failure => failures.push(failure) });
  const events: AcpRuntimeEvent[] = [];
  for await (const event of turn.events) { events.push(event); extra.onEvent?.(event, () => turn.cancel({ reason: "Stop" })); }
  const result = await turn.result;
  const status = await runtime.getStatus();
  await runtime.close({ reason: "done" });
  const titles = events.flatMap(event => event.type === "tool_call" && event.title ? [event.title] : []);
  const text = events.flatMap(event => event.type === "text_delta" ? [event.text] : []).join("");
  return { ...context, runtime, result, events, titles, text, failures, status };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("Antigravity CLI swarm runtime", () => {
  it("opens with a verified receipt: pinned identity, task folder, Paperclip tools only, auto mode, exact model", async () => {
    const { options, clientMessages, cwd } = setup("success");
    const runtime = await openAntigravitySwarmRuntime(options);
    expect((await runtime.getStatus()).models?.currentModelId).toBe("gemini-3.8-flash-low");
    expect(await runtime.identity()).toMatchObject({ mode: "swarm", backendSessionId: "e6536314-e108-4ecd-a0cf-efa59061510d" });
    expect((await runtime.getStatus()).antigravitySwarmReceipt).toMatchObject({ mode: "auto", modelFamily: "gemini-3.8-flash", thoughtLevel: "low", workspace: cwd, mcpServers: ["paperclip"] });
    await runtime.close({ reason: "done" });
    const sent = clientMessages();
    const sessionNew = sent.find(message => message.method === "session/new");
    expect(sessionNew.params).toMatchObject({ cwd, mcpServers: [{ type: "http", name: "paperclip", headers: [{ name: "Authorization", value: "Bearer bridge-secret" }] }] });
    expect(sessionNew.params._meta.antigravity.systemPrompt.append).toContain("Paperclip instructions");
    expect(sent.map(message => message.method)).toEqual(expect.arrayContaining(["session/set_mode", "session/set_model"]));
    expect(sent.some(message => message.method === "session/load")).toBe(false);
  });

  it.each([
    ["wrong-version", /pinned version/], ["wrong-mode", /auto mode/], ["wrong-model", /gemini-3.8-flash-low/], ["no-auto", /auto mode, which this sign-in does not offer/],
  ])("fails closed on %s", async (scenario, message) => {
    const { options } = setup(scenario);
    await expect(openAntigravitySwarmRuntime(options, { readbackTimeoutMs: 200 })).rejects.toThrow(message);
  });

  it("runs a native swarm whose files land in the task folder, in plain steps, with coordinator-reported usage", async () => {
    const run = await runTurn("success");
    expect(run.result).toMatchObject({ status: "completed" });
    expect(readFileSync(join(run.cwd, "a.txt"), "utf8")).toBe("A");
    expect(run.titles).toEqual(expect.arrayContaining([
      "Started helper writer-a: Write a.txt containing exactly 'A' in the current workspace directory",
      "Checked on the helpers", "Files changed in the task folder: a.txt, b.txt",
    ]));
    expect(run.titles.some(title => /approved automatically/.test(title))).toBe(true);
    expect(run.text).not.toContain("/swarm board");
    expect(run.clientMessages().find(message => message.method === "session/prompt").params.prompt[0].text).toMatch(/^\/swarm /);
    expect(run.status.terminalPromptUsage).toMatchObject({ requestId: "run-1:turn-1", event: { breakdown: { totalTokens: 133035 } } });
    expect(run.titles.some(title => /includes the helpers/.test(title))).toBe(true);
  });

  it("does not settle on the first end_turn while helpers still run", async () => {
    const run = await runTurn("live-helpers");
    expect(run.result).toMatchObject({ status: "completed" });
    expect(run.clientMessages().filter(message => message.method === "session/prompt")).toHaveLength(2);
    expect(readFileSync(join(run.cwd, "b.txt"), "utf8")).toBe("B");
    expect(run.status.terminalPromptUsage).toMatchObject({ event: { breakdown: { totalTokens: 134035 } } });
  });

  it("fails with a clear timeout when helpers never finish", async () => {
    const run = await runTurn("hang-helpers", { helperWaitTimeoutMs: 200 });
    expect(run.result).toMatchObject({ status: "failed", error: { code: "ANTIGRAVITY_SWARM_HELPERS_TIMEOUT" } });
  });

  it("surfaces blocked helper actions and refuses the coordinator's outside write", async () => {
    const run = await runTurn("blocked");
    expect(run.result).toMatchObject({ status: "completed" });
    expect(run.clientMessages().find(message => message.permissionAnswer)?.permissionAnswer).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(run.titles).toEqual(expect.arrayContaining(["Blocked: Write /outside/c.txt", "A helper was blocked from changing something outside the task folder"]));
  });

  it("shows what actually changed in the task folder when a helper misreports, and keeps its usage", async () => {
    const run = await runTurn("misreport");
    expect(run.result).toMatchObject({ status: "completed" });
    expect(run.titles).toContain("Files changed in the task folder: a.txt");
    expect(run.status.terminalPromptUsage).toMatchObject({ event: { breakdown: { totalTokens: 133035 } } });
  });

  it("never turns free-form brief wording into a required file", async () => {
    const run = await runTurn("cautious-brief");
    expect(run.result).toMatchObject({ status: "completed" });
  });

  it("refuses a swarm in a read-only (planning) run before the CLI starts", async () => {
    const { options, clientMessages } = setup("success", { readOnly: true });
    await expect(openAntigravitySwarmRuntime(options)).rejects.toMatchObject({ code: "ANTIGRAVITY_SWARM_UNAVAILABLE", message: expect.stringMatching(/planning/) });
    expect(clientMessages()).toEqual([]);
  });

  it("refuses extra tool servers it would have to drop", async () => {
    const extra = setup("success");
    (extra.options as unknown as { mcpServers: unknown[] }).mcpServers.push({ name: "github", command: "/bin/x", args: [], env: {}, runnerOwned: false });
    await expect(openAntigravitySwarmRuntime(extra.options)).rejects.toThrow(/other tool servers/);
  });

  it("turns a provider mode change during admission into a typed failure, stops the CLI, and keeps the caller alive", async () => {
    const { options } = setup("mode-flip");
    let pid = 0;
    const spawn = options.command.spawn;
    (options.command as { spawn: typeof spawn }).spawn = (...args) => { const child = spawn(...args); pid = child.pid!; return child; };
    await expect(openAntigravitySwarmRuntime(options, { readbackTimeoutMs: 500 })).rejects.toMatchObject({ code: "ANTIGRAVITY_SWARM_RECEIPT_MISMATCH" });
    expect(alive(pid)).toBe(false);
  });

  it("fails the next turn and stops the CLI when settings change between turns", async () => {
    const { options } = setup("mode-flip-idle");
    const runtime = await openAntigravitySwarmRuntime(options);
    await new Promise(resolve => setTimeout(resolve, 300));
    const turn = runtime.startTurn({ text: "go", requestId: "r:1" });
    for await (const _ of turn.events) { /* drain */ }
    expect(await turn.result).toMatchObject({ status: "failed", error: { code: "ANTIGRAVITY_SWARM_RECEIPT_MISMATCH" } });
    await runtime.close({ reason: "done" });
  });

  it.each(["outside-edit", "dotdot-edit", "symlink-edit", "shell-escape"])("stops the swarm on a visible change outside the task folder: %s", async scenario => {
    const run = await runTurn(scenario);
    expect(run.result).toMatchObject({ status: "failed", error: { code: "ANTIGRAVITY_SWARM_WORKSPACE_ESCAPE", message: expect.stringMatching(/outside the task folder/) } });
  });

  it("allows reading outside the task folder when the change lands inside it", async () => {
    const run = await runTurn("shell-read");
    expect(run.result).toMatchObject({ status: "completed" });
  });

  it("treats a saved conversation as one a swarm cannot reopen, so the server starts a fresh one", async () => {
    await expect(openAntigravitySwarmRuntime(setup("success", { restoringSession: true }).options))
      .rejects.toMatchObject({ code: "ANTIGRAVITY_SAVED_STATE_INCOMPATIBLE" });
  });

  it("keeps a stable record identity while the CLI session id is per run", async () => {
    const { options } = setup("success");
    const runtime = await openAntigravitySwarmRuntime(options);
    expect((await runtime.identity()).acpxRecordId).toBe("antigravity-cli:key");
    await runtime.close({ reason: "done" });
  });

  it("refuses a helper on its own workspace copy", async () => {
    const run = await runTurn("escape");
    expect(run.result).toMatchObject({ status: "failed", error: { code: "ANTIGRAVITY_SWARM_WORKSPACE_ESCAPE" } });
  });

  it.each(["refusal", "quota"])("classifies a %s that arrives as text as a typed failure", async scenario => {
    const run = await runTurn(scenario);
    expect(run.result).toMatchObject({ status: "failed" });
    expect(run.failures[0]?.provider?.kind).toBe(scenario === "refusal" ? "quota_exhausted" : "rate_limit");
  });

  it("stops every helper on Stop and leaves no process behind", async () => {
    let cancelled = false;
    const run = await runTurn("cancel", { onEvent: (event, cancel) => {
      if (!cancelled && event.type === "tool_call" && /verifier/.test(event.title ?? "")) { cancelled = true; void cancel(); }
    } });
    expect(run.result).toMatchObject({ status: "cancelled" });
    expect(run.clientMessages().some(message => message.method === "session/cancel")).toBe(true);
    const worker = Number(readFileSync(run.workerPidFile, "utf8"));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(alive(worker)).toBe(false);
  });

  it("names a lost CLI process so Retry starts a fresh swarm", async () => {
    const run = await runTurn("die");
    expect(run.result).toMatchObject({ status: "failed", error: { code: "ACPX_PROVIDER_PROCESS_LOST" } });
    const worker = Number(readFileSync(run.workerPidFile, "utf8"));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(alive(worker)).toBe(false);
  });

  const trackPid = (options: AcpxRuntimePortOpenOptions) => {
    const tracked = { pid: 0 };
    const spawnChild = options.command.spawn;
    (options.command as { spawn: typeof spawnChild }).spawn = (...args) => { const child = spawnChild(...args); tracked.pid = child.pid!; return child; };
    return tracked;
  };

  it.each<AntigravitySwarmStage>(["spawned", "initialized", "session", "mode", "model"])("a Stop at %s ends admission, sends no prompt and stops the CLI", async stage => {
    const { options, clientMessages } = setup("success");
    const tracked = trackPid(options);
    const stop = new AbortController();
    await expect(openAntigravitySwarmRuntime({ ...options, signal: stop.signal } as AcpxRuntimePortOpenOptions,
      { onStage: current => { if (current === stage) stop.abort(new Error("Stop")); } })).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(clientMessages().some(message => message.method === "session/prompt")).toBe(false);
    expect(alive(tracked.pid)).toBe(false);
  });

  it.each<[AntigravitySwarmStage, number]>([["snapshot", 0], ["helpers", 1]])("a Stop at %s starts no further billable prompt and stops the CLI", async (stage, prompts) => {
    const { options, clientMessages } = setup("live-helpers");
    const tracked = trackPid(options);
    let cancel: () => Promise<void> = async () => {};
    const runtime = await openAntigravitySwarmRuntime(options, { helperWaitTimeoutMs: 5_000, cancelGraceMs: 500,
      onStage: async current => { if (current === stage) await cancel(); } });
    const turn = runtime.startTurn({ text: "go", requestId: "r:1" });
    cancel = () => turn.cancel();
    for await (const _ of turn.events) { /* drain */ }
    expect(await turn.result).toMatchObject({ status: "cancelled" });
    await runtime.close({ reason: "Stop" });
    expect(clientMessages().filter(message => message.method === "session/prompt")).toHaveLength(prompts);
    expect(alive(tracked.pid)).toBe(false);
  });

  it("runs at most one swarm per run", async () => {
    const { options } = setup("success");
    const runtime = await openAntigravitySwarmRuntime(options);
    const first = runtime.startTurn({ text: "go", requestId: "r:1" });
    for await (const _ of first.events) { /* drain */ }
    await first.result;
    const second = runtime.startTurn({ text: "again", requestId: "r:2" });
    for await (const _ of second.events) { /* drain */ }
    expect(await second.result).toMatchObject({ status: "failed", error: { code: "ANTIGRAVITY_SWARM_UNAVAILABLE" } });
    await runtime.close({ reason: "done" });
  });
});
