import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { QUALIFIED_ACPX_PROFILES } from "../drivers/acpx/qualified-profiles.js";
import { codexSemanticToolSpecs } from "../drivers/codex/codex-app-server-driver.js";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import {
  createCapabilityRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary as qualifiedCapabilityRunnerdBinary,
} from "./runnerd-codex-transport.js";

// These regressions must cross real production timing boundaries. Keep their
// waits intact, but let the existing file worker pool overlap them with the
// rest of the transport suite instead of extending its serial critical path.
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
    expect(state.threadId).toBe(opened.thread.id);
    expect(state.activeTurnId).toBe("provider-turn-1");
  } finally {
    await bundle.transport.close();
    coreSpy.mockRestore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 90_000);

it("reopens Pi after a completed turn within its cold admission budget during warm attachment", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-pi-warm-admission-"));
  const providerNode = process.platform === "linux" ? join(root, "node") : process.execPath;
  if (process.platform === "linux") {
    await cp(process.execPath, providerNode, { dereference: true });
    await chmod(providerNode, 0o500);
    expect((await stat(providerNode)).mode & 0o777).toBe(0o500);
  }
  const cliRoot = join(root, "dist/cli");
  await mkdir(cliRoot, { recursive: true, mode: 0o700 });
  const sidecarPath = join(cliRoot, "acpx-runtime-sidecar.cjs");
  const journal = join(root, "commands.ndjson");
  const fixture = await readFile(fileURLToPath(new URL("./fixtures/fake-pi-warm-sidecar.cjs", import.meta.url)), "utf8");
  await writeFile(sidecarPath, fixture.replace("/* fixture-config */ null", JSON.stringify({ journal, resumeDelayMs: 32_000, commandDigest: QUALIFIED_ACPX_PROFILES.pi.commandDigest })), { mode: 0o600 });
  const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  const bundle = createCapabilityRunnerdCodexTransport({
    provider: "acpx", acpxAgent: "pi", piThinkingLevel: "low", acpxPermissionMode: "deny-all",
    runnerBinary: defaultCapabilityRunnerdBinary(), stateDirectory: root, runnerFilesystemRoot: root,
    providerNodeCommand: providerNode, providerNodeCommandSha256: digest(providerNode),
    acpxSidecarPath: sidecarPath, acpxSidecarSha256: digest(sidecarPath),
    providerPackAuthorityDigest: `sha256:${"d".repeat(64)}`,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    environment: { PATH: "/usr/bin:/bin" },
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [{ type: "inputText", text: "Completion report accepted." }],
  }));
  let failure: unknown;
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: root, model: "openrouter/deepseek/deepseek-v4-flash-0731",
      dynamicTools: codexSemanticToolSpecs(),
      completionContract: { revision: "warm-pi-contract", criterionIds: [] },
    });
    const runnerPid = bundle.evidence().runnerPid;
    const notifications = bundle.transport.notifications()[Symbol.asyncIterator]();
    const completeTurn = async () => {
      await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Complete the fixture turn." }] });
      for (let index = 0; index < 64; index += 1) {
        const next = await Promise.race([
          notifications.next(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Fixture completion timed out")), 5_000)),
        ]);
        if (next.value?.method === "turn/completed") return;
      }
      throw new Error("Fixture turn did not complete");
    };
    await completeTurn();
    const started = Date.now();
    await bundle.transport.attachRun!({ runId: "run-pi-warm-second", turnId: "turn-pi-warm-second", itemId: "item-pi-warm-second" });
    expect(Date.now() - started).toBeGreaterThan(30_000);
    await completeTurn();
    expect(bundle.evidence()).toMatchObject({ runnerPid, runnerExited: false });
    const commands = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(commands.filter((entry) => entry.event === "spawn")).toHaveLength(2);
    expect(commands.filter((entry) => entry.command === "session.open")).toHaveLength(2);
    expect(commands.filter((entry) => entry.resumed)).toHaveLength(1);
    expect(commands.filter((entry) => entry.command === "turn.start")).toHaveLength(2);
    expect(commands.filter((entry) => entry.command === "session.close")).toHaveLength(1);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await bundle.transport.close();
    } catch (cleanupError) {
      if (failure) throw new AggregateError([failure, cleanupError], "Warm attachment and strict cleanup failed");
      throw cleanupError;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 75_000);
