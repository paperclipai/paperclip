import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { codexSemanticToolSpecs } from "../drivers/codex/codex-app-server-driver.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";

it("latches retirement timeouts across detach and close without signalling the retained runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-retirement-timeout-"));
  const home = join(root, "empty-home");
  await mkdir(home);
  let core: DurablePrpControlPlane | undefined;
  let release!: () => void;
  let pending: Promise<void> | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const bundle = createCapabilityRunnerdCodexTransport({
    stateDirectory: root, sourceCodexHome: home, environment: {}, closeGraceMs: 25,
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "fake-codex-state.json")],
    controlPlaneRegistration: async (value) => {
      core = value;
      await value.start();
      return { connectUrl: value.connectUrl, release: () => undefined };
    },
  });
  let pid: number | null = null;
  try {
    await bundle.transport.request("thread/start", { cwd: root, dynamicTools: codexSemanticToolSpecs() });
    pid = bundle.evidence().runnerPid;
    expect(pid).toEqual(expect.any(Number));
    const retire = core!.retireStoppedAuthority.bind(core!);
    vi.spyOn(core!, "retireStoppedAuthority").mockImplementation(() => {
      pending ??= gate.then(retire);
      return pending;
    });
    const detached = bundle.detachControllerForRestart();
    await expect(detached).rejects.toThrow("native_controller_retirement_unsettled");
    await expect(bundle.detachControllerForRestart()).rejects.toThrow("native_controller_retirement_unsettled");
    await expect(bundle.transport.close()).rejects.toThrow("native_controller_retirement_unsettled");
    expect(() => process.kill(pid!, 0)).not.toThrow();
    release();
    await pending;
    // A late completion cannot turn an already rejected handoff into success.
    await expect(bundle.detachControllerForRestart()).rejects.toThrow("native_controller_retirement_unsettled");
  } finally {
    release();
    await pending?.catch(() => undefined);
    vi.restoreAllMocks();
    if (pid !== null) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Owned fixture already exited. */ }
    }
    await core?.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 15_000);
