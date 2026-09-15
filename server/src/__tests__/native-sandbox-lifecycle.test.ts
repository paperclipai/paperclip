import { describe, expect, it } from "vitest";
import {
  providerResourceDispositionForTerminalRun,
  recoveredNativeProviderResourceDisposition,
  readNativeProviderResourceDisposition,
  resolveNativeSandboxLifecycle,
  resolveReusableSandboxLifecycle,
} from "../services/heartbeat.js";

const reusableSandbox = {
  kind: "remote" as const,
  transport: "sandbox",
  reusableLeaseConfigured: true,
  effectiveCapabilities: { reusableLeases: true },
};

describe("paperclip_runner sandbox lifecycle", () => {
  it("keeps a warm reusable sandbox running", () => {
    expect(
      resolveNativeSandboxLifecycle({
        adapterType: "paperclip_runner",
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
        target: reusableSandbox,
      }),
    ).toEqual({
      runnerProcess: "warm",
      sandboxResource: "keep_running",
      failoverBackup: "verified",
    });
  });

  it("keeps the same warm reusable sandbox for a legacy adapter", () => {
    expect(
      resolveReusableSandboxLifecycle({
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
        target: reusableSandbox,
      }),
    ).toEqual({
      runnerProcess: "warm",
      sandboxResource: "keep_running",
      failoverBackup: "verified",
    });
  });

  it("stops and reuses a per-turn reusable sandbox", () => {
    expect(
      resolveNativeSandboxLifecycle({
        adapterType: "paperclip_runner",
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        target: reusableSandbox,
      }),
    ).toEqual({
      runnerProcess: "per_turn",
      sandboxResource: "stop_and_reuse",
      failoverBackup: "verified",
    });
  });

  it("destroys a per-turn disposable sandbox", () => {
    expect(
      resolveNativeSandboxLifecycle({
        adapterType: "paperclip_runner",
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        target: {
          ...reusableSandbox,
          reusableLeaseConfigured: false,
        },
      }),
    ).toEqual({
      runnerProcess: "per_turn",
      sandboxResource: "destroy_after_turn",
      failoverBackup: "verified",
    });
  });

  it("rejects warm mode without an effective reusable-lease capability", () => {
    expect(() =>
      resolveNativeSandboxLifecycle({
        adapterType: "paperclip_runner",
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
        target: {
          ...reusableSandbox,
          effectiveCapabilities: { reusableLeases: false },
        },
      }),
    ).toThrow("runner_warm_lifecycle_requires_reusable_provider_lease");
  });

  it("leaves legacy and non-sandbox targets untouched", () => {
    expect(
      resolveNativeSandboxLifecycle({
        adapterType: "codex_local",
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        target: reusableSandbox,
      }),
    ).toBeNull();
    expect(
      resolveNativeSandboxLifecycle({
        adapterType: "paperclip_runner",
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        target: { kind: "local" },
      }),
    ).toBeNull();
  });

  it("keeps a warm sandbox only after a successful turn", () => {
    expect(
      providerResourceDispositionForTerminalRun("keep_running", "succeeded"),
    ).toBe("keep_running");
    expect(
      providerResourceDispositionForTerminalRun("keep_running", "failed"),
    ).toBe("stop_and_retain");
    expect(
      providerResourceDispositionForTerminalRun("keep_running", "cancelled"),
    ).toBe("stop_and_retain");
    expect(
      providerResourceDispositionForTerminalRun("keep_running", "timed_out"),
    ).toBe("stop_and_retain");
    expect(providerResourceDispositionForTerminalRun("destroy", "failed")).toBe(
      "destroy",
    );
  });
});


describe("recovered native scoped-folder disposition", () => {
  it("keeps the selected warm lease without an obsolete workspace copy-back reference", () => {
    expect(recoveredNativeProviderResourceDisposition({ nativeProviderResourceDisposition: "keep_running" }, "succeeded", true)).toBe("keep_running");
  });
  it.each(["failed", "cancelled", "timed_out", "running", null])("does not retain a warm process for %s", (status) => {
    expect(recoveredNativeProviderResourceDisposition({ nativeProviderResourceDisposition: "keep_running" }, status, true)).toBe("stop_and_retain");
  });
  it("uses an older persisted workspace-sync disposition when no independent stamp exists", () => {
    const reference = { schema: "paperclip.native-workspace-sync/v1", state: "prepared",
      descriptorSha256: "a".repeat(64), baselineSha256: "a".repeat(64), finalHostSha256: null,
      workspaceId: "workspace", leaseId: "lease", providerLeaseId: "sandbox", remoteCwd: "/workspace", resourceDisposition: "keep_running" };
    expect(recoveredNativeProviderResourceDisposition({ nativeWorkspaceSync: reference }, "succeeded", true)).toBe("keep_running");
  });
  it("preserves per-turn policies and conservative failure/unknown behavior", () => {
    expect(recoveredNativeProviderResourceDisposition({ nativeProviderResourceDisposition: "destroy" }, "succeeded", true)).toBe("destroy");
    expect(recoveredNativeProviderResourceDisposition({ nativeProviderResourceDisposition: "stop_and_retain" }, "succeeded", true)).toBe("stop_and_retain");
    expect(recoveredNativeProviderResourceDisposition({ nativeProviderResourceDisposition: "destroy" }, "succeeded", false)).toBe("stop_and_retain");
    expect(recoveredNativeProviderResourceDisposition({}, "succeeded", true)).toBe("stop_and_retain");
    expect(readNativeProviderResourceDisposition("invalid")).toBeUndefined();
  });
});
