import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DurableRecoveryCommittedEvent, DurableRecoveryIdentity } from "../contracts/durable-recovery.js";
import type { CodexSessionState } from "../drivers/codex/codex-session-state.js";
import type { HarnessRuntimeRequest } from "../contracts/harness-driver.js";

// Replace only the PRP peer and process boundary. The production transport,
// event pump, registered handler, and request emission below all run unchanged.
const peer = vi.hoisted(() => ({ current: null as TestPeer | null }));
interface TestPeer {
  store: { state: { identity: DurableRecoveryIdentity; committedEvents: DurableRecoveryCommittedEvent[]; commands: Array<Record<string, unknown>> } };
  emit(type: string, payload: Record<string, unknown>): void;
}
vi.mock("../control-plane/durable-prp-control-plane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../control-plane/durable-prp-control-plane.js")>();
  return {
    ...actual,
    spawnRunner: vi.fn(() => ({ child: { exitCode: null }, completion: new Promise(() => {}) })),
    DurablePrpControlPlane: class implements TestPeer {
      store: TestPeer["store"];
      connectUrl = "ws://fixture.invalid";
      constructor(options: { identity: DurableRecoveryIdentity }) {
        this.store = { state: { identity: options.identity, committedEvents: [], commands: [] } };
        peer.current = this;
      }
      async start() {}
      async stop() {}
      disconnectActiveRunner() {}
      persistRunAttachTemplate() {}
      issueBootstrapTicket() { return {}; }
      getCommand(id: string) { return this.store.state.commands.find(c => c.commandId === id); }
      queueCommand(type: string, payload: Record<string, unknown>, id = type) {
        this.store.state.commands.push({ type, commandId: id, status: "completed", result: { result: { providerTurnId: payload.turnId } } });
        if (type === "session.open") this.emit("session.started", {
          threadId: "thread-1", sessionId: "provider-session-1",
          runtimeIdentity: { executionKind: "remote_service" },
        });
        if (type === "turn.start") this.emit("turn.started", { providerTurnId: payload.turnId });
      }
      emit(eventType: string, payload: Record<string, unknown>) {
        const sourceSeq = this.store.state.committedEvents.length + 1;
        this.store.state.committedEvents.push({
          eventType, sourceSeq, sourceEventId: `fixture:${sourceSeq}`,
          priority: 0, deliveryCount: 1, logicalEffectCount: 1,
          envelope: { turnId: this.store.state.identity.turnId, payload: { payload } },
        });
      }
    },
  };
});
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { handleServerRequest } from "../drivers/codex/codex-session-server-requests.js";

describe("permission events through the actual transport handler", () => {
  it.each([
    { name: "native ID distinct from opaque item", details: { toolCallId: "native-edit-7" }, expected: "native-edit-7" },
    { name: "absent native ID", details: {}, expected: undefined },
    { name: "malformed native ID", details: { toolCallId: { forged: "opaque-item-7" } }, expected: undefined },
  ])("emits retained control-plane details for $name", async ({ details, expected }) => {
    const root = mkdtempSync(join(tmpdir(), "permission-forwarding-"));
    const binary = join(root, "unexecuted-runner");
    writeFileSync(binary, "not executable: process boundary is mocked");
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: binary, stateDirectory: root,
      sourceCodexHome: join(root, "absent-source-home"),
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
    });
    const emitted: HarnessRuntimeRequest[] = [];
    const pending = new Map();
    const state = {
      sourceSequence: 0, runnerInstanceId: "fixture-runner", runId: "fixture-run",
      opened: { threadId: "thread-1" }, activeTurnId: "", terminal: false, protocolFailed: false,
      pendingRuntimeRequestMap: pending, transport: bundle.transport,
      failProtocol: vi.fn((code: string) => { throw new Error(code); }),
      emit(type: string, payload: { request?: HarnessRuntimeRequest }) {
        this.sourceSequence++;
        if (type === "runtime_request.created") {
          emitted.push(structuredClone(payload.request!));
          writeFileSync(join(root, "emitted-requests.json"), JSON.stringify(emitted));
        }
      },
    };
    const handled = vi.fn(request => handleServerRequest(state as unknown as CodexSessionState, request));
    bundle.transport.setServerRequestHandler(handled);
    try {
      await bundle.transport.request("initialize", {});
      await bundle.transport.request("thread/start", { cwd: root });
      const start = await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Fixture" }] });
      state.activeTurnId = (start.turn as { id: string }).id;
      peer.current!.emit("runtime_request.created", { request: {
        requestId: "permission-7", type: "permission", requestKind: "permission_approval",
        itemId: "opaque-item-7", prompt: "Change file: result.txt", details,
        choices: [{ key: "decline", label: "Deny" }],
        origin: { adapter: "acpx-runtime-sidecar", provider: "copilot", method: "session/request_permission" },
      } });
      await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: 1_000, interval: 5 });
      expect(handled).toHaveBeenCalledTimes(1);
      const retained = JSON.parse(readFileSync(join(root, "emitted-requests.json"), "utf8"))[0];
      expect(retained).toMatchObject({ requestId: "permission-7", itemId: "opaque-item-7", requestKind: "permission_approval", turnId: state.activeTurnId });
      if (expected === undefined) expect(retained.details).not.toHaveProperty("toolCallId");
      else expect(retained.details.toolCallId).toBe(expected);
      expect(retained.details.choices).toEqual([{ key: "decline", label: "Deny" }]);
      expect(state.failProtocol).not.toHaveBeenCalled();
    } finally {
      for (const entry of pending.values()) entry.settle({ outcome: "cancel" });
      await bundle.detachControllerForRestart();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
