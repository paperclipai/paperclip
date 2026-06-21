/**
 * Unit tests for runRecoveryLoop.
 * Uses hand-mocked step object — plain vitest/node, no workerd required.
 *
 * Design note on step.waitForEvent + Promise.race:
 * Cloudflare Workflows replays steps deterministically. Racing a durable sleep
 * against a durable waitForEvent is unreliable during replay because step names
 * would change order. We use a simple sleep loop instead (no race). The loop
 * self-exits when active:false is returned from the attempt response.
 */
import { describe, it, expect, vi } from "vitest";
import type { InternalClient } from "../internal-client.ts";
import { runRecoveryLoop } from "../loop.ts";

// ---------------------------------------------------------------------------
// Hand-mock helpers
// ---------------------------------------------------------------------------

function makeStep() {
  const sleptNames: string[] = [];
  const sleptDurations: number[] = [];
  const stepDoNames: string[] = [];

  const step = {
    do: vi.fn(
      async (
        name: string,
        cfgOrCb: unknown,
        cb?: () => Promise<unknown>
      ): Promise<unknown> => {
        stepDoNames.push(name);
        const fn = typeof cfgOrCb === "function" ? cfgOrCb : cb!;
        return fn();
      }
    ),
    sleep: vi.fn(async (name: string, durationMs: number) => {
      sleptNames.push(name);
      sleptDurations.push(durationMs);
    }),
    _sleptNames: sleptNames,
    _sleptDurations: sleptDurations,
    _stepDoNames: stepDoNames,
  };

  return step;
}

