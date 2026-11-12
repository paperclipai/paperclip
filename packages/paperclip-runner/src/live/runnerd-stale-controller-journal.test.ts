import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { PersistedHarnessProviderIdentity } from "../contracts/harness-driver.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

const identity = {
  runnerInstanceId: "stale-journal-runner",
  environmentLeaseId: "stale-journal-lease",
  runId: "stale-journal-run",
  normalizedSessionId: "stale-journal-session",
  turnId: "stale-journal-turn",
  itemId: "stale-journal-item",
};

function transport(root: string, resumeProviderSession?: { driverSessionId: string; providerSessionId: string; providerIdentity?: PersistedHarnessProviderIdentity }) {
  return createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(root),
    stateDirectory: root,
    prpIdentity: identity,
    ...(resumeProviderSession ? { resumeProviderSession } : {}),
  });
}

function kill(pid: number | null | undefined) {
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

it.each(["stale", "current"] as const)("a follow-up controller on the predecessor's suspended runner with a %s journal keeps the runner and gets a precise answer", async journal => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-stale-journal-"));
  const controlPath = join(root, "control-plane", "control-plane-state.json");
  const predecessor = transport(root);
  let follower: ReturnType<typeof transport> | undefined;
  try {
    const opened = (await predecessor.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] })).thread as { id: string; sessionId: string };
    await predecessor.transport.close();
    const closed = JSON.parse(await readFile(controlPath, "utf8")) as { commands: Array<{ type: string }> } & Record<string, unknown>;
    expect(closed.commands.map(command => command.type).slice(-2)).toEqual(["runner.drain", "runner.suspend"]);
    const runner = JSON.parse(await readFile(join(root, "runner", "runner-state.json"), "utf8")) as { lastControllerCommandSeq: number; lifecycle: string };
    expect(runner).toMatchObject({ lastControllerCommandSeq: closed.commands.length, lifecycle: "suspended" });
    if (journal === "stale") await writeFile(controlPath, JSON.stringify({ ...closed, commands: closed.commands.slice(0, -2) }));

    const providerIdentity = journal === "stale" ? { providerIdentity: { kind: "acpx", normalizedSessionId: identity.normalizedSessionId } as unknown as PersistedHarnessProviderIdentity } : {};
    follower = transport(root, { driverSessionId: opened.id, providerSessionId: opened.sessionId, ...providerIdentity });
    const outcome = await follower.transport.request("thread/read", {})
      .then(() => "resumed", (error: unknown) => String(error));
    if (journal === "stale") {
      expect(outcome).toContain('"code":"controller_sequence_mismatch"');
      expect(outcome).not.toMatch(/runnerd exited/);
      expect(follower.evidence().runnerExited).toBe(false);
      const after = JSON.parse(await readFile(join(root, "runner", "runner-state.json"), "utf8")) as { lastControllerCommandSeq: number };
      expect(after.lastControllerCommandSeq).toBe(closed.commands.length);
    } else {
      expect(outcome).toBe("resumed");
      expect(outcome).not.toContain("controller sequence must be contiguous");
    }
  } finally {
    await follower?.transport.close().catch(() => undefined);
    await predecessor.transport.close().catch(() => undefined);
    kill(predecessor.evidence().runnerPid);
    kill(follower?.evidence().runnerPid);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
