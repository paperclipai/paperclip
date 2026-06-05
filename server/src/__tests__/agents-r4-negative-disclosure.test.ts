// F3 (ANT-1152, ANT-799 R4): negative-disclosure test — plaintext sensitive env value
// MUST NOT appear in any API response that passes through redactAdapterConfig.
// Lens: STRIDE Information-Disclosure. Precedent: ANT-927 (PII via fallback correlation id).
// Tests redactAdapterConfig directly — the function applied in buildAgentDetail for all
// non-restricted board API responses.
import { randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import { redactAdapterConfig, REDACTED_EVENT_VALUE } from "../redaction.js";

const PLAINTEXT_MARKER = "CSO_TEST_MARKER_" + randomBytes(8).toString("hex");

describe("R4 — negative disclosure: plaintext secret MUST NOT survive redactAdapterConfig (F3, ANT-1152)", () => {
  it("type=plain GITHUB_TOKEN value is redacted to REDACTED_EVENT_VALUE", () => {
    const config = {
      env: {
        GITHUB_TOKEN: { type: "plain", value: PLAINTEXT_MARKER },
      },
    };
    const result = redactAdapterConfig(config);
    const raw = JSON.stringify(result);
    expect(raw).not.toContain(PLAINTEXT_MARKER);
    expect((result as any).env.GITHUB_TOKEN.value).toBe(REDACTED_EVENT_VALUE);
  });

  it("PLAINTEXT_MARKER does NOT appear in any env binding regardless of key name", () => {
    const config = {
      env: {
        GITHUB_TOKEN: { type: "plain", value: PLAINTEXT_MARKER },
        MY_FEATURE_FLAG: { type: "plain", value: PLAINTEXT_MARKER },
        ARBITRARY_KEY: { type: "plain", value: PLAINTEXT_MARKER },
      },
    };
    const raw = JSON.stringify(redactAdapterConfig(config));
    expect(raw).not.toContain(PLAINTEXT_MARKER);
  });

  it("secret_ref bindings do NOT expose secretId in redacted output", () => {
    const VAULT_ID = "11111111-1111-4111-8111-111111111111";
    const config = {
      env: {
        GITHUB_TOKEN: { type: "secret_ref", secretId: VAULT_ID, version: "latest" },
      },
    };
    const result = redactAdapterConfig(config);
    const raw = JSON.stringify(result);
    expect(raw).not.toContain(VAULT_ID);
    expect((result as any).env.GITHUB_TOKEN.type).toBe("secret_ref");
    expect((result as any).env.GITHUB_TOKEN.secretId).toBe("<redacted>");
  });

  it("null adapterConfig returns null (no crash on missing config)", () => {
    expect(redactAdapterConfig(null)).toBeNull();
    expect(redactAdapterConfig(undefined)).toBeNull();
  });

  it("runtimeConfig env bindings are also redacted (nested model profiles)", () => {
    const config = {
      modelProfiles: {
        default: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: PLAINTEXT_MARKER },
          },
        },
      },
    };
    const raw = JSON.stringify(redactAdapterConfig(config));
    expect(raw).not.toContain(PLAINTEXT_MARKER);
  });
});
