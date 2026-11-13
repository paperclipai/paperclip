import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it, vi } from "vitest";

import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { QUALIFIED_ACPX_PROFILES } from "../drivers/acpx/qualified-profiles.js";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, type RunnerProviderLaunchRequirements } from "./runner-provider-launch.js";
import { createCapabilityRunnerdCodexTransport, readRunnerdArtifactBinding, type CapabilityRunnerdCodexTransportOptions } from "./runnerd-codex-transport.js";

const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const kill = (pid: number) => { try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };

type CoreEvent = { eventType: string; envelope: { payload?: Record<string, unknown> } };

async function awaitedTurn(tokens: string, providerStartedTurns: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runner-acpx-provider-wait-")));
  const journal = join(root, "calls"), fault = join(root, "fault"), wrapper = join(root, "sidecar"), script = join(root, "sidecar-entry");
  const background = join(root, "background");
  const binary = resolve(import.meta.dirname, "../../runner/target/debug/paperclip-runnerd"), sidecar = resolve(import.meta.dirname, "../../runner/target/debug/fake-acpx-sidecar");
  await mkdir(join(root, "acpx"), { mode: 0o700 }); await mkdir(join(root, "diagnostics"), { mode: 0o700 });
  await writeFile(script, "qualified fixture entry");
  await writeFile(background, tokens);
  await writeFile(wrapper, `#!/bin/sh\nexec ${quote(sidecar)} --mode source-reconcile --profile-digest ${quote(QUALIFIED_ACPX_PROFILES.claude.commandDigest)} --journal ${quote(journal)} --source-fault ${quote(fault)} --background-tasks ${quote(background)} --spawn-owned-child\n`, { mode: 0o700 });
  let authority: DurablePrpControlPlane | null = null;
  const server = createServer();
  server.on("upgrade", (request, socket, head) => authority ? authority.handleUpgrade(request, socket, "/runner", head) : socket.destroy());
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture listener");
  const identity = { runnerInstanceId: "runner-wait", environmentLeaseId: "lease-wait", runId: "run-wait", normalizedSessionId: "session-wait", turnId: "turn-wait", itemId: "item-wait" };
  const runnerPids = new Set<number>();
  let requirements: RunnerProviderLaunchRequirements | undefined;
  const options: CapabilityRunnerdCodexTransportOptions = {
    provider: "acpx", acpxAgent: "claude", runnerBinary: binary, stateDirectory: root, prpIdentity: identity,
    runnerArtifact: readRunnerdArtifactBinding(binary), codexSourceRecoveryVersion: 1, acpxSourceRecoveryVersion: 1,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null }, runnerProcessReconnectGraceMs: null, runnerReconnectGraceMs: 3_000,
    controlPlaneRegistration: async next => { authority = next; return { connectUrl: `ws://127.0.0.1:${address.port}/runner`, release: () => { authority = null; } }; },
    prepareLaunch: async launch => {
      requirements ??= structuredClone(launch);
      return { configurationId: `initial-${launch.identity.runId}`, requirementsDigest: runnerLaunchRequirementsDigest(launch),
        provider: createRunnerProviderLaunch(launch, { options: {}, root, cwd: root, codexHome: root, codexCommand: "", providerNodeCommand: wrapper, opencodeProxyPath: "", acpxSidecarPath: script }) };
    },
    runnerProcessLauncher: spec => {
      const stderr = openSync(join(root, "native.stderr"), "a", 0o600);
      const child = spawn(binary, [...spec.args, "--acpx-launch-authority-digest", sha("fixture authority"),
        "--acpx-sidecar-command", wrapper, "--acpx-sidecar-command-sha256", sha(execFileSync("cat", [wrapper])),
        "--acpx-sidecar-script", script, "--acpx-sidecar-script-sha256", sha("qualified fixture entry")],
        { env: { PATH: process.env.PATH, HOME: root, ...spec.environment }, stdio: ["ignore", "ignore", stderr], detached: true });
      closeSync(stderr);
      if (child.pid) runnerPids.add(child.pid);
      return { child, completion: new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal, stdout: "", stderr: "" })); }) };
    },
  };
  const bundles = [createCapabilityRunnerdCodexTransport(options)];
  const bundle = bundles[0]!;
  const calls = async () => (await readFile(journal, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  const coreEvents = async () => {
    const core = JSON.parse(await readFile(join(root, "control-plane", "control-plane-state.json"), "utf8")) as { committedEvents?: CoreEvent[] };
    return (core.committedEvents ?? []).map(event => ({ eventType: event.eventType,
      payload: ((event.envelope.payload ?? {}) as { payload?: Record<string, unknown> }).payload ?? {} }));
  };
  try {
    const opened = await bundle.transport.request("thread/start", { cwd: root, model: "explicit-source-model", dynamicTools: [] });
    const thread = opened.thread as { id: string; sessionId: string };
    authority!.queueCommand("turn.start", { text: "Install and test.", turnId: "turn-own-1", ...(providerStartedTurns ? { providerStartedTurns: true } : {}) }, undefined, true);
    await vi.waitFor(async () => expect((await coreEvents()).some(event => event.eventType === "turn.completed")).toBe(true), { timeout: 10_000, interval: 50 });
    const restartRunner = async () => {
      const providerIdentity = JSON.parse(await readFile(join(root, "runner", "acpx-provider-state.json"), "utf8")).identity;
      const pid = bundle.evidence().runnerPid!;
      await bundle.detachControllerForRestart(); kill(pid);
      for (const entry of await calls()) if (typeof entry.processStart === "number") kill(entry.processStart);
      const recovered = createCapabilityRunnerdCodexTransport({ ...options, recoveryLaunch: { requirements: requirements! },
        resumeProviderSession: { driverSessionId: thread.id, providerSessionId: thread.sessionId, providerIdentity },
        onRecoveryAccountingEvent: async () => {}, authorityRunId: identity.runId });
      bundles.push(recovered);
      await recovered.transport.request("thread/read", {});
      return recovered;
    };
    return { coreEvents, calls, root, authority: authority!, restartRunner };
  } catch (error) {
    throw new Error(`${String(error)}\n${await readFile(join(root, "native.stderr"), "utf8").catch(() => "")}`, { cause: error });
  } finally {
    cleanups.push(async () => {
      for (const opened of bundles.reverse()) await opened.transport.close().catch(() => undefined);
      for (const pid of runnerPids) kill(pid);
      for (const entry of await calls()) if (typeof entry.processStart === "number") kill(entry.processStart);
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    });
  }
}

const cleanups: Array<() => Promise<void>> = [];

const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  try { return !execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim().startsWith("Z"); }
  catch (error) { if ((error as { status?: number }).status === 1) return false; throw error; }
};

