import { describe, expect, it } from "vitest";
import {
  isContextOverflowErrorText,
  isContextOverflowRun,
  sumSessionRawInputTokens,
} from "./context-overflow.js";

describe("isContextOverflowRun", () => {
  it("detects the provider overflow 400 and the DCP warning", () => {
    expect(
      isContextOverflowRun({
        errorCode: "adapter_failed",
        error: "invalid_request_error: The request contains invalid parameters",
      }),
    ).toBe(true);
    expect(
      isContextOverflowRun({
        errorCode: "adapter_failed",
        error:
          "invalid_request_error: The request contains invalid parameters. " +
          "<dcp-system-reminder>CRITICAL WARNING: MAX CONTEXT LIMIT REACHED</dcp-system-reminder>",
      }),
    ).toBe(true);
    expect(
      isContextOverflowRun({
        errorCode: "adapter_failed",
        error: "invalid_request_error",
        resultJson: { message: "max context limit" },
      }),
    ).toBe(true);
    expect(
      isContextOverflowErrorText(
        "invalid_request_error",
        "The request contains invalid parameters",
      ),
    ).toBe(true);
  });

  it("ignores unrelated failures and 400s", () => {
    expect(
      isContextOverflowRun({ errorCode: "adapter_failed", error: "tool returned 500" }),
    ).toBe(false);
    expect(
      isContextOverflowRun({
        errorCode: "provider_quota",
        error: "invalid_request_error",
      }),
    ).toBe(false);
    expect(
      isContextOverflowRun({
        error: "invalid_request_error: missing model parameter",
      }),
    ).toBe(false);
    // A DCP reminder in an ordinary run must not force a fresh session: the
    // plugin injects the reminder whenever the context is large, so only the
    // paired provider 400 marks a real overflow.
    expect(
      isContextOverflowRun({
        errorCode: "adapter_failed",
        error:
          "<dcp-system-reminder>CRITICAL WARNING: MAX CONTEXT LIMIT REACHED</dcp-system-reminder>",
      }),
    ).toBe(false);
    expect(isContextOverflowRun({})).toBe(false);
  });
});

describe("sumSessionRawInputTokens", () => {
  const rawUsage = { inputTokens: 1_000, cachedInputTokens: 900_000 };

  it("adds the cache term when the writer stamped exclusive input", () => {
    expect(sumSessionRawInputTokens(rawUsage, { rawInputIncludesCached: false })).toBe(
      901_000,
    );
  });

  it("adds the cache term when the stamp is missing", () => {
    expect(sumSessionRawInputTokens(rawUsage, { inputTokens: 1_000 })).toBe(901_000);
    expect(sumSessionRawInputTokens(rawUsage, undefined)).toBe(901_000);
  });

  it("skips the cache term only when input is declared inclusive", () => {
    expect(sumSessionRawInputTokens(rawUsage, { rawInputIncludesCached: true })).toBe(
      1_000,
    );
  });

  it("returns zero when no raw usage was reported", () => {
    expect(sumSessionRawInputTokens(null, { rawInputIncludesCached: false })).toBe(0);
  });
});
