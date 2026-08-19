import { describe, expect, it } from "vitest";

import {
  assertBundleSecretFree,
  bundleId,
  describeBundle,
  EvalBundleSecretError,
  type EvalBundle,
} from "./eval-bundle.js";

function bundle(overrides: Partial<EvalBundle> = {}): EvalBundle {
  return {
    schema: "paperclip.runner.eval-bundle.v1",
    provider: { runtime: "runnerd", transport: "codex-app-server", protocolVersion: "prp.v1" },
    model: { id: "gpt-5-codex", reasoningEffort: "medium" },
    launchContext: { workingDirectoryClass: "ephemeral-fixture", scenarioId: "capability-live-eval-st-1", turnTimeoutMs: 60_000 },
    promptPolicy: { id: "exact-single-call", callTemplate: "Call {op} exactly once.", restraintTemplate: "Do not call any tools." },
    grants: ["discovery:tasks:read"],
    runner: { package: "@paperclipai/paperclip-runner", binary: "paperclip-runnerd", version: "0.0.0" },
    controlPlaneAdapter: { kind: "mock", contract: "paperclip.capability.control-plane.v1" },
    faultInjection: [],
    ...overrides,
  };
}

describe("bundleId", () => {
  it("is stable and independent of field ordering", () => {
    const a = bundle();
    const b: EvalBundle = {
      // Same content, different key insertion order.
      faultInjection: [],
      controlPlaneAdapter: { contract: "paperclip.capability.control-plane.v1", kind: "mock" },
      runner: { version: "0.0.0", binary: "paperclip-runnerd", package: "@paperclipai/paperclip-runner" },
      grants: ["discovery:tasks:read"],
      promptPolicy: { restraintTemplate: "Do not call any tools.", callTemplate: "Call {op} exactly once.", id: "exact-single-call" },
      model: { reasoningEffort: "medium", id: "gpt-5-codex" },
      launchContext: { turnTimeoutMs: 60_000, scenarioId: "capability-live-eval-st-1", workingDirectoryClass: "ephemeral-fixture" },
      provider: { protocolVersion: "prp.v1", transport: "codex-app-server", runtime: "runnerd" },
      schema: "paperclip.runner.eval-bundle.v1",
    };
    expect(bundleId(a)).toBe(bundleId(b));
    expect(bundleId(a)).toMatch(/^evb-[0-9a-f]{16}$/);
  });

  it("changes when any declared input changes", () => {
    expect(bundleId(bundle())).not.toBe(bundleId(bundle({ model: { id: "gpt-5" } })));
    expect(bundleId(bundle())).not.toBe(bundleId(bundle({ grants: ["discovery:agents:read"] })));
    expect(bundleId(bundle())).not.toBe(
      bundleId(bundle({ faultInjection: [{ id: "f1", class: "authorization", description: "deny grant" }] })),
    );
  });
});

describe("assertBundleSecretFree", () => {
  it("accepts a clean, typed bundle", () => {
    expect(() => assertBundleSecretFree(bundle())).not.toThrow();
    expect(() =>
      assertBundleSecretFree(
        bundle({ faultInjection: [{ id: "f1", class: "provider_capability", description: "drop steering support" }] }),
      ),
    ).not.toThrow();
  });

  it("rejects an untyped grant", () => {
    expect(() => assertBundleSecretFree(bundle({ grants: ["not-a-grant"] }))).toThrow(EvalBundleSecretError);
  });

  it("rejects a secret-shaped value smuggled into a template", () => {
    const leaked = bundle({
      promptPolicy: {
        id: "leaky",
        callTemplate: "Use key sk-ABCDEF0123456789ABCDEF to call {op}.",
        restraintTemplate: "none",
      },
    });
    expect(() => assertBundleSecretFree(leaked)).toThrow(/openai-key/);
  });

  it("rejects a bearer token and a forbidden key", () => {
    const withToken = bundle({
      launchContext: {
        workingDirectoryClass: "clean-room",
        scenarioId: "Authorization: Bearer abcdef0123456789abcdef",
        turnTimeoutMs: 1000,
      },
    });
    expect(() => assertBundleSecretFree(withToken)).toThrow(EvalBundleSecretError);

    const withForbiddenKey = { ...bundle(), apiKey: "value" } as unknown as EvalBundle;
    expect(() => assertBundleSecretFree(withForbiddenKey)).toThrow(/forbidden key/);
  });
});

describe("describeBundle", () => {
  it("produces a redacted one-line summary carrying the bundle id", () => {
    const described = describeBundle(bundle());
    expect(described.bundleId).toBe(bundleId(bundle()));
    expect(described.summary).toContain("runnerd/codex-app-server@prp.v1");
    expect(described.summary).toContain("gpt-5-codex");
    expect(described.summary).toContain("faults:clean");
    expect(described.summary).not.toContain("sk-");
  });

  it("names the fault classes when faults are injected", () => {
    const described = describeBundle(
      bundle({ faultInjection: [{ id: "f1", class: "conflict", description: "stale write" }] }),
    );
    expect(described.summary).toContain("faults:conflict");
  });
});
