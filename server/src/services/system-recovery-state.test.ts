import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSystemRecovery, failSystemRecovery, isDeterministicRecoveryRefusal, readSystemRecovery, reserveSystemRecoveryAttempt, SystemRecoveryFailure } from "./system-recovery-state.js";
import { exhaustedSystemRecoveryAction } from "./system-recovery.js";
import { workspaceRecoveryDisplay } from "./workspace-recovery-receipt.js";

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
  it("keeps a closed-label failure cause through serialization and drops anything else", () => {
    const state = reserveSystemRecoveryAttempt(createSystemRecovery(randomUUID()), 0)!;
    const failed = failSystemRecovery(state, new SystemRecoveryFailure("provider_unavailable", "retry_transient"),
      { now: 0, cause: { label: "sandbox_not_running", code: "ECONNRESET", status: 503 } });
    expect(readSystemRecovery(JSON.parse(JSON.stringify({ systemRecovery: failed })))?.failure)
      .toMatchObject({ code: "provider_unavailable", cause: { label: "sandbox_not_running", code: "ECONNRESET", status: 503 } });
    const unsafe = failSystemRecovery(state, new SystemRecoveryFailure("provider_unavailable", "retry_transient"),
      { now: 0, cause: { label: "/home/daytona/secret", code: null, status: null } });
    expect(unsafe.failure).not.toHaveProperty("cause");
  });
  it("never asks a person to inspect a sandbox, even for text saved by an older release", () => {
    const manual = /administrator|\bowner\b|board member|inspect the run|environment/i;
    const exhausted = failSystemRecovery(createSystemRecovery(randomUUID()),
      new SystemRecoveryFailure("allocation_ownership_ambiguous", "service_required"));
    const copyback = failSystemRecovery(createSystemRecovery(randomUUID()),
      new SystemRecoveryFailure("copyback_stop_unconfirmed", "recheck_evidence"));
    for (const state of [exhausted, { ...copyback, state: "exhausted" as const }])
      expect(exhaustedSystemRecoveryAction(state)).not.toMatch(manual);
    const runId = exhausted.sourceRunId;
    const display = workspaceRecoveryDisplay({ runId, systemRecovery: exhausted, workspaceRecovery: {
      schema: "paperclip.workspace-recovery.v1", runId, status: "blocked", stage: "verifying_stop", attempt: 1,
      attemptLimit: 6, requestIds: [], retryable: true,
      message: "Automatic recovery of saved work stopped after 1 attempts (last failure: allocation_ownership_ambiguous). "
        + "Retry recovery to export and merge from the retained sandbox again; no provider turn is submitted. "
        + "If Retry keeps failing, inspect the run and its environment." } }, runId);
    expect(display?.message).toContain("Paperclip refused to recover the saved files");
    expect(display?.message).not.toMatch(manual);
  });

  it("states a deterministic refusal plainly and never claims retries that did not happen", () => {
    const refused = failSystemRecovery(reserveSystemRecoveryAttempt(createSystemRecovery(randomUUID()), 0)!,
      new SystemRecoveryFailure("allocation_ownership_ambiguous", "service_required"), { now: 0 });
    expect(refused).toMatchObject({ state: "exhausted", attempts: 1, retriesUsed: 0 });
    expect(isDeterministicRecoveryRefusal(refused)).toBe(true);
    const text = exhaustedSystemRecoveryAction(refused);
    expect(text).toContain("Paperclip refused to recover the saved files");
    expect(text).toContain("Paperclip cannot prove which runs used the sandbox that holds the saved files (allocation_ownership_ambiguous)");
    expect(text).toContain("Retry runs the check again and succeeds only after Paperclip is updated");
    expect(text).not.toMatch(/after automatic retries|stopped after|Retry to try again/);

    const once = failSystemRecovery(reserveSystemRecoveryAttempt(createSystemRecovery(randomUUID()), 0)!,
      new SystemRecoveryFailure("historical_source_missing", "use_alternative_strategy"), { now: 0 });
    expect(isDeterministicRecoveryRefusal(once)).toBe(false);
    expect(exhaustedSystemRecoveryAction(once)).toBe("Automatic recovery of saved work failed (last failure: historical_source_missing). "
      + "Retry to try again; the agent will not repeat its work.");
    expect(exhaustedSystemRecoveryAction({ ...once, attempts: 6 })).toContain("stopped after 6 attempts");
  });

  it("promises an automatic retry for an unproven stop only while a re-arm remains", () => {
    const stop = { ...failSystemRecovery(reserveSystemRecoveryAttempt(createSystemRecovery(randomUUID()), 0)!,
      new SystemRecoveryFailure("agent_stop_unconfirmed", "recheck_evidence"), { now: 0 }), state: "exhausted" as const };
    const marker = (rearms: number) => ({ stopProofRecovery: { schema: "paperclip.stop-proof-recovery.v1", rearms, nextRearmAt: null } });
    expect(exhaustedSystemRecoveryAction(stop, {})).toMatch(/tries again automatically/);
    expect(exhaustedSystemRecoveryAction(stop, marker(3))).toMatch(/tries again automatically/);
    // Spent re-arms, or no evidence to judge them, keep the Retry text.
    expect(exhaustedSystemRecoveryAction(stop, marker(4))).toContain("Retry to try again");
    expect(exhaustedSystemRecoveryAction(stop)).toContain("Retry to try again");
  });

  it("names the last failure and its cause in the board handoff", () => {
    const state = reserveSystemRecoveryAttempt(createSystemRecovery(randomUUID()), 0)!;
    const withCause = failSystemRecovery(state, new SystemRecoveryFailure("provider_unavailable", "retry_transient"),
      { now: 0, cause: { label: "sandbox_not_running", code: null, status: null } });
    expect(exhaustedSystemRecoveryAction(withCause)).toContain("(last failure: provider_unavailable, cause: sandbox_not_running)");
    const withoutCause = failSystemRecovery(state, new SystemRecoveryFailure("archive_unsafe", "service_required"), { now: 0 });
    expect(exhaustedSystemRecoveryAction(withoutCause)).toContain("(archive_unsafe)");
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
  it("persists only allowlisted source-verification evidence without changing the failure budget", () => {
    const state = createSystemRecovery(randomUUID());
    const failure = new SystemRecoveryFailure("source_binding_invalid", "service_required", undefined,
      { reason: "lease_policy_not_retained", observedLeasePolicy: "reuse_by_environment", token: "secret" } as never);
    const result = failSystemRecovery(state, failure, { now: 1_000 });
    expect(readSystemRecovery({ systemRecovery: result })?.failure?.sourceVerification).toEqual({
      reason: "lease_policy_not_retained", observedLeasePolicy: "reuse_by_environment" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result).toMatchObject({ state: "exhausted", attempts: 0, nextAttemptAt: null, intentId: state.intentId });
    const invalid = failSystemRecovery(state, new SystemRecoveryFailure("source_binding_invalid", "service_required", undefined,
      { reason: "arbitrary secret", observedLeasePolicy: "private policy" } as never));
    expect(invalid.failure?.sourceVerification).toBeUndefined();
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
