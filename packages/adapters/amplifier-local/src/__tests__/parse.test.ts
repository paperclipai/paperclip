/**
 * Unit tests for the error classification helpers in src/server/parse.ts.
 *
 * These run via vitest at the monorepo level (`pnpm test`).
 */

import { describe, expect, it } from "vitest";
import {
  asAmplifierErrorView,
  describeAmplifierError,
  isAmplifierApprovalUnconfiguredError,
  isAmplifierBundleLoadFailedError,
  isAmplifierProtocolMismatchError,
  isAmplifierUnknownSessionError,
} from "../server/parse.js";

describe("asAmplifierErrorView", () => {
  it("normalises loose fields and trims whitespace", () => {
    const view = asAmplifierErrorView({
      code: "  session_not_found  ",
      classification: "  engine ",
      message: " Session abc is missing ",
      stderrTail: "blah",
    });
    expect(view).toEqual({
      code: "session_not_found",
      classification: "engine",
      message: "Session abc is missing",
      stderrTail: "blah",
    });
  });

  it("returns empty strings on null/undefined inputs", () => {
    expect(asAmplifierErrorView({})).toEqual({
      code: "",
      classification: "",
      message: "",
      stderrTail: "",
    });
  });
});

describe("isAmplifierUnknownSessionError", () => {
  it("matches structured engine codes", () => {
    for (const code of ["session_not_found", "invalid_session", "stale_session"]) {
      const view = asAmplifierErrorView({ code });
      expect(isAmplifierUnknownSessionError(view, "")).toBe(true);
    }
  });

  it("matches engine messages without structured codes (regex fallback)", () => {
    const view = asAmplifierErrorView({
      code: "engine_error",
      message: "Session 7d3e is not found",
    });
    expect(isAmplifierUnknownSessionError(view, "")).toBe(true);
  });

  it("matches via the stderr buffer when message is empty", () => {
    const view = asAmplifierErrorView({ code: "engine_error" });
    expect(
      isAmplifierUnknownSessionError(view, "no session directory at path/to/sess"),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    const view = asAmplifierErrorView({
      code: "provider_init_failed",
      message: "OpenAI API returned 401",
    });
    expect(isAmplifierUnknownSessionError(view, "")).toBe(false);
  });
});

describe("isAmplifierProtocolMismatchError", () => {
  it("matches the canonical protocol_version_mismatch code", () => {
    expect(
      isAmplifierProtocolMismatchError(
        asAmplifierErrorView({ code: "protocol_version_mismatch" }),
      ),
    ).toBe(true);
  });
  it("does not match other protocol-class errors", () => {
    expect(
      isAmplifierProtocolMismatchError(
        asAmplifierErrorView({ code: "wire_protocol_violation" }),
      ),
    ).toBe(false);
  });
});

describe("isAmplifierApprovalUnconfiguredError", () => {
  it("matches the G3 approval_unconfigured code", () => {
    expect(
      isAmplifierApprovalUnconfiguredError(
        asAmplifierErrorView({ code: "approval_unconfigured" }),
      ),
    ).toBe(true);
  });
});

describe("isAmplifierBundleLoadFailedError", () => {
  it("matches bundle_load_failed", () => {
    expect(
      isAmplifierBundleLoadFailedError(
        asAmplifierErrorView({ code: "bundle_load_failed" }),
      ),
    ).toBe(true);
  });
});

describe("describeAmplifierError", () => {
  it("prefers the structured message", () => {
    const view = asAmplifierErrorView({
      code: "engine_error",
      message: "Provider call failed: 401",
    });
    expect(describeAmplifierError(view, "noise on stderr\n", 1)).toBe(
      "Provider call failed: 401",
    );
  });

  it("falls back to the first non-empty stderr line", () => {
    const view = asAmplifierErrorView({ code: "engine_error" });
    expect(describeAmplifierError(view, "\n   \nFatal: bundle prep failed\n", 1)).toBe(
      "Fatal: bundle prep failed",
    );
  });

  it("falls back to the generic exit code message", () => {
    const view = asAmplifierErrorView({});
    expect(describeAmplifierError(view, "", 137)).toBe(
      "amplifier-agent exited with code 137",
    );
    expect(describeAmplifierError(view, "", null)).toBe(
      "amplifier-agent exited with code -1",
    );
  });
});
