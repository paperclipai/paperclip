import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAILSCALE_HTTPS_EXPOSURE,
  parseRuntimeExposureConfig,
  readRuntimeExposureIntent,
  resolveDeclaredRuntimeExposureConfig,
  runtimeExposureConfigSchema,
  runtimeExposureListenerSchema,
  runtimeExposureStatusSchema,
} from "./runtime-exposure.js";

describe("runtimeExposureConfigSchema", () => {
  it("accepts the default fail-closed config", () => {
    expect(() => runtimeExposureConfigSchema.parse(DEFAULT_TAILSCALE_HTTPS_EXPOSURE)).not.toThrow();
  });

  it("rejects unknown fields (no smuggled target/path/hostname suffix)", () => {
    expect(() =>
      runtimeExposureConfigSchema.parse({
        ...DEFAULT_TAILSCALE_HTTPS_EXPOSURE,
        target: "http://127.0.0.1:5432",
      }),
    ).toThrow();
  });

  it("rejects arbitrary hostname / publicPort / provider / failure policy", () => {
    expect(() =>
      runtimeExposureConfigSchema.parse({ ...DEFAULT_TAILSCALE_HTTPS_EXPOSURE, hostname: "evil.example" }),
    ).toThrow();
    expect(() =>
      runtimeExposureConfigSchema.parse({ ...DEFAULT_TAILSCALE_HTTPS_EXPOSURE, publicPort: 443 }),
    ).toThrow();
    expect(() =>
      runtimeExposureConfigSchema.parse({ ...DEFAULT_TAILSCALE_HTTPS_EXPOSURE, type: "funnel" }),
    ).toThrow();
    expect(() =>
      runtimeExposureConfigSchema.parse({ ...DEFAULT_TAILSCALE_HTTPS_EXPOSURE, failurePolicy: "fail_open" }),
    ).toThrow();
  });

  it("parseRuntimeExposureConfig returns null when absent and throws when malformed", () => {
    expect(parseRuntimeExposureConfig(undefined)).toBeNull();
    expect(parseRuntimeExposureConfig(null)).toBeNull();
    expect(parseRuntimeExposureConfig(DEFAULT_TAILSCALE_HTTPS_EXPOSURE)).toEqual(
      DEFAULT_TAILSCALE_HTTPS_EXPOSURE,
    );
    expect(() => parseRuntimeExposureConfig({ type: "tailscale_https" })).toThrow();
  });
});

describe("readRuntimeExposureIntent", () => {
  it("treats a legacy expose block with no exposure fields as unset", () => {
    // The pre-feature Paperclip App template shape: an `expose` block that only
    // describes the backend URL. This must be defaultable, not opted out.
    expect(readRuntimeExposureIntent({ urlTemplate: "http://paperclip-dev:{{port}}" })).toBe("unset");
    expect(readRuntimeExposureIntent(undefined)).toBe("unset");
    expect(readRuntimeExposureIntent(null)).toBe("unset");
    expect(readRuntimeExposureIntent({})).toBe("unset");
    expect(readRuntimeExposureIntent([])).toBe("unset");
    expect(readRuntimeExposureIntent("tailscale_https")).toBe("unset");
  });

  it("reads explicit opt-in", () => {
    expect(readRuntimeExposureIntent({ type: "tailscale_https" })).toBe("enabled");
    expect(readRuntimeExposureIntent(DEFAULT_TAILSCALE_HTTPS_EXPOSURE)).toBe("enabled");
    expect(readRuntimeExposureIntent({ tailscaleHttps: true })).toBe("enabled");
  });

  it("reads deliberate opt-out", () => {
    expect(readRuntimeExposureIntent({ tailscaleHttps: false })).toBe("disabled");
    expect(readRuntimeExposureIntent({ type: "none" })).toBe("disabled");
  });

  it("lets an explicit negative win over a stale positive in the same block", () => {
    expect(readRuntimeExposureIntent({ type: "tailscale_https", tailscaleHttps: false })).toBe("disabled");
  });
});

