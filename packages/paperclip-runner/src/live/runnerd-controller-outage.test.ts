import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { codexSemanticToolSpecs } from "../drivers/codex/codex-app-server-driver.js";
import {
  createCapabilityRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary,
} from "./runnerd-codex-transport.js";

it.each([
  { policy: "connection lease", processGraceMs: null, survives: true },
  { policy: "explicit process deadline", processGraceMs: 500, survives: false },
])("preserves the $policy policy across controller downtime beyond the connection recovery budget", async ({ processGraceMs, survives }) => {
  const root = await mkdtemp(join(tmpdir(), "runner-controller-outage-"));
  const server = createServer();
  let authority: DurablePrpControlPlane | null = null;
  server.on("upgrade", (request, socket, head) => {
    if (!authority) { socket.destroy(); return; }
    authority.handleUpgrade(request, socket, "/runner", head);
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing outage test listener");
  const registration = async (next: DurablePrpControlPlane) => {
    authority = next;
    return {
      connectUrl: `ws://127.0.0.1:${address.port}/runner`,
      release: () => { if (authority === next) authority = null; },
    };
  };
  const shared = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "provider-state.json"), "--hold-first-durable-turn"],
    stateDirectory: root,
    prpIdentity: {
      runnerInstanceId: "runner-outage", environmentLeaseId: "lease-outage", runId: "run-outage",
      normalizedSessionId: "session-outage", turnId: "turn-outage", itemId: "item-outage",
    },
    // Scale the production 120-second reconnect budget down. The live process
    // must be bounded by its authenticated connection lease, independently of
    // how long a controller spends retrying a connection or booting its server.
    runnerReconnectGraceMs: 500,
    runnerProcessReconnectGraceMs: processGraceMs,
    controlPlaneRegistration: registration,
  };
  const first = createCapabilityRunnerdCodexTransport(shared);
  let adopted: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  let pid: number | null = null;
  try {
    const opened = await first.transport.request("thread/start", {
      cwd: root, dynamicTools: codexSemanticToolSpecs(),
    });
    await first.transport.request("turn/start", { input: [{ type: "text", text: "Keep this task active." }] });
    for await (const notification of first.transport.notifications()) {
      if (notification.method === "turn/started") break;
    }
    pid = first.evidence().runnerPid;
    const providerPid = first.evidence().codexPid;
    expect(pid).toEqual(expect.any(Number));
    expect(providerPid).toEqual(expect.any(Number));
    await writeFile(join(root, "saved-work.txt"), "completed work survives controller replacement");
    await first.detachControllerForRestart();
    // The deliberate fault is an offline controller, not a slow test assertion.
    await new Promise(resolveWait => setTimeout(resolveWait, 1_250));
    const runnerState = JSON.parse(await readFile(join(root, "runner", "runner-state.json"), "utf8"));
    if (!survives) {
      expect(runnerState.recoverableFailure).toBe("transport_reconnect_grace_exceeded");
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow());
      return;
    }
    expect(runnerState.recoverableFailure).not.toBe("transport_reconnect_grace_exceeded");
    expect(() => process.kill(pid!, 0)).not.toThrow();
    expect(() => process.kill(providerPid!, 0)).not.toThrow();
    const duplicateLaunch = vi.fn(() => { throw new Error("Must adopt the existing runner"); });
    const thread = opened.thread as Record<string, unknown>;
    adopted = createCapabilityRunnerdCodexTransport({
      ...shared,
      runnerReconnectGraceMs: 5_000,
      resumeDynamicTools: codexSemanticToolSpecs(),
      resumeProviderSession: { driverSessionId: String(thread.id), providerSessionId: String(thread.sessionId) },
      runnerProcessLauncher: duplicateLaunch,
      adoptExistingRunner: {
        pid: pid!, processGroupId: pid, startedAt: new Date().toISOString(),
        isAlive: () => { try { process.kill(pid!, 0); return true; } catch { return false; } },
        signal: signal => { try { process.kill(-pid!, signal); return true; } catch { return false; } },
      },
    });
    adopted.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
    const restored = await adopted.transport.request("thread/read", {});
    expect(restored.thread).toMatchObject({ id: thread.id, sessionId: thread.sessionId });
    expect(adopted.evidence()).toMatchObject({ runnerPid: pid, codexPid: providerPid, runnerExited: false });
    expect(duplicateLaunch).not.toHaveBeenCalled();
    expect(await readFile(join(root, "saved-work.txt"), "utf8")).toBe("completed work survives controller replacement");
    // A real Stop still reaches the adopted owner; the lease-only disconnect
    // policy cannot turn a detached process into an uncancellable executor.
    await adopted.transport.close();
    expect(adopted.evidence().runnerExited).toBe(true);
  } finally {
    await first.transport.close().catch(() => undefined);
    await adopted?.transport.close().catch(() => undefined);
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ } }
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
