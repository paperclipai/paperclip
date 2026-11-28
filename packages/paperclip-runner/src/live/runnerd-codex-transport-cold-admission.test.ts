import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { QUALIFIED_ACPX_PROFILES } from "../drivers/acpx/qualified-profiles.js";
import { codexSemanticToolSpecs } from "../drivers/codex/codex-app-server-driver.js";
import * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import {
  createCapabilityRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary as qualifiedCapabilityRunnerdBinary,
} from "./runnerd-codex-transport.js";

// Split out of runnerd-codex-transport-deadlines.test.ts so the 40s Codex cold
// start and 32s Pi warm reopen waits overlap with the other deadline suites
// across Vitest workers instead of serializing into a single 180s file.
const defaultCapabilityRunnerdBinary = () =>
  process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ?? qualifiedCapabilityRunnerdBinary();
const fakeCodex = resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server");
function fakeCodexArgs(stateDirectory: string, ...args: string[]): string[] {
  return ["--state-file", join(stateDirectory, "fake-codex-state.json"), ...args];
}

async function withUnprovableLiveness<T>(run: (unprove: () => void) => Promise<T>): Promise<T> {
  let unproven = false;
  const OriginalCore = durableControlPlane.DurablePrpControlPlane;
  const coreSpy = vi.spyOn(durableControlPlane, "DurablePrpControlPlane")
    .mockImplementation(function(options: ConstructorParameters<typeof OriginalCore>[0]) {
      const core = new OriginalCore(options);
      const queueCommand = core.queueCommand.bind(core);
      core.queueCommand = ((type: string, ...rest: unknown[]) => {
        if (unproven && type === "session.snapshot") throw new Error("runner snapshot unavailable");
        return (queueCommand as (...args: unknown[]) => unknown)(type, ...rest);
      }) as typeof core.queueCommand;
      return core;
    } as unknown as typeof OriginalCore);
  try {
    return await run(() => { unproven = true; });
  } finally {
    coreSpy.mockRestore();
  }
}

it("gives a silent Codex cold start the measured default start window", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-cold-turn-start-"));
  const callsPath = join(stateDirectory, "calls.log");
  const outcome = await withUnprovableLiveness(async (unprove) => {
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(stateDirectory, "--turn-started-delay-ms", "40000", "--call-log", callsPath),
      stateDirectory,
    });
    try {
      await bundle.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
      unprove();
      const started = Date.now();
      const outcome = await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Start slowly." }] })
        .then(result => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
      const elapsedMs = Date.now() - started;
      const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);
      return { ...outcome, elapsedMs, turnStarts: calls.filter(call => call === "turn/start").length };
    } finally {
      await bundle.transport.close().catch(() => undefined);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
  expect(outcome.error).toBeNull();
  expect(outcome.result).toMatchObject({ turn: { id: "provider-turn-1" } });
  expect(outcome.elapsedMs).toBeGreaterThan(38_000);
  expect(outcome.turnStarts).toBe(1);
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