describe("resolveDeclaredRuntimeExposureConfig", () => {
  it("returns null unless the block explicitly opts in", () => {
    expect(resolveDeclaredRuntimeExposureConfig(undefined)).toBeNull();
    expect(resolveDeclaredRuntimeExposureConfig({ urlTemplate: "http://paperclip-dev:{{port}}" })).toBeNull();
    expect(resolveDeclaredRuntimeExposureConfig({ tailscaleHttps: false })).toBeNull();
  });

  it("completes a bare declaration from the fail-closed defaults", () => {
    expect(resolveDeclaredRuntimeExposureConfig({ type: "tailscale_https" })).toEqual(
      DEFAULT_TAILSCALE_HTTPS_EXPOSURE,
    );
    // Shorthand normalizes to the provider literal.
    expect(resolveDeclaredRuntimeExposureConfig({ tailscaleHttps: true })).toEqual(
      DEFAULT_TAILSCALE_HTTPS_EXPOSURE,
    );
  });

  it("keeps the backend urlTemplate alongside an opt-in without leaking it into the config", () => {
    expect(
      resolveDeclaredRuntimeExposureConfig({
        type: "tailscale_https",
        urlTemplate: "http://127.0.0.1:{{port}}",
      }),
    ).toEqual(DEFAULT_TAILSCALE_HTTPS_EXPOSURE);
  });

  it("honors an explicit sub-field override", () => {
    expect(
      resolveDeclaredRuntimeExposureConfig({ type: "tailscale_https", includePaperclipViteHmr: false }),
    ).toEqual({ ...DEFAULT_TAILSCALE_HTTPS_EXPOSURE, includePaperclipViteHmr: false });
  });

  it("still rejects smuggled fields and invalid sub-field values", () => {
    expect(() =>
      resolveDeclaredRuntimeExposureConfig({ type: "tailscale_https", target: "http://127.0.0.1:5432" }),
    ).toThrow(/Unsupported expose field/);
    expect(() =>
      resolveDeclaredRuntimeExposureConfig({ type: "tailscale_https", hostname: "evil.example" }),
    ).toThrow();
    expect(() =>
      resolveDeclaredRuntimeExposureConfig({ type: "tailscale_https", failurePolicy: "fail_open" }),
    ).toThrow();
  });
});

describe("runtimeExposureListenerSchema", () => {
  it("enforces the same-number invariant", () => {
    expect(() =>
      runtimeExposureListenerSchema.parse({ purpose: "app", publicPort: 42010, targetPort: 42010 }),
    ).not.toThrow();
    expect(() =>
      runtimeExposureListenerSchema.parse({ purpose: "app", publicPort: 42010, targetPort: 5432 }),
    ).toThrow();
  });
});

describe("runtimeExposureStatusSchema", () => {
  it("accepts a well-formed ready status", () => {
    expect(() =>
      runtimeExposureStatusSchema.parse({
        provider: "tailscale_https",
        state: "ready",
        publicUrl: "https://paperclip-dev.tail29c1aa.ts.net:42010",
        hostname: "paperclip-dev.tail29c1aa.ts.net",
        listeners: [
          { purpose: "app", publicPort: 42010, targetPort: 42010 },
          { purpose: "vite_hmr", publicPort: 52010, targetPort: 52010 },
        ],
        brokerRef: "rs-1",
        lastError: null,
        updatedAt: "2026-08-11T00:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("rejects unknown fields in serialized status", () => {
    expect(() =>
      runtimeExposureStatusSchema.parse({
        provider: "tailscale_https",
        state: "ready",
        publicUrl: null,
        hostname: null,
        listeners: [],
        brokerRef: null,
        lastError: null,
        updatedAt: null,
        leaseHandle: "secret",
      }),
    ).toThrow();
  });
});
