import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSystemRecovery, failSystemRecovery, readSystemRecovery, reserveSystemRecoveryAttempt, SystemRecoveryFailure } from "./system-recovery-state.js";

describe("durable system recovery budget", () => {
  it("makes six attempts with exponential delays that survive serialization and exhaustion", () => {
    let state = createSystemRecovery(randomUUID());
    let now = 1_000;
    for (let attempt = 0; attempt < 6; attempt++) {
      state = reserveSystemRecoveryAttempt(state, now)!;
      expect(state.attempts).toBe(attempt + 1);
      state = failSystemRecovery(state, new SystemRecoveryFailure("export_interrupted", "retry_transient"), { now });
      state = readSystemRecovery(JSON.parse(JSON.stringify({ systemRecovery: state })))!;
      if (attempt < 5) {
        const base = 30_000 * 2 ** attempt;
        expect(state.nextAttemptAt! - now).toBeGreaterThanOrEqual(base * 0.8);
        expect(state.nextAttemptAt! - now).toBeLessThanOrEqual(base * 1.2);
        expect(reserveSystemRecoveryAttempt(state, state.nextAttemptAt! - 1)).toBeNull();
        now = state.nextAttemptAt!;
      }
    }
    expect(state.state).toBe("exhausted");
    expect(state.retriesUsed).toBe(5);
    expect(reserveSystemRecoveryAttempt(state, now + 1_000_000)).toBeNull();
  });
  it("never retries ahead of a provider cooldown or after the generation deadline", () => {
    const state = reserveSystemRecoveryAttempt(createSystemRecovery(randomUUID()), 0)!;
    const later = failSystemRecovery(state, new SystemRecoveryFailure("provider_unavailable", "retry_transient"),
      { now: 0, retryAfterAt: 120_000 });
    expect(later.nextAttemptAt).toBe(120_000);
    expect(reserveSystemRecoveryAttempt(later, 30 * 60_000)).toBeNull();
    expect(failSystemRecovery(state, new SystemRecoveryFailure("provider_unavailable", "retry_transient"),
      { now: 0, retryAfterAt: 31 * 60_000 }).state).toBe("exhausted");
  });
  it("reconciles a recorded attempt after restart without spending another retry", () => {
    const running = reserveSystemRecoveryAttempt(createSystemRecovery(randomUUID()), 0)!;
    const restarted = readSystemRecovery(JSON.parse(JSON.stringify({ systemRecovery: running })))!;
    expect(reserveSystemRecoveryAttempt(restarted, 60_000)).toMatchObject({
      attemptId: running.attemptId, attempts: 1, retriesUsed: 0,
    });
  });
  it("keeps an invalid ownership binding out of the physical retry loop", () => {
    const state = failSystemRecovery(createSystemRecovery(randomUUID()),
      new SystemRecoveryFailure("source_binding_invalid", "service_required"));
    expect(state).toMatchObject({ state: "exhausted", nextAttemptAt: null,
      failure: { code: "source_binding_invalid", retryClass: "service_required" } });
  });
  it("reads prior incident metadata without losing the local recovery budget or failure", () => {
    const state = failSystemRecovery(createSystemRecovery(randomUUID()),
      new SystemRecoveryFailure("source_unavailable", "service_required"), { now: 1_000 });
    const restored = readSystemRecovery({ systemRecovery: { ...state,
      incident: { status: "pending", id: null, attempts: 2, nextDeliveryAt: 60_000 },
    }, recoveryIncidentDelivery: { attempts: 2, nextAttemptAt: 60_000 } });
    expect(restored).toEqual(state);
    expect(reserveSystemRecoveryAttempt(restored!, 61_000)).toBeNull();
  });

});
