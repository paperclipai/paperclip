import { describe, expect, it } from "vitest";
import {
  createCodexLiveProofScope,
  evaluateCodexLiveProof,
  getCodexLiveProofExpiryMs,
} from "./codex-live-proof";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");

function liveResult(overrides: Record<string, unknown> = {}) {
  return {
    adapterType: "codex_local",
    status: "pass",
    testedAt: new Date(NOW).toISOString(),
    checks: [
      {
        code: "codex_hello_probe_passed",
        level: "info",
        message: "Raw probe message should stay hidden.",
        detail: "token=secret-value /Users/person/private user@example.com",
      },
    ],
    ...overrides,
  };
}

describe("evaluateCodexLiveProof", () => {
  it.each(["pass", "warn"])("accepts a recent %s result with the exact live proof check", (status) => {
    expect(evaluateCodexLiveProof(liveResult({ status }), NOW)).toEqual({
      valid: true,
      testedAt: "2026-08-31T12:00:00.000Z",
      detail: "Hello.",
      warnings: [],
    });
  });

  it("normalizes warning checks without exposing server text", () => {
    const proof = evaluateCodexLiveProof(
      liveResult({
        status: "warn",
        checks: [
          { code: "codex_hello_probe_passed", level: "info", message: "ok" },
          {
            code: "codex_fast_mode_unsupported_model",
            level: "warn",
            message: "token=secret-value /Users/person/private",
            hint: "user@example.com",
          },
          { code: "future_warning_code", level: "warn", message: "another-secret" },
        ],
      }),
      NOW,
    );

    expect(proof).toEqual({
      valid: true,
      testedAt: "2026-08-31T12:00:00.000Z",
      detail: "Hello.",
      warnings: [
        "Codex Fast mode is unavailable for the selected model.",
        "Codex reported an additional warning. Review the server-side test details.",
      ],
    });
    expect(JSON.stringify(proof)).not.toContain("secret-value");
    expect(JSON.stringify(proof)).not.toContain("user@example.com");
  });

  it.each([
    ["non-object result", null, "Codex did not return a valid connection result."],
    ["failed status", liveResult({ status: "fail" }), "Codex did not pass the live connection test."],
    [
      "different adapter",
      liveResult({ adapterType: "claude_local" }),
      "Codex returned a result for a different adapter.",
    ],
    ["unknown status", liveResult({ status: "ok" }), "Codex did not pass the live connection test."],
    ["non-array checks", liveResult({ checks: {} }), "Codex returned invalid connection checks."],
    [
      "malformed check",
      liveResult({ checks: [{ code: "codex_hello_probe_passed", level: "info" }] }),
      "Codex returned invalid connection checks.",
    ],
    [
      "error check",
      liveResult({
        checks: [
          { code: "codex_hello_probe_passed", level: "info", message: "ok" },
          { code: "codex_cwd_invalid", level: "error", message: "invalid" },
        ],
      }),
      "Codex reported a connection error.",
    ],
    [
      "near-match proof code",
      liveResult({ checks: [{ code: "codex_hello_probe_passed_extra", level: "info", message: "ok" }] }),
      "Codex did not verify a live reply.",
    ],
    [
      "runtime scaffold only",
      liveResult({ checks: [{ code: "codex_acp_runtime_scaffold", level: "info", message: "ready" }] }),
      "Codex did not verify a live reply.",
    ],
    [
      "non-info proof check",
      liveResult({ checks: [{ code: "codex_hello_probe_passed", level: "warn", message: "not proven" }] }),
      "Codex did not verify a live reply.",
    ],
    [
      "stale proof",
      liveResult({ testedAt: new Date(NOW - 5 * 60_000 - 1).toISOString() }),
      "The Codex connection proof has expired.",
    ],
    [
      "far-future proof",
      liveResult({ testedAt: new Date(NOW + 60_001).toISOString() }),
      "The Codex connection proof has an invalid timestamp.",
    ],
    [
      "invalid timestamp",
      liveResult({ testedAt: "not-a-date" }),
      "The Codex connection proof has an invalid timestamp.",
    ],
  ])("rejects %s", (_name, result, reason) => {
    expect(evaluateCodexLiveProof(result, NOW)).toEqual({ valid: false, reason });
  });

  it.each([
    "codex_hello_probe_timed_out",
    "codex_hello_probe_unexpected_output",
    "codex_hello_probe_auth_required",
  ])("rejects a contradictory %s warning", (code) => {
    expect(
      evaluateCodexLiveProof(
        liveResult({
          status: "warn",
          checks: [
            { code: "codex_hello_probe_passed", level: "info", message: "ok" },
            { code, level: "warn", message: "not actually successful" },
          ],
        }),
        NOW,
      ),
    ).toEqual({
      valid: false,
      reason: "Codex reported an unsuccessful live reply.",
    });
  });

  it("accepts timestamps exactly on the freshness boundaries", () => {
    expect(
      evaluateCodexLiveProof(
        liveResult({ testedAt: new Date(NOW - 5 * 60_000).toISOString() }),
        NOW,
      ).valid,
    ).toBe(true);
    expect(
      evaluateCodexLiveProof(
        liveResult({ testedAt: new Date(NOW + 60_000).toISOString() }),
        NOW,
      ).valid,
    ).toBe(true);
  });
});

