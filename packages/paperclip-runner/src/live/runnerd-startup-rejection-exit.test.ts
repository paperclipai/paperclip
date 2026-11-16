import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

const REJECTION = "error creating thread: fs sandbox helper failed: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";

function processAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch { return true; }
}

it.each([
  ["saves an unsettled checkpoint", false],
  // The controller's real remote checkpoint refuses a session with no provider
  // identity, which is exactly the state a rejected session.open leaves.
  ["refuses the checkpoint for lack of a provider identity", true],
])("proves a runner whose provider rejected session.open stopped, when the controller %s", async (_label, refuseCheckpoint) => {
  const root = await mkdtemp(join(tmpdir(), "runner-startup-rejection-"));
  const settlements: string[] = [];
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "provider.json"), "--reject-thread-start", REJECTION],
    stateDirectory: root,
    controlPlaneRegistration: async authority => {
      await authority.start();
      return {
        release: () => undefined,
        checkpoint: (settlement: "settled" | "unsettled") => {
          settlements.push(settlement);
          if (refuseCheckpoint) throw new Error("runnerd did not report its provider identity");
        },
      };
    },
  });
  let pid: number | null = null;
  try {
    const failure = await bundle.transport.request("thread/start", { cwd: root }).then(() => null, (error: unknown) => error);
    expect(String(failure)).toContain("session.open");
    pid = bundle.evidence().runnerPid;
    expect(pid).not.toBeNull();
    expect(bundle.transport.runnerExitConfirmed?.()).toBe(false);
    // The runner cannot suspend without a session, so close kills it and waits
    // for its exit; the checkpoint is "unsettled" and may be refused.
    await bundle.transport.close().catch(() => undefined);
    expect(settlements).toEqual(["unsettled"]);
    expect(bundle.transport.runnerExitConfirmed?.()).toBe(true);
    expect(processAbsent(pid!)).toBe(true);
  } finally {
    await bundle.transport.close().catch(() => undefined);
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ } }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("gives no exit proof for a runner whose session opened", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-startup-opened-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "provider.json")],
    stateDirectory: root,
    controlPlaneRegistration: async authority => {
      await authority.start();
      return { release: () => undefined };
    },
  });
  let pid: number | null = null;
  try {
    await bundle.transport.request("thread/start", { cwd: root });
    pid = bundle.evidence().runnerPid;
    await bundle.transport.close().catch(() => undefined);
    // Provider work could follow an opened session; this proof never covers it.
    expect(bundle.transport.runnerExitConfirmed?.()).toBe(false);
  } finally {
    await bundle.transport.close().catch(() => undefined);
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ } }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
