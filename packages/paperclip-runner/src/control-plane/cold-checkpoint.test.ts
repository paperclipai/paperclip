import { describe, expect, it } from "vitest";
import { assertColdCheckpointRunnerState, coldCheckpointStateDigest } from "./cold-checkpoint.js";

const identity = { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
  normalizedSessionId: "session", turnId: "turn", itemId: "item" };
const state = { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "ready", outbox: [],
  pendingTerminalDelivery: null, pendingProviderCleanup: null, warmTransition: null };
const checkpoint = { schema: "paperclip.runner.cold-checkpoint.v1" as const, sourceId: "source", sha256: `sha256:${"a".repeat(64)}`,
  runnerStateSha256: coldCheckpointStateDigest(state), identity, providerSessionId: "native-thread" };

describe("immutable cold checkpoint admission", () => {
  it("matches the execution provider canonical digest for numeric keys, Unicode, and signed zero", () => {
    const fixture = { "10": "ten", "2": "two", unicode: "<>&\u2028\u2029", "😀": true, "\uE000": false,
      n: -0, small: 1e-7, large: 1e21 };
    expect(coldCheckpointStateDigest(fixture)).toBe("sha256:4192476c095207c3d18928f065a831b5303b4fd670911977235b9354eff33779");
  });
  it("admits the captured ready source without changing its lifecycle", () => {
    expect(() => assertColdCheckpointRunnerState(state, identity, checkpoint)).not.toThrow();
    expect(state.lifecycle).toBe("ready");
    expect(coldCheckpointStateDigest(Object.fromEntries(Object.entries(state).reverse()))).toBe(checkpoint.runnerStateSha256);
  });
  it.each(["bytes", "identity", "active", "outbox", "cleanup", "transition", "receipt"])("rejects changed or unsettled state: %s", mode => {
    const value = { ...state, ...(mode === "bytes" ? { diagnostics: ["changed"] } : {}),
      ...(mode === "identity" ? { runId: "another-run" } : {}), ...(mode === "active" ? { lifecycle: "active" } : {}),
      ...(mode === "outbox" ? { outbox: [{}] } : {}), ...(mode === "cleanup" ? { pendingProviderCleanup: {} } : {}),
      ...(mode === "transition" ? { warmTransition: {} } : {}) };
    // Even a matching digest cannot bless unfinished work.
    const proof = { ...checkpoint, runnerStateSha256: mode === "bytes" ? checkpoint.runnerStateSha256 : coldCheckpointStateDigest(value),
      ...(mode === "receipt" ? { identity: { ...identity, turnId: "another-turn" } } : {}) };
    expect(() => assertColdCheckpointRunnerState(value, identity, proof)).toThrow("cold_checkpoint_integrity_mismatch");
  });
});
