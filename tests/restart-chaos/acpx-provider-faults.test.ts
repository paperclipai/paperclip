import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ACPX_FAULT_TAP, ACPX_SIDECAR_HOOK, installAcpxSidecarSeam, parseProviderFaultRestart, standInSidecarSource, withAcpxSidecarHook } from "./acpx-provider-faults.js";
import { parseCommand } from "./config.js";
import { readProviderFaultEvents, withProviderFaultCheck, type ProviderFaultEvent, type ProviderFaultRule } from "./provider-faults.js";
import { planWave, taskFaultSchedule } from "./scheduler.js";
import type { TaskPlan } from "./types.js";

const tap = createRequire(import.meta.url)(ACPX_FAULT_TAP) as {
  PROVIDER_BOOTSTRAP_MARKER: string;
  createAcpTap(runtime: unknown): { toProvider(line: string): void; fromProvider(line: string, emit: (line: string) => void): void; ended(): void };
  createSidecarTap(runtime: unknown): { fromRunner(line: string): void; toRunner(line: string, emit: (line: string) => void): void; ended(): void };
  createFaultRuntime(config: { controlPath: string; logPath: string; stateDirectory: string }): unknown;
};

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Rules, log and markers in a temp root, as the Codex seam lays them out. */
async function faultFiles(rules: Array<ProviderFaultRule & { nonce: string }>) {
  const root = await temporary("chaos-acpx-tap-");
  const files = { controlPath: path.join(root, "control.json"), logPath: path.join(root, "provider-faults.jsonl"), stateDirectory: path.join(root, "state") };
  await mkdir(files.stateDirectory);
  await writeFile(files.controlPath, JSON.stringify({ rules }));
  await writeFile(files.logPath, "");
  return { root, files };
}

const line = (value: unknown) => JSON.stringify(value);
const prompt = (id: number, sessionId: string, text: string) => line({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text }] } });
const cancel = (sessionId: string) => line({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
const promptResponse = (id: number, stopReason: string) => line({ jsonrpc: "2.0", id, result: { stopReason } });

describe("ACPX provider fault tap (ACP pipe)", () => {
  it("relays everything unchanged when no rule names the session's task", async () => {
    const { files } = await faultFiles([{ nonce: "other123", kind: "PV2", message: "terminal" }]);
    const acp = tap.createAcpTap(tap.createFaultRuntime(files));
    const out: string[] = [];
    acp.toProvider(prompt(1, "s1", "task aaaa1111"));
    acp.toProvider(cancel("s1"));
    acp.fromProvider(promptResponse(1, "cancelled"), value => out.push(value));
    expect(out).toEqual([promptResponse(1, "cancelled")]);
  });

  it("drops (PV2) only the prompt response that follows a cancel, once per task", async () => {
    const { files } = await faultFiles([{ nonce: "aaaa1111", kind: "PV2", message: "terminal" }]);
    const acp = tap.createAcpTap(tap.createFaultRuntime(files));
    const out: string[] = [];
    const update = line({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } } });
    acp.toProvider(prompt(1, "s1", "Chaos Q1 aaaa1111"));
    acp.fromProvider(update, value => out.push(value));
    acp.fromProvider(promptResponse(1, "end_turn"), value => out.push(value));
    // Not after a cancel: not the target.
    expect(out).toEqual([update, promptResponse(1, "end_turn")]);
    acp.toProvider(prompt(2, "s1", "continue"));
    acp.toProvider(cancel("s1"));
    acp.fromProvider(promptResponse(2, "cancelled"), value => out.push(value));
    expect(out).toHaveLength(2);
    acp.toProvider(prompt(3, "s1", "again"));
    acp.toProvider(cancel("s1"));
    acp.fromProvider(promptResponse(3, "cancelled"), value => out.push(value));
    expect(out.at(-1)).toBe(promptResponse(3, "cancelled"));
    const events = await readProviderFaultEvents(files.logPath, "aaaa1111");
    expect(events.filter(event => event.event === "applied")).toEqual([expect.objectContaining({ kind: "PV2", message: "terminal", action: "drop", turnStatus: "cancelled", layer: "acp" })]);
    expect(events.some(event => event.event === "interrupt_requested")).toBe(true);
  });

  it("duplicates (PV3) and delays (PV1) the terminal; a provider exit discards a held one", async () => {
    const { files } = await faultFiles([{ nonce: "bbbb2222", kind: "PV3", message: "terminal" }, { nonce: "cccc3333", kind: "PV1", message: "terminal", delayMs: 30 },
      { nonce: "dddd4444", kind: "PV1", message: "terminal", delayMs: 60_000 }]);
    const runtime = tap.createFaultRuntime(files);
    const duplicated: string[] = [];
    const first = tap.createAcpTap(runtime);
    first.toProvider(prompt(7, "s7", "bbbb2222"));
    first.toProvider(cancel("s7"));
    first.fromProvider(promptResponse(7, "cancelled"), value => duplicated.push(value));
    expect(duplicated).toEqual([promptResponse(7, "cancelled"), promptResponse(7, "cancelled")]);

    const delayed: string[] = [];
    const second = tap.createAcpTap(runtime);
    second.toProvider(prompt(1, "s8", "cccc3333"));
    second.toProvider(cancel("s8"));
    second.fromProvider(promptResponse(1, "cancelled"), value => delayed.push(value));
    expect(delayed).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(delayed).toEqual([promptResponse(1, "cancelled")]);

    const third = tap.createAcpTap(runtime);
    third.toProvider(prompt(1, "s9", "dddd4444"));
    third.toProvider(cancel("s9"));
    third.fromProvider(promptResponse(1, "cancelled"), () => { throw new Error("must stay held"); });
    third.ended();
    const events = await readProviderFaultEvents(files.logPath);
    expect(events.filter(event => event.nonce === "cccc3333").map(event => event.event)).toEqual(expect.arrayContaining(["applied", "released"]));
    expect(events.filter(event => event.nonce === "dddd4444").map(event => event.event)).toEqual(expect.arrayContaining(["applied", "held_message_discarded"]));
  });
});