describe("createCodexLiveProofScope", () => {
  it("binds proof to company, adapter, environment, and canonicalized config", () => {
    const left = createCodexLiveProofScope({
      companyId: "company-1",
      adapterType: "codex_local",
      environmentId: "sandbox-1",
      adapterConfig: { model: "gpt-5", nested: { b: 2, a: 1 } },
    });
    const same = createCodexLiveProofScope({
      companyId: "company-1",
      adapterType: "codex_local",
      environmentId: "sandbox-1",
      adapterConfig: { nested: { a: 1, b: 2 }, model: "gpt-5" },
    });

    expect(left).toBe(same);
    expect(
      createCodexLiveProofScope({
        companyId: "company-1",
        adapterType: "codex_local",
        environmentId: "sandbox-2",
        adapterConfig: { model: "gpt-5", nested: { a: 1, b: 2 } },
      }),
    ).not.toBe(left);
    expect(
      createCodexLiveProofScope({
        companyId: "company-2",
        adapterType: "codex_local",
        environmentId: "sandbox-1",
        adapterConfig: { model: "gpt-5", nested: { a: 1, b: 2 } },
      }),
    ).not.toBe(left);
    expect(
      createCodexLiveProofScope({
        companyId: "company-1",
        adapterType: "codex_local",
        environmentId: "sandbox-1",
        adapterConfig: { model: "gpt-5.1", nested: { a: 1, b: 2 } },
      }),
    ).not.toBe(left);
  });

  it("fails closed without a Codex company scope", () => {
    expect(
      createCodexLiveProofScope({
        companyId: null,
        adapterType: "codex_local",
        environmentId: null,
        adapterConfig: {},
      }),
    ).toBeNull();
    expect(
      createCodexLiveProofScope({
        companyId: "company-1",
        adapterType: "claude_local",
        environmentId: null,
        adapterConfig: {},
      }),
    ).toBeNull();
  });
});

describe("getCodexLiveProofExpiryMs", () => {
  it("returns the exact five-minute expiry for a valid proof timestamp", () => {
    expect(getCodexLiveProofExpiryMs(liveResult(), NOW)).toBe(NOW + 5 * 60_000);
  });

  it("fails closed for invalid results instead of scheduling unsafe timers", () => {
    expect(getCodexLiveProofExpiryMs(null, NOW)).toBeNull();
    expect(getCodexLiveProofExpiryMs(liveResult({ testedAt: "invalid" }), NOW)).toBeNull();
    expect(
      getCodexLiveProofExpiryMs(
        liveResult({ testedAt: new Date(NOW + 60_001).toISOString() }),
        NOW,
      ),
    ).toBeNull();
  });
});
