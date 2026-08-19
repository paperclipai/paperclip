/**
 * Backfill decision coverage for PAP-17158.
 *
 * `decideManagedRuntimeExposureBackfill` is the whole contract for which
 * pre-feature workspaces get upgraded to HTTPS in place and which are left
 * alone, so each branch is asserted by its reason code rather than only by the
 * resulting action.
 */
import { describe, expect, it } from "vitest";

import {
  decideManagedRuntimeExposureBackfill,
  decideStaleExposureReclaim,
} from "./workspace-runtime.js";

/** A persisted, running, pre-feature Paperclip App dev runtime. */
function httpOnlyRunningRow(overrides: Partial<Parameters<typeof decideManagedRuntimeExposureBackfill>[0]> = {}) {
  return {
    mode: "auto" as const,
    brokerAvailable: true,
    provider: "local_process",
    serviceName: "paperclip-dev",
    command: "pnpm dev --bind lan",
    status: "running",
    hasExposure: false,
    declaredIntent: "unset" as const,
    ...overrides,
  };
}

describe("decideManagedRuntimeExposureBackfill", () => {
  it("reprovisions a running HTTP-only managed worktree runtime", () => {
    expect(decideManagedRuntimeExposureBackfill(httpOnlyRunningRow())).toEqual({
      action: "reprovision",
      reason: "http_only_managed_service",
    });
  });

  it("reprovisions a service that is mid-start as well as one already running", () => {
    for (const status of ["provisioning", "starting", "running"]) {
      expect(decideManagedRuntimeExposureBackfill(httpOnlyRunningRow({ status })).action).toBe("reprovision");
    }
  });

  it("leaves a stopped service to pick the default up on its next start", () => {
    expect(decideManagedRuntimeExposureBackfill(httpOnlyRunningRow({ status: "stopped" }))).toEqual({
      action: "keep",
      reason: "stopped_defaults_on_next_start",
    });
  });

  it("preserves a deliberate opt-out", () => {
    expect(decideManagedRuntimeExposureBackfill(httpOnlyRunningRow({ declaredIntent: "disabled" }))).toEqual({
      action: "keep",
      reason: "deliberate_opt_out",
    });
  });

  it("is idempotent: a row that already carries exposure state is never re-driven", () => {
    expect(decideManagedRuntimeExposureBackfill(httpOnlyRunningRow({ hasExposure: true }))).toEqual({
      action: "keep",
      reason: "already_exposed",
    });
    // Repeated deploys see the same row and must keep converging on "keep".
    expect(decideManagedRuntimeExposureBackfill(httpOnlyRunningRow({ hasExposure: true })).action).toBe("keep");
  });

  it("leaves unmanaged and custom services alone", () => {
    expect(decideManagedRuntimeExposureBackfill(httpOnlyRunningRow({
      serviceName: "preview",
      command: "pnpm vite",
    }))).toEqual({ action: "keep", reason: "unmanaged_or_custom_service" });
  });

  it("leaves external (non local_process) runtime services alone", () => {
    expect(decideManagedRuntimeExposureBackfill(httpOnlyRunningRow({ provider: "external" }))).toEqual({
      action: "keep",
      reason: "not_a_managed_local_process",
    });
  });

  it("does nothing when the automatic default is switched off", () => {
    expect(decideManagedRuntimeExposureBackfill(httpOnlyRunningRow({ mode: "off" }))).toEqual({
      action: "keep",
      reason: "https_default_disabled",
    });
  });

  it("skips the backfill when the host broker is unavailable, unless forced", () => {
    expect(decideManagedRuntimeExposureBackfill(httpOnlyRunningRow({ brokerAvailable: false }))).toEqual({
      action: "keep",
      reason: "broker_unavailable",
    });
    expect(
      decideManagedRuntimeExposureBackfill(httpOnlyRunningRow({ brokerAvailable: false, mode: "force" })).action,
    ).toBe("reprovision");
  });

  it("never takes down a row it cannot restart from a configured entry", () => {
    expect(decideManagedRuntimeExposureBackfill(httpOnlyRunningRow({ declaredIntent: null }))).toEqual({
      action: "keep",
      reason: "no_configured_service_entry",
    });
  });

  it("reprovisions an explicit opt-in that is somehow running without exposure", () => {
    expect(
      decideManagedRuntimeExposureBackfill(httpOnlyRunningRow({ declaredIntent: "enabled" })).action,
    ).toBe("reprovision");
  });

  it("checks the opt-out before broker availability so an opt-out never depends on host state", () => {
    expect(
      decideManagedRuntimeExposureBackfill(httpOnlyRunningRow({
        declaredIntent: "disabled",
        brokerAvailable: false,
      })).reason,
    ).toBe("deliberate_opt_out");
  });
});

