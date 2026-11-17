import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A warm runner outlives its turn. When its controller dies without
// suspending it (SIGKILL, crash), nothing else owns the idle process. The
// process grace bounds it: runnerd proves no controller re-authenticated,
// stops its provider, keeps durable state, and exits. Without a grace it lives
// until its connection lease (one hour for local runners).
it.each([
  { policy: "a process grace", processGraceMs: 500, exits: true },
  // null: no process grace, as a per-turn local runner launches today.
  { policy: "no process grace", processGraceMs: null, exits: false },
])("bounds an idle warm runner whose controller vanished with $policy", async ({ processGraceMs, exits }) => {
  const root = await mkdtemp(join(tmpdir(), "runner-warm-idle-orphan-"));
  const server = createServer();
  let authority: DurablePrpControlPlane | null = null;
  server.on("upgrade", (request, socket, head) => {
    if (!authority) { socket.destroy(); return; }
    authority.handleUpgrade(request, socket, "/runner", head);
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing orphan test listener");
  const identity = {
    runnerInstanceId: "runner-warm-orphan", environmentLeaseId: "lease-warm-orphan", runId: "run-warm-orphan",
    normalizedSessionId: "session-warm-orphan", turnId: "turn-warm-orphan", itemId: "item-warm-orphan",
  };
  const shared = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(root),
    stateDirectory: root,
    prpIdentity: identity,
    lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
    runnerReconnectGraceMs: 500,
    runnerProcessReconnectGraceMs: processGraceMs,
    controlPlaneRegistration: async (next: DurablePrpControlPlane) => {
      authority = next;
      return {
        connectUrl: `ws://127.0.0.1:${address.port}/runner`,
        release: () => { if (authority === next) authority = null; },
      };
    },
  };
  const first = createCapabilityRunnerdCodexTransport(shared);
  first.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  let resumed: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  let pid: number | null = null;
  try {
    const opened = await first.transport.request("thread/start", { cwd: root, dynamicTools: [] });
    const notifications = first.transport.notifications()[Symbol.asyncIterator]();
    await first.transport.request("turn/start", { input: [{ type: "text", text: "Finish, then stay warm." }] });
    for (;;) if ((await notifications.next()).value?.method === "turn/completed") break;
    pid = first.evidence().runnerPid;
    expect(pid).toEqual(expect.any(Number));
    // The controller disappears without suspending its idle warm runner.
    await first.detachControllerForRestart();
    if (!exits) {
      await new Promise(resolveWait => setTimeout(resolveWait, 1_500));
      expect(alive(pid!)).toBe(true);
      return;
    }
    await vi.waitFor(() => expect(alive(pid!)).toBe(false), { timeout: 10_000 });
    const runnerState = JSON.parse(await readFile(join(root, "runner", "runner-state.json"), "utf8"));
    expect(runnerState.recoverableFailure).toBe("transport_reconnect_grace_exceeded");
    // Durable state survives: the next run resumes the same provider session cold.
    const thread = opened.thread as { id: string; sessionId: string };
    resumed = createCapabilityRunnerdCodexTransport({
      ...shared,
      resumeProviderSession: { driverSessionId: thread.id, providerSessionId: thread.sessionId },
    });
    const restored = await resumed.transport.request("thread/read", {});
    expect(restored.thread).toMatchObject({ id: thread.id, sessionId: thread.sessionId });
  } finally {
    await first.transport.close().catch(() => undefined);
    await resumed?.transport.close().catch(() => undefined);
    if (pid && alive(pid)) { try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ } }
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
