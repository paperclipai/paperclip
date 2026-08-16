/**
 * Backfill decision coverage for PAP-17158.
 *
 * `decideManagedRuntimeExposureBackfill` is the whole contract for which
 * pre-feature workspaces get upgraded to HTTPS in place and which are left
 * alone, so each branch is asserted by its reason code rather than only by the
 * resulting action.
 */
import { describe, expect, it } from "vitest";

import { decideManagedRuntimeExposureBackfill } from "./workspace-runtime.js";

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
