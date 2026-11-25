import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import {
  createCapabilityRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary as qualifiedCapabilityRunnerdBinary,
} from "./runnerd-codex-transport.js";

// Split out of runnerd-codex-transport-deadlines.test.ts so the 60s connection
// lease renewal wait runs in parallel with the other deadline regressions on
// its own worker instead of extending a single serial 180s critical path.
const defaultCapabilityRunnerdBinary = () =>
  process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ?? qualifiedCapabilityRunnerdBinary();
const fakeCodex = resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server");
function fakeCodexArgs(stateDirectory: string, ...args: string[]): string[] {
  return ["--state-file", join(stateDirectory, "fake-codex-state.json"), ...args];
}

it("keeps a quiet active Codex turn in the same process across connection lease expiry", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-renew-active-"));
  const callsPath = join(stateDirectory, "calls.log");
  const cores: DurablePrpControlPlane[] = [];
  const OriginalCore = durableControlPlane.DurablePrpControlPlane;
  const coreSpy = vi.spyOn(durableControlPlane, "DurablePrpControlPlane")
    .mockImplementation(function(options: ConstructorParameters<typeof OriginalCore>[0]) {
      const core = new OriginalCore({ ...options, connectionLeaseTtlMs: 60_000 });
      cores.push(core);
      return core;
    } as unknown as typeof OriginalCore);
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--hold-turn", "--record-process-start", "--call-log", callsPath),
    stateDirectory, runnerReconnectGraceMs: 5_000,
  });
  try {
    const opened = await bundle.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
    await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Keep working quietly." }] });
    const runnerPid = bundle.evidence().runnerPid;
    const codexPid = bundle.evidence().codexPid;
    expect(runnerPid).toBeGreaterThan(0);
    expect(codexPid).toBeGreaterThan(0);
    const core = cores[0]!;
    const original = structuredClone(Object.values(core.store.state.leases)[0]!);
    await vi.waitFor(() => {
      expect(Date.now()).toBeGreaterThan(original.expiresAtUnixMs + 1_000);
    }, { timeout: 75_000, interval: 1_000 });
    const current = Object.values(core.store.state.leases)[0]!;
    expect(current.expiresAtUnixMs).toBeGreaterThan(original.expiresAtUnixMs);
    expect(current.leaseId).toBe(original.leaseId);
    expect(core.store.state.connectionCount).toBe(1);
    expect(bundle.evidence().runnerPid).toBe(runnerPid);
    expect(bundle.evidence().codexPid).toBe(codexPid);
    process.kill(runnerPid!, 0);
    process.kill(codexPid!, 0);
    const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);
    expect(calls.filter(call => call === "process-start")).toHaveLength(1);
    expect(calls.filter(call => call === "thread/start")).toHaveLength(1);
    expect(calls.filter(call => call === "turn/start")).toHaveLength(1);
    expect(calls).not.toContain("turn/interrupt");
    expect(calls).not.toContain("thread/resume");
    const state = JSON.parse(await readFile(join(stateDirectory, "fake-codex-state.json"), "utf8"));
    expect(state.threadId).toBe((opened.thread as { id: string }).id);
    expect(state.activeTurnId).toBe("provider-turn-1");
  } finally {
    await bundle.transport.close();
    coreSpy.mockRestore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 90_000);
