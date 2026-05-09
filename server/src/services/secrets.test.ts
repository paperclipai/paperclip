import { describe, expect, it } from "vitest";
import { secretService } from "./secrets.js";

// resolveEnvBindings is called at heartbeat execution-setup to inject project-level env
// variables. It must not throw on non-conforming entries — they are silently skipped so
// that feature-settings data inadvertently persisted into projects.env (BAC-730) does not
// brick every heartbeat on the affected project.
//
// Two skip paths exist:
//   1. Key does not match ENV_KEY_RE (e.g. "my-key", "123bad")
//   2. Value does not match envBindingSchema (e.g. { holdHours: 4 } from productivityReview)
//
// The write path (normalizeEnvBindingsForPersistence) stays strict and rejects both cases.

// DB is only used for secret_ref resolution; plain-binding and skip cases need no DB.
const nullDb = null as unknown as Parameters<typeof secretService>[0];

describe("secretService.resolveEnvBindings", () => {
  it("resolves plain string bindings", async () => {
    const svc = secretService(nullDb);
    const result = await svc.resolveEnvBindings("company-1", {
      API_URL: { type: "plain", value: "https://example.com" },
      DEBUG: "true",
    });
    expect(result.env).toEqual({
      API_URL: "https://example.com",
      DEBUG: "true",
    });
    expect(result.secretKeys.size).toBe(0);
  });

  it("skips entries whose value is not a valid env binding (BAC-730 core case)", async () => {
    // productivityReview: { holdHours: 4 } passes the key-name regex but fails
    // envBindingSchema because the value is a freeform object, not a plain/secret_ref binding.
    const svc = secretService(nullDb);
    const result = await svc.resolveEnvBindings("company-1", {
      VALID_KEY: { type: "plain", value: "kept" },
      productivityReview: { holdHours: 4, longActiveDurationMs: 21600000 },
    });
    expect(result.env).toEqual({ VALID_KEY: "kept" });
    expect("productivityReview" in result.env).toBe(false);
  });

  it("skips entries whose key does not match ENV_KEY_RE", async () => {
    const svc = secretService(nullDb);
    const result = await svc.resolveEnvBindings("company-1", {
      VALID: "ok",
      "my-hyphenated-key": { type: "plain", value: "skipped" },
    });
    expect(result.env).toEqual({ VALID: "ok" });
    expect("my-hyphenated-key" in result.env).toBe(false);
  });

  it("returns empty env when every entry is non-conforming", async () => {
    const svc = secretService(nullDb);
    const result = await svc.resolveEnvBindings("company-1", {
      productivityReview: { holdHours: 4 },
      someArray: [1, 2, 3],
    });
    expect(result.env).toEqual({});
    expect(result.secretKeys.size).toBe(0);
  });

  it("returns empty env for null input", async () => {
    const svc = secretService(nullDb);
    const result = await svc.resolveEnvBindings("company-1", null);
    expect(result.env).toEqual({});
  });
});

describe("secretService.normalizeEnvBindingsForPersistence (write path stays strict)", () => {
  it("rejects non-binding objects on write", async () => {
    const svc = secretService(nullDb);
    await expect(
      svc.normalizeEnvBindingsForPersistence("company-1", {
        productivityReview: { holdHours: 4 },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects keys that do not match ENV_KEY_RE on write", async () => {
    const svc = secretService(nullDb);
    await expect(
      svc.normalizeEnvBindingsForPersistence("company-1", {
        "my-key": { type: "plain", value: "hello" },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