const runTerminals = (events: Array<{ eventType: string; payload: Record<string, unknown> }>) => events.filter(event => event.eventType === "run.terminal");
const commands = async (calls: () => Promise<Array<Record<string, unknown>>>) => (await calls()).map(entry => entry.command).filter(Boolean);

it.skipIf(process.platform === "win32")("ends a wait through the real runnerd when the sidecar exits while a descendant keeps its output open", async () => {
  try {
    const run = await awaitedTurn("live provider-turn provider-turn-hold provider-sidecar-exit-after-arm", true);
    const awaited = (await run.coreEvents()).find(event => event.eventType === "turn.completed");
    expect(awaited?.payload.awaitingProviderTurn).toBe(true);
    await vi.waitFor(async () => expect(runTerminals(await run.coreEvents())).toHaveLength(1), { timeout: 10_000, interval: 100 });
    const events = await run.coreEvents();
    expect(runTerminals(events)[0]!.payload).toMatchObject({ turnTerminalState: "completed", runTerminalState: "succeeded" });
    expect(events.findIndex(event => event.eventType === "run.terminal")).toBeGreaterThan(events.findIndex(event => event.eventType === "turn.completed"));
    expect(await commands(run.calls)).toContain("session.provider_turn");
  } finally { for (const cleanup of cleanups.splice(0)) await cleanup(); }
}, 60_000);

