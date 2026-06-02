import { describe, expect, it } from "vitest";
import {
  evaluatePreflight,
  type PreflightContext,
} from "../services/run-preflight.ts";

function ctx(overrides: Partial<PreflightContext> = {}): PreflightContext {
  return {
    adapterType: "codex_local",
    adapterConfigured: true,
    requestedModel: "gpt-5.5",
    allowedModels: null,
    requiredSecretNames: [],
    boundSecretNames: [],
    routineId: null,
    routineDeniedSecretNames: [],
    quota: null,
    rate: null,
    ...overrides,
  };
}

describe("evaluatePreflight (G2)", () => {
  it("passes when nothing is wrong", () => {
    expect(evaluatePreflight(ctx())).toEqual({ ok: true });
  });

  it("hard-fails preflight_adapter_unconfigured (blocked, no retry)", () => {
    const r = evaluatePreflight(ctx({ adapterConfigured: false }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("preflight_adapter_unconfigured");
    expect(r.disposition).toBe("hard-fail");
    expect(r.block).toBe(true);
    expect(r.retryable).toBe(false);
  });

  it("hard-fails preflight_model_not_allowed", () => {
    const r = evaluatePreflight(
      ctx({ requestedModel: "gpt-3.5-turbo", allowedModels: ["gpt-5.5", "gpt-5.3-codex-spark"] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("preflight_model_not_allowed");
    expect(r.block).toBe(true);
  });

  it("allows a model that is on the allow-list", () => {
    expect(
      evaluatePreflight(ctx({ requestedModel: "gpt-5.5", allowedModels: ["gpt-5.5"] })).ok,
    ).toBe(true);
  });

  it("skips the model check when no allow-list is configured", () => {
    expect(
      evaluatePreflight(ctx({ requestedModel: "anything", allowedModels: null })).ok,
    ).toBe(true);
  });

  it("hard-fails preflight_secret_unbound naming the missing secret by name", () => {
    const r = evaluatePreflight(
      ctx({ requiredSecretNames: ["OPENAI_API_KEY"], boundSecretNames: [] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("preflight_secret_unbound");
    expect(r.block).toBe(true);
    expect(r.message).toContain("OPENAI_API_KEY"); // name only, never a value
  });

  it("passes when all required secrets are bound", () => {
    expect(
      evaluatePreflight(
        ctx({ requiredSecretNames: ["OPENAI_API_KEY"], boundSecretNames: ["OPENAI_API_KEY"] }),
      ).ok,
    ).toBe(true);
  });

  it("hard-fails preflight_routine_secret_denied", () => {
    const r = evaluatePreflight(
      ctx({
        routineId: "routine-1",
        requiredSecretNames: ["VERCEL_TOKEN"],
        boundSecretNames: ["VERCEL_TOKEN"],
        routineDeniedSecretNames: ["VERCEL_TOKEN"],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("preflight_routine_secret_denied");
    expect(r.block).toBe(true);
  });

  it("soft-defers preflight_quota_cooldown (retryable, not blocked)", () => {
    const r = evaluatePreflight(ctx({ quota: { exhausted: true, cooldownMs: 60000 } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("preflight_quota_cooldown");
    expect(r.disposition).toBe("soft-defer");
    expect(r.block).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.deferMs).toBe(60000);
  });

  it("soft-defers preflight_rate_exhausted with a default cooldown", () => {
    const r = evaluatePreflight(ctx({ rate: { exhausted: true } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("preflight_rate_exhausted");
    expect(r.disposition).toBe("soft-defer");
    expect(typeof r.deferMs).toBe("number");
  });

  it("prioritizes hard-fail (unconfigured) over a concurrent soft-defer (rate)", () => {
    const r = evaluatePreflight(
      ctx({ adapterConfigured: false, rate: { exhausted: true } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("preflight_adapter_unconfigured");
  });
});