describe("ACPX provider fault tap (runner pipe)", () => {
  it("targets the sidecar's turn.cancel acknowledgement, never events", async () => {
    const { files } = await faultFiles([{ nonce: "eeee5555", kind: "PV2", message: "interrupt_ack" }]);
    const sidecar = tap.createSidecarTap(tap.createFaultRuntime(files));
    const out: string[] = [];
    sidecar.fromRunner(line({ protocolVersion: 1, id: 4, command: "turn.start", params: { turnId: "t1", input: "eeee5555" } }));
    sidecar.toRunner(line({ protocolVersion: 1, id: 4, ok: true, result: { turnId: "t1" } }), value => out.push(value));
    sidecar.fromRunner(line({ protocolVersion: 1, id: 5, command: "turn.cancel", params: { turnId: "t1" } }));
    const event = line({ protocolVersion: 1, sequence: 9, eventType: "turn.completed", runId: "r", turnId: "t1", payload: {} });
    sidecar.toRunner(event, value => out.push(value));
    sidecar.toRunner(line({ protocolVersion: 1, id: 5, ok: true, result: { cancelled: true, sessionClosed: false } }), value => out.push(value));
    expect(out).toEqual([line({ protocolVersion: 1, id: 4, ok: true, result: { turnId: "t1" } }), event]);
    expect(await readProviderFaultEvents(files.logPath, "eeee5555")).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "applied", kind: "PV2", message: "interrupt_ack", turnStatus: "cancelled", layer: "sidecar" })]));
  });
});

/** A stand-in for the real ACPX sidecar bundle (runner frames in, ACP to a marked "provider"). */
const FAKE_SIDECAR = path.join(import.meta.dirname, "fixtures", "fake-acpx-sidecar.cjs");

async function driveStandIn(rules: Array<ProviderFaultRule & { nonce: string }>) {
  const { root, files } = await faultFiles(rules);
  const realSidecar = FAKE_SIDECAR;
  const standIn = path.join(root, "stand-in.cjs");
  await writeFile(standIn, standInSidecarSource({ tapModule: ACPX_FAULT_TAP, realSidecar, ...files }));
  const child = spawn(process.execPath, [standIn], { stdio: ["pipe", "pipe", "inherit"] });
  const frames: Array<Record<string, unknown>> = [];
  let buffer = "";
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) { frames.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); }
  });
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const until = async (predicate: () => boolean, ms = 3_000) => {
    const end = Date.now() + ms;
    while (!predicate()) { if (Date.now() > end) return false; await new Promise(resolve => setTimeout(resolve, 10)); }
    return true;
  };
  return { child, frames, send, until, files };
}

