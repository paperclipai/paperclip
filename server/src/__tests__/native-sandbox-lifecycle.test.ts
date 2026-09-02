import { describe, expect, it } from "vitest";
import { resolveNativeSandboxLifecycle } from "../services/heartbeat.js";

const reusableSandbox = {
  kind: "remote" as const,
  transport: "sandbox",
  reusableLeaseConfigured: true,
  effectiveCapabilities: { reusableLeases: true },
};

describe("paperclip_runner sandbox lifecycle", () => {
  it("keeps a warm reusable sandbox running", () => {
    expect(resolveNativeSandboxLifecycle({
      adapterType: "paperclip_runner",
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
      target: reusableSandbox,
    })).toEqual({
      runnerProcess: "warm",
      sandboxResource: "keep_running",
      failoverBackup: "verified",
    });
  });

  it("stops and reuses a per-turn reusable sandbox", () => {
    expect(resolveNativeSandboxLifecycle({
      adapterType: "paperclip_runner",
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      target: reusableSandbox,
    })).toEqual({
      runnerProcess: "per_turn",
      sandboxResource: "stop_and_reuse",
      failoverBackup: "verified",
    });
  });

  it("destroys a per-turn disposable sandbox", () => {
    expect(resolveNativeSandboxLifecycle({
      adapterType: "paperclip_runner",
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      target: {
        ...reusableSandbox,
        reusableLeaseConfigured: false,
      },
    })).toEqual({
      runnerProcess: "per_turn",
      sandboxResource: "destroy_after_turn",
      failoverBackup: "verified",
    });
  });

  it("rejects warm mode without an effective reusable-lease capability", () => {
    expect(() => resolveNativeSandboxLifecycle({
      adapterType: "paperclip_runner",
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
      target: {
        ...reusableSandbox,
        effectiveCapabilities: { reusableLeases: false },
      },
    })).toThrow("runner_warm_lifecycle_requires_reusable_provider_lease");
  });

  it("leaves legacy and non-sandbox targets untouched", () => {
    expect(resolveNativeSandboxLifecycle({
      adapterType: "codex_local",
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      target: reusableSandbox,
    })).toBeNull();
    expect(resolveNativeSandboxLifecycle({
      adapterType: "paperclip_runner",
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      target: { kind: "local" },
    })).toBeNull();
  });
});
