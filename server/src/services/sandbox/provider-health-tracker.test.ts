/**
 * LET-369 Layer 5 unit tests — the cross-lease provider health tracker
 * (degraded on consecutive failures, immediate degraded on 401 auth,
 * disabled + Andrii page on redaction-boundary violation).
 *
 * Integration coverage (provider wired with billing-cap + operator-toggle)
 * lives in `server/src/__tests__/sandbox-kill-switch-layers.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { SandboxProviderError } from "./provider-contract.js";
import {
  ProviderHealthTracker,
  type ProviderHealthPageEvent,
  type ProviderHealthTransitionEvent,
} from "./provider-health-tracker.js";

function authFailure(): SandboxProviderError {
  return new SandboxProviderError(
    "CONFIG_INVALID",
    "fake transport rejected authentication",
    { details: { status: 401, vendorCode: "auth_failed" } },
  );
}

function genericFailure(): SandboxProviderError {
  return new SandboxProviderError("PROVIDER_FAILURE", "fake transport rate-limited", {
    details: { status: 429 },
    retryable: true,
  });
}

describe("LET-369 Layer 5 — ProviderHealthTracker", () => {
  it("starts in healthy state and reports a clean snapshot", () => {
    const tracker = new ProviderHealthTracker();
    const snap = tracker.snapshot();
    expect(snap.state).toBe("healthy");
    expect(snap.consecutiveFailures).toBe(0);
    expect(tracker.isFailClosed()).toBe(false);
  });

  it("trips to degraded after 5 consecutive failures within the rolling window", async () => {
    const transitions: ProviderHealthTransitionEvent[] = [];
    const tracker = new ProviderHealthTracker({
      onTransition: (e) => {
        transitions.push(e);
      },
    });
    for (let i = 0; i < 4; i++) {
      await tracker.recordFailure(genericFailure());
      expect(tracker.snapshot().state).toBe("healthy");
    }
    await tracker.recordFailure(genericFailure());
    expect(tracker.snapshot().state).toBe("degraded");
    expect(tracker.snapshot().consecutiveFailures).toBe(5);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from).toBe("healthy");
    expect(transitions[0].to).toBe("degraded");
    expect(transitions[0].reason).toMatch(/consecutive_failures_5/);
  });

  it("subsequent acquireLease throws PROVIDER_DISABLED with healthState=degraded until cleared", async () => {
    const tracker = new ProviderHealthTracker();
    for (let i = 0; i < 5; i++) await tracker.recordFailure(genericFailure());
    expect(() => tracker.assertHealthy("e2b")).toThrowError(SandboxProviderError);
    try {
      tracker.assertHealthy("e2b");
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxProviderError);
      const e = err as SandboxProviderError;
      expect(e.code).toBe("PROVIDER_DISABLED");
      expect(e.details?.healthState).toBe("degraded");
      expect(e.details?.layer).toBe("lease-state-machine");
    }
    await tracker.clear("operator: investigated transient outage");
    expect(tracker.snapshot().state).toBe("healthy");
    expect(() => tracker.assertHealthy("e2b")).not.toThrow();
  });

  it("trips to degraded immediately on a 401 auth failure", async () => {
    const tracker = new ProviderHealthTracker();
    await tracker.recordFailure(authFailure());
    const snap = tracker.snapshot();
    expect(snap.state).toBe("degraded");
    expect(snap.reason).toMatch(/auth_failure_status_401/);
  });

  it("records timestamps but does not double-transition once already tripped", async () => {
    const transitions: ProviderHealthTransitionEvent[] = [];
    const tracker = new ProviderHealthTracker({
      onTransition: (e) => {
        transitions.push(e);
      },
    });
    await tracker.recordFailure(authFailure());
    expect(transitions).toHaveLength(1);
    for (let i = 0; i < 10; i++) await tracker.recordFailure(genericFailure());
    expect(transitions).toHaveLength(1);
  });

  it("expires out-of-window failures so a slow drip never trips the threshold", async () => {
    let nowMs = Date.UTC(2026, 4, 17, 0, 0, 0);
    const tracker = new ProviderHealthTracker({
      windowMs: 10 * 60 * 1000,
      now: () => new Date(nowMs),
    });
    // 4 failures spaced 3 minutes apart — well within the window.
    for (let i = 0; i < 4; i++) {
      await tracker.recordFailure(genericFailure());
      nowMs += 3 * 60 * 1000;
    }
    // Now advance 30 minutes past the last failure. The 5th failure should
    // expire the earlier ones out of the window, so the count drops to 1.
    nowMs += 30 * 60 * 1000;
    await tracker.recordFailure(genericFailure());
    expect(tracker.snapshot().state).toBe("healthy");
    expect(tracker.snapshot().consecutiveFailures).toBe(1);
  });

  it("recordSuccess resets the failure window but does not clear a trip", async () => {
    const tracker = new ProviderHealthTracker();
    await tracker.recordFailure(genericFailure());
    await tracker.recordFailure(genericFailure());
    tracker.recordSuccess();
    expect(tracker.snapshot().consecutiveFailures).toBe(0);
    expect(tracker.snapshot().state).toBe("healthy");

    // Trip then assert clear is required.
    for (let i = 0; i < 5; i++) await tracker.recordFailure(genericFailure());
    expect(tracker.snapshot().state).toBe("degraded");
    tracker.recordSuccess();
    expect(tracker.snapshot().state).toBe("degraded"); // a success does NOT clear
  });

  it("redaction-boundary violation transitions to disabled and pages Andrii", async () => {
    const pages: ProviderHealthPageEvent[] = [];
    const tracker = new ProviderHealthTracker({
      onAndriiPage: (e) => {
        pages.push(e);
      },
    });
    await tracker.reportRedactionViolation({
      boundary: "before-provider",
      payloadKind: "exec_command_body",
      redactedSampleLength: 36,
    });
    const snap = tracker.snapshot();
    expect(snap.state).toBe("disabled");
    expect(snap.reason).toMatch(/redaction_boundary_violation_before-provider/);
    expect(pages).toHaveLength(1);
    expect(pages[0].details).toMatchObject({
      layer: "lease-state-machine",
      severity: "page-andrii",
      payloadKind: "exec_command_body",
    });
  });

  it("a disabled provider fails closed until explicit operator clear", async () => {
    const tracker = new ProviderHealthTracker();
    await tracker.reportRedactionViolation({ payloadKind: "exec_args" });
    try {
      tracker.assertHealthy("e2b");
      throw new Error("unreachable");
    } catch (err) {
      const e = err as SandboxProviderError;
      expect(e.code).toBe("PROVIDER_DISABLED");
      expect(e.details?.healthState).toBe("disabled");
    }
    // Repeated redaction violations do not duplicate the transition record.
    const transitions: ProviderHealthTransitionEvent[] = [];
    (tracker as unknown as { onTransition: typeof transitions[0] | undefined }).onTransition =
      ((e: ProviderHealthTransitionEvent) => transitions.push(e)) as never;
    await tracker.reportRedactionViolation({ payloadKind: "exec_env_value" });
    expect(transitions).toHaveLength(0);

    await tracker.clear("operator: incident I-99 acknowledged, root cause fixed");
    expect(tracker.snapshot().state).toBe("healthy");
  });

  it("integrates with onAndriiPage hook without breaking when the hook throws", async () => {
    const tracker = new ProviderHealthTracker({
      onAndriiPage: vi.fn(async () => {
        throw new Error("pager unreachable");
      }),
    });
    // The current contract surfaces the hook error to the caller — that is
    // intentional so the integration layer can decide how to surface a page
    // failure (the redaction violation itself is still recorded first).
    await expect(
      tracker.reportRedactionViolation({ payloadKind: "exec_command_body" }),
    ).rejects.toThrow(/pager unreachable/);
    expect(tracker.snapshot().state).toBe("disabled");
  });
});