describe("ACPX stand-in sidecar", () => {
  it("loads the real sidecar with the tap: a dropped provider terminal never reaches the runner", async () => {
    const { child, frames, send, until, files } = await driveStandIn([{ nonce: "ffff6666", kind: "PV2", message: "terminal" }]);
    send({ protocolVersion: 1, id: 1, command: "turn.start", params: { turnId: "t1", input: "Chaos Q1 ffff6666" } });
    expect(await until(() => frames.some(frame => frame.id === 1))).toBe(true);
    send({ protocolVersion: 1, id: 2, command: "turn.cancel", params: { turnId: "t1" } });
    expect(await until(() => frames.some(frame => frame.id === 2))).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(frames.some(frame => frame.eventType === "turn.completed")).toBe(false);
    send({ protocolVersion: 1, id: 3, command: "session.close", params: {} });
    child.stdin.end();
    await new Promise(resolve => child.once("exit", resolve));
    const events = await readProviderFaultEvents(files.logPath, "ffff6666");
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ event: "applied", layer: "acp", action: "drop", turnStatus: "cancelled" })]));
  });

  it("without a rule the stand-in relays the turn end; with an ack rule it delays only the ack", async () => {
    const { child, frames, send, until, files } = await driveStandIn([{ nonce: "abab7777", kind: "PV1", message: "interrupt_ack", delayMs: 300 }]);
    send({ protocolVersion: 1, id: 1, command: "turn.start", params: { turnId: "t1", input: "Chaos S1 abab7777" } });
    expect(await until(() => frames.some(frame => frame.id === 1))).toBe(true);
    send({ protocolVersion: 1, id: 2, command: "turn.cancel", params: { turnId: "t1" } });
    expect(await until(() => frames.some(frame => frame.eventType === "turn.completed"))).toBe(true);
    expect(frames.some(frame => frame.id === 2)).toBe(false);
    expect(await until(() => frames.some(frame => frame.id === 2))).toBe(true);
    send({ protocolVersion: 1, id: 3, command: "session.close", params: {} });
    child.stdin.end();
    await new Promise(resolve => child.once("exit", resolve));
    const events = await readProviderFaultEvents(files.logPath, "abab7777");
    expect(events.map(event => event.event)).toEqual(expect.arrayContaining(["applied", "released"]));
  });
});