it.skipIf(process.platform === "win32")("ends a wait through the real runnerd when the sidecar reports the provider lost", async () => {
  try {
    const run = await awaitedTurn("live provider-turn provider-turn-hold provider-lost-after-arm", true);
    await vi.waitFor(async () => expect(runTerminals(await run.coreEvents())).toHaveLength(1), { timeout: 10_000, interval: 100 });
    const events = await run.coreEvents();
    expect(events.find(event => event.eventType === "turn.completed")?.payload.awaitingProviderTurn).toBe(true);
    expect(events.some(event => event.payload.code === "ACPX_PROVIDER_PROCESS_LOST")).toBe(true);
  } finally { for (const cleanup of cleanups.splice(0)) await cleanup(); }
}, 60_000);

it.skipIf(process.platform === "win32")("emits run.terminal with the completed turn and never arms without the controller opt-in", async () => {
  try {
    const run = await awaitedTurn("live provider-turn provider-turn-hold provider-sidecar-exit-after-arm", false);
    await vi.waitFor(async () => expect(runTerminals(await run.coreEvents())).toHaveLength(1), { timeout: 5_000, interval: 50 });
    const events = await run.coreEvents();
    expect(events.find(event => event.eventType === "turn.completed")?.payload.awaitingProviderTurn).toBeUndefined();
    expect(await commands(run.calls)).not.toContain("session.provider_turn");
  } finally { for (const cleanup of cleanups.splice(0)) await cleanup(); }
}, 60_000);

it.skipIf(process.platform === "win32")("cancelling the run during a wait disarms the provider, publishes the held terminal and admits no later provider turn", async () => {
  try {
    const run = await awaitedTurn("live provider-turn provider-turn-hold provider-turn-after-disarm", true);
    expect(runTerminals(await run.coreEvents())).toHaveLength(0);
    run.authority.queueCommand("run.cancel", { reason: "Operator stop" }, undefined, true);
    await vi.waitFor(async () => expect(runTerminals(await run.coreEvents())).toHaveLength(1), { timeout: 10_000, interval: 100 });
    expect(runTerminals(await run.coreEvents())[0]!.payload).toMatchObject({ turnTerminalState: "completed" });
    expect((await run.calls()).some(entry => entry.command === "session.provider_turn" && (entry.params as { armed?: unknown }).armed === false)).toBe(true);
    await new Promise(done => setTimeout(done, 1_000));
    const events = await run.coreEvents();
    expect(events.some(event => event.payload.origin === "provider")).toBe(false);
    expect(runTerminals(events)).toHaveLength(1);
    run.authority.queueCommand("session.close", { reason: "Run cancelled" }, undefined, true);
    const processes = (await run.calls()).flatMap(entry => [entry.processStart, entry.childPid]).filter((pid): pid is number => typeof pid === "number");
    expect(processes.length).toBeGreaterThan(0);
    await vi.waitFor(() => { for (const pid of processes) expect(alive(pid)).toBe(false); }, { timeout: 10_000, interval: 100 });
  } finally { for (const cleanup of cleanups.splice(0)) await cleanup(); }
}, 60_000);

it.skipIf(process.platform === "win32")("publishes the held run.terminal exactly once when runnerd restarts during the wait", async () => {
  try {
    const run = await awaitedTurn("live provider-turn provider-turn-hold", true);
    expect((await run.coreEvents()).find(event => event.eventType === "turn.completed")?.payload.awaitingProviderTurn).toBe(true);
    expect(runTerminals(await run.coreEvents())).toHaveLength(0);
    await run.restartRunner();
    await vi.waitFor(async () => expect(runTerminals(await run.coreEvents())).toHaveLength(1), { timeout: 10_000, interval: 100 });
    expect(runTerminals(await run.coreEvents())[0]!.payload).toMatchObject({ turnTerminalState: "completed", runTerminalState: "succeeded" });
    await new Promise(done => setTimeout(done, 1_000));
    expect(runTerminals(await run.coreEvents())).toHaveLength(1);
  } finally { for (const cleanup of cleanups.splice(0)) await cleanup(); }
}, 60_000);