/**
 * PAP-17285 regression coverage for the global startup exposure sweep.
 *
 * A server restart at 12:25:49 UTC deleted the operator-preserved `42000/52000`
 * Serve mappings by issuing broker removals for two stale `stopped` rows — 2 and
 * 3 days old, both claiming the same recycled pair — purely on those rows'
 * authority. The sweep spans every execution workspace and company on the host
 * and runs on every start, so "trust the row" is an unbounded delete primitive.
 * These pin the corroboration contract that replaced it.
 */
const RUNTIME = "c4a0f1d8-be27-4f95-970e-443fe4a517b7";
const OTHER_RUNTIME = "c0cca855-0d56-47fc-beca-9f3e3b8d341f";

describe("decideStaleExposureReclaim", () => {
  it("defers instead of removing when the broker cannot be reached", () => {
    // Unreachable broker proves nothing. Fail closed toward preservation: a
    // mapping we cannot attribute must never be deleted on a guess.
    expect(decideStaleExposureReclaim({ runtimeId: RUNTIME, ownedListeners: null })).toEqual({
      action: "defer",
      reason: "broker_unreachable",
    });
  });

  it("clears stale bookkeeping WITHOUT a Serve mutation when the broker owns nothing for the runtime", () => {
    // The 12:28:19 row: 3 days old, claiming a pair that had since been recycled.
    // Nothing of ours is published under this runtime, so there is nothing to
    // remove — only local bookkeeping to tidy.
    expect(decideStaleExposureReclaim({ runtimeId: RUNTIME, ownedListeners: [] })).toEqual({
      action: "clear_bookkeeping",
      reason: "not_owned_by_broker",
    });
    expect(
      decideStaleExposureReclaim({
        runtimeId: RUNTIME,
        ownedListeners: [{ runtimeId: OTHER_RUNTIME, port: 42000 }],
      }),
    ).toEqual({ action: "clear_bookkeeping", reason: "not_owned_by_broker" });
  });

  it("reclaims only when the broker still attributes a listener to that exact runtime", () => {
    // Genuine orphan GC — the behaviour PAP-17207 row 7 requires — is preserved.
    expect(
      decideStaleExposureReclaim({
        runtimeId: RUNTIME,
        ownedListeners: [{ runtimeId: RUNTIME, port: 42001 }],
      }),
    ).toEqual({ action: "reclaim", reason: "owned_by_broker" });
  });

  it("attributes by runtimeId and never by port, so a recycled port cannot cross-authorize", () => {
    // Two rows claiming the same recycled pair is exactly the observed state. If
    // this matched on port, either row could authorize deleting the other's
    // mapping — which is the shape of the original loss.
    expect(
      decideStaleExposureReclaim({
        runtimeId: RUNTIME,
        ownedListeners: [{ runtimeId: OTHER_RUNTIME, port: 42000 }, { runtimeId: OTHER_RUNTIME, port: 52000 }],
      }).action,
    ).toBe("clear_bookkeeping");
  });
});