describe("ACPX sidecar hook", () => {
  it("loads only the sidecar-path module from the stand-in package; its imports stay real", async () => {
    const root = await temporary("chaos-acpx-hook-");
    const runner = path.join(root, "packages", "paperclip-runner");
    await mkdir(path.join(runner, "dist", "live"), { recursive: true });
    await mkdir(path.join(runner, "dist", "cli"), { recursive: true });
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(runner, "package.json"), JSON.stringify({ name: "@paperclipai/paperclip-runner", type: "module" }));
    await writeFile(path.join(runner, "dist", "live", "helper.js"), "export const helperUrl = import.meta.url;\n");
    await writeFile(path.join(runner, "dist", "live", "runnerd-codex-transport.js"), [
      `import { helperUrl } from "./helper.js";`,
      `import { fileURLToPath } from "node:url";`,
      `export const sidecar = fileURLToPath(new URL("../cli/acpx-runtime-sidecar.cjs", import.meta.url));`,
      `export { helperUrl };`, ""].join("\n"));
    await writeFile(path.join(runner, "dist", "cli", "acpx-runtime-sidecar.cjs"), "// real\n");
    await writeFile(path.join(runner, "dist", "cli", "codex.js"), "// real\n");
    const seam = await installAcpxSidecarSeam({ repositoryRoot: root, waveId: "w-test-s1", controlPath: "/c", logPath: "/l", stateDirectory: "/s" });
    expect(seam.standInRoot).toBe(path.join(await import("node:fs/promises").then(fs => fs.realpath(root)), "node_modules", ".restart-chaos-w-test-s1", "paperclip-runner"));
    expect(await readlink(path.join(seam.standInRoot, "package.json"))).toBe(path.join(seam.realSidecar, "../../..", "package.json"));
    expect(await readlink(path.join(seam.standInRoot, "dist", "cli", "codex.js"))).toContain(path.join("packages", "paperclip-runner", "dist", "cli", "codex.js"));
    const realTransport = path.join(seam.serverEnvironment.RESTART_CHAOS_ACPX_RUNNER_REAL!, "dist", "live", "runnerd-codex-transport.js");
    const script = `const m = await import(${JSON.stringify(pathToFileURL(realTransport).href)}); console.log(JSON.stringify({ sidecar: m.sidecar, helperUrl: m.helperUrl, nodeOptions: process.env.NODE_OPTIONS ?? null }));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8",
      env: { ...process.env, ...seam.serverEnvironment, NODE_OPTIONS: withAcpxSidecarHook("--no-warnings") } });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { sidecar: string; helperUrl: string; nodeOptions: string | null };
    expect(output.sidecar).toBe(path.join(seam.standInRoot, "dist", "cli", "acpx-runtime-sidecar.cjs"));
    expect(output.helperUrl).toBe(pathToFileURL(path.join(path.dirname(realTransport), "helper.js")).href);
    expect(output.nodeOptions).toBe("--no-warnings");
    const standIn = await readFile(output.sidecar, "utf8");
    expect(standIn).toContain(ACPX_FAULT_TAP);
    expect(standIn).toContain(seam.realSidecar);
    expect(withAcpxSidecarHook(undefined)).toBe(`--import=${ACPX_SIDECAR_HOOK}`);
    await seam.remove();
  });
});

function task(nonce: string, rule: ProviderFaultRule): TaskPlan {
  return { taskId: "t01", index: 0, workload: "Q1", adapter: "claude", fault: rule.kind, fireAfterMs: 0, holdMs: 0, followUpAfterMs: null, nonce, providerFault: rule };
}

describe("provider faults across a restart", () => {
  it("plans Claude PV tasks and a K1 armed by the provider trigger", () => {
    const command = parseCommand(["--adapters", "claude", "--workloads", "Q1", "--faults", "PV1,PV2", "--provider-fault-restart", "K1",
      "--provider-fault-restart-after-seconds", "4", "--tasks", "2", "--concurrency", "1", "--seed", "5"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options).toMatchObject({ adapters: ["claude"], providerFaultRestart: "K1", providerFaultRestartAfterMs: 4_000, faults: [] });
    const plan = planWave("w-20261109T000000-s5", command.options);
    for (const planned of plan.tasks) {
      expect(planned.providerFault?.restart).toEqual({ kind: "K1", afterAppliedMs: 4_000 });
      expect(taskFaultSchedule(planned)).toEqual([{ kind: "K1", holdMs: 0, atMs: 0, trigger: "provider", delayMs: 4_000 }]);
    }
  });

  it("rejects restarts that cannot straddle the fault", () => {
    expect(() => parseCommand(["--adapters", "claude", "--workloads", "Q1", "--faults", "PV3", "--provider-fault-restart", "K1"])).toThrow(/PV1 or PV2/);
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "Q1", "--faults", "PV1", "--provider-fault-delays", "5",
      "--provider-fault-restart", "K1", "--provider-fault-restart-after-seconds", "6"])).toThrow(/shorter than every PV1 delay/);
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "Q1", "--faults", "PV2", "--provider-fault-restart", "K2"])).toThrow(/K1/);
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "Q1", "--faults", "K1", "--provider-fault-restart", "K1"])).toThrow(/provider fault/);
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "G1", "--faults", "PV2"])).toThrow(/G1 grades the board decision after a restart/);
    expect(parseCommand(["--adapters", "codex", "--workloads", "G1", "--faults", "PV2", "--provider-fault-restart", "K1", "--concurrency", "1"]).mode).toBe("wave");
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "Q1", "--faults", "PV2", "--provider-fault-restart", "K1", "--concurrency", "2"])).toThrow(/--concurrency 1/);
    expect(parseProviderFaultRestart(undefined, undefined, ["PV2"], undefined)).toEqual({});
    expect(() => parseProviderFaultRestart(undefined, "3", ["PV2"], undefined)).toThrow(/needs --provider-fault-restart/);
  });

  it("passes only when the restart came after the fault and before a PV1 release", () => {
    const pass = { verdict: "pass" as const, checks: [] };
    const rule: ProviderFaultRule = { kind: "PV1", message: "terminal", delayMs: 18_000, restart: { kind: "K1", afterAppliedMs: 3_000 } };
    const applied: ProviderFaultEvent = { at: 1_000, pid: 1, event: "applied", nonce: "aa", kind: "PV1", message: "terminal", action: "delay" };
    expect(withProviderFaultCheck(pass, task("aa", rule), [applied], 4_000).verdict).toBe("pass");
    expect(withProviderFaultCheck(pass, task("aa", rule), [applied], null).checks.at(-1)).toMatchObject({ ok: false, detail: expect.stringContaining("restart=none") });
    expect(withProviderFaultCheck(pass, task("aa", rule), [applied, { ...applied, event: "released", at: 2_000 }], 4_000).checks.at(-1))
      .toMatchObject({ ok: false, detail: expect.stringContaining("releasedBeforeRestart") });
    expect(withProviderFaultCheck(pass, task("aa", rule), [applied], 500).verdict).toBe("fail");
    // A provider that closed first took the held message with it before the K1: nothing straddled the restart.
    expect(withProviderFaultCheck(pass, task("aa", rule), [applied, { ...applied, event: "held_message_discarded", at: 3_000 }], 4_000).checks.at(-1))
      .toMatchObject({ ok: false, detail: expect.stringContaining("discardedBeforeRestart") });
    expect(withProviderFaultCheck(pass, task("aa", rule), [applied, { ...applied, event: "held_message_discarded", at: 5_000 }], 4_000).verdict).toBe("pass");
  });
});