function makePayload() {
  return {
    companyId: "co_1",
    actionId: "act_1",
    sourceIssueId: "iss_1",
    mode: "shadow" as const,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runRecoveryLoop", () => {
  it("calls attempt with incrementing attemptNumber and exits on active:false", async () => {
    const step = makeStep();

    // Returns active:true for 2 attempts, then active:false
    const mockAttempt = vi.fn()
      .mockResolvedValueOnce({ active: true, status: "pending", attemptCount: 1, nextIntervalMs: 100 })
      .mockResolvedValueOnce({ active: true, status: "pending", attemptCount: 2, nextIntervalMs: 200 })
      .mockResolvedValueOnce({ active: false, status: "resolved", attemptCount: 3, nextIntervalMs: 0 });

    const client: Pick<InternalClient, "attempt"> = {
      attempt: mockAttempt,
    };

    await runRecoveryLoop({ payload: makePayload(), step: step as never, client: client as InternalClient });

    // Should have been called 3 times (N+1 — 2 active + 1 final inactive)
    expect(mockAttempt).toHaveBeenCalledTimes(3);

    // First call: attemptNumber 1
    expect(mockAttempt.mock.calls[0][0]).toMatchObject({
      companyId: "co_1",
      actionId: "act_1",
      sourceIssueId: "iss_1",
      attemptNumber: 1,
      mode: "shadow",
    });

    // Second call: attemptNumber 2
    expect(mockAttempt.mock.calls[1][0]).toMatchObject({ attemptNumber: 2 });

    // Third call: attemptNumber 3
    expect(mockAttempt.mock.calls[2][0]).toMatchObject({ attemptNumber: 3 });
  });

  it("sleeps between attempts using nextIntervalMs from the response", async () => {
    const step = makeStep();

    const mockAttempt = vi.fn()
      .mockResolvedValueOnce({ active: true, status: "pending", attemptCount: 1, nextIntervalMs: 1234 })
      .mockResolvedValueOnce({ active: false, status: "resolved", attemptCount: 2, nextIntervalMs: 0 });

    const client: Pick<InternalClient, "attempt"> = { attempt: mockAttempt };

    await runRecoveryLoop({ payload: makePayload(), step: step as never, client: client as InternalClient });

    // Should sleep once (after first active:true), not after active:false
    expect(step.sleep).toHaveBeenCalledTimes(1);
    expect(step.sleep).toHaveBeenCalledWith("wait-1", 1234);
  });

  it("clamps sleep to >=1000ms when server returns nextIntervalMs:0 with active:true (tight-spin guard)", async () => {
    const step = makeStep();

    // First response: active:true but nextIntervalMs:0 (malformed/bug) -> must clamp.
    // Second response: active:false -> loop exits.
    const mockAttempt = vi.fn()
      .mockResolvedValueOnce({ active: true, status: "pending", attemptCount: 1, nextIntervalMs: 0 })
      .mockResolvedValueOnce({ active: false, status: "resolved", attemptCount: 2, nextIntervalMs: 0 });

    const client: Pick<InternalClient, "attempt"> = { attempt: mockAttempt };

    await runRecoveryLoop({ payload: makePayload(), step: step as never, client: client as InternalClient });

    // Exactly one sleep (after the active:true response), clamped to the floor.
    expect(step.sleep).toHaveBeenCalledTimes(1);
    expect(step._sleptDurations[0]).toBeGreaterThanOrEqual(1000);
    expect(step.sleep).toHaveBeenCalledWith("wait-1", 1000);

    // Loop still exits on the subsequent active:false attempt.
    expect(mockAttempt).toHaveBeenCalledTimes(2);
  });

  it("clamps the inter-attempt sleep to a floor when the server returns nextIntervalMs:0 with active:true", async () => {
    const step = makeStep();

    // active:true but nextIntervalMs:0 (malformed/bug) — would tight-spin without a floor
    const mockAttempt = vi.fn()
      .mockResolvedValueOnce({ active: true, status: "pending", attemptCount: 1, nextIntervalMs: 0 })
      .mockResolvedValueOnce({ active: false, status: "resolved", attemptCount: 2, nextIntervalMs: 0 });

    const client: Pick<InternalClient, "attempt"> = { attempt: mockAttempt };

    await runRecoveryLoop({ payload: makePayload(), step: step as never, client: client as InternalClient });

    // Slept once, clamped to >= 1000ms (not 0)
    expect(step.sleep).toHaveBeenCalledTimes(1);
    const sleptDuration = step.sleep.mock.calls[0][1] as number;
    expect(sleptDuration).toBeGreaterThanOrEqual(1000);
    // And still exits on the subsequent active:false
    expect(mockAttempt).toHaveBeenCalledTimes(2);
  });

  it("does NOT sleep after the final active:false response", async () => {
    const step = makeStep();

    const mockAttempt = vi.fn()
      .mockResolvedValueOnce({ active: false, status: "resolved", attemptCount: 1, nextIntervalMs: 0 });

    const client: Pick<InternalClient, "attempt"> = { attempt: mockAttempt };

    await runRecoveryLoop({ payload: makePayload(), step: step as never, client: client as InternalClient });

    expect(mockAttempt).toHaveBeenCalledTimes(1);
    expect(step.sleep).not.toHaveBeenCalled();
  });

  it("uses idempotent step names (attempt-N, wait-N)", async () => {
    const step = makeStep();

    const mockAttempt = vi.fn()
      .mockResolvedValueOnce({ active: true, status: "pending", attemptCount: 1, nextIntervalMs: 50 })
      .mockResolvedValueOnce({ active: false, status: "resolved", attemptCount: 2, nextIntervalMs: 0 });

    const client: Pick<InternalClient, "attempt"> = { attempt: mockAttempt };

    await runRecoveryLoop({ payload: makePayload(), step: step as never, client: client as InternalClient });

    expect(step._stepDoNames).toEqual(["attempt-1", "attempt-2"]);
    expect(step._sleptNames).toEqual(["wait-1"]);
  });

  it("passes retry config to step.do", async () => {
    const step = makeStep();

    const mockAttempt = vi.fn()
      .mockResolvedValueOnce({ active: false, status: "resolved", attemptCount: 1, nextIntervalMs: 0 });

    const client: Pick<InternalClient, "attempt"> = { attempt: mockAttempt };

    await runRecoveryLoop({ payload: makePayload(), step: step as never, client: client as InternalClient });

    // step.do should be called with a config object as the second argument (not a function directly)
    const [, secondArg] = step.do.mock.calls[0] as [string, unknown, unknown];
    // When retry config is passed, second arg is the config object
    expect(typeof secondArg).toBe("object");
    expect(secondArg).toHaveProperty("retries");
  });

  it("handles mode:active correctly", async () => {
    const step = makeStep();

    const mockAttempt = vi.fn()
      .mockResolvedValueOnce({ active: false, status: "resolved", attemptCount: 1, nextIntervalMs: 0 });

    const client: Pick<InternalClient, "attempt"> = { attempt: mockAttempt };

    const activePayload = { ...makePayload(), mode: "active" as const };
    await runRecoveryLoop({ payload: activePayload, step: step as never, client: client as InternalClient });

    expect(mockAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "active" })
    );
  });

  it("exits immediately on first active:false without additional attempts", async () => {
    const step = makeStep();

    const mockAttempt = vi.fn()
      .mockResolvedValueOnce({ active: false, status: "escalated", attemptCount: 1, nextIntervalMs: 0 });

    const client: Pick<InternalClient, "attempt"> = { attempt: mockAttempt };

    await runRecoveryLoop({ payload: makePayload(), step: step as never, client: client as InternalClient });

    // Exactly one attempt, zero sleeps
    expect(mockAttempt).toHaveBeenCalledTimes(1);
    expect(step.sleep).toHaveBeenCalledTimes(0);
  });
});
