import { describe, expect, it } from "vitest";
import { readHeartbeatRunErrorFamily } from "./heartbeat.js";

type RunLike = Parameters<typeof readHeartbeatRunErrorFamily>[0];
const run = (errorCode: string | null, resultJson: unknown = null) =>
  ({ errorCode, resultJson } as RunLike);

// Only a run whose family resolves to transient_upstream or provider_quota gets
// the bounded 10m/30m/2h retry ladder. A wedged harness used to resolve to null
// here, which is why a hung run sat blocked until someone retried it by hand.
describe("readHeartbeatRunErrorFamily", () => {
  it("treats a wedged harness as transient so it earns a bounded retry", () => {
    for (const code of [
      "timeout",
      "codex_output_inactivity_monitor",
      "opencode_output_inactivity_monitor",
      "codex_transient_upstream",
      "claude_transient_upstream",
      "codex_harness_crash",
    ]) {
      expect(readHeartbeatRunErrorFamily(run(code))).toBe("transient_upstream");
    }
  });

  it("keeps provider quota its own family", () => {
    expect(readHeartbeatRunErrorFamily(run("provider_quota"))).toBe("provider_quota");
  });

  it("does not make an ordinary or configuration failure retryable", () => {
    expect(readHeartbeatRunErrorFamily(run("adapter_failed"))).toBeNull();
    expect(readHeartbeatRunErrorFamily(run("configuration_incomplete"))).toBeNull();
    expect(readHeartbeatRunErrorFamily(run(null))).toBeNull();
  });

  it("lets an adapter-persisted family win", () => {
    expect(readHeartbeatRunErrorFamily(run("adapter_failed", { errorFamily: "provider_quota" })))
      .toBe("provider_quota");
  });
});
