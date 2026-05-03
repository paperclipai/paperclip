import { describe, expect, test } from "vitest";
import { isGeminiTransientNetworkError, isGeminiUnknownSessionError } from "./parse.js";

describe("isGeminiUnknownSessionError", () => {
  test("matches 'unknown session'", () => {
    expect(isGeminiUnknownSessionError("", "Error: unknown session 'abc-123'")).toBe(true);
  });

  test("matches 'session ... not found'", () => {
    expect(isGeminiUnknownSessionError("", "Resumed session abc-123 not found on disk")).toBe(true);
  });

  test("does not match unrelated stderr", () => {
    expect(isGeminiUnknownSessionError("", "Some other error")).toBe(false);
  });

  test("does not match transient network errors (those go to isGeminiTransientNetworkError)", () => {
    expect(
      isGeminiUnknownSessionError(
        "",
        "_GaxiosError: getaddrinfo ENOTFOUND oauth2.googleapis.com",
      ),
    ).toBe(false);
  });

  test("matches token-overflow during chat compression — recovery is a fresh session", () => {
    const stderr =
      `_ApiError: {"error":{"code":400,"message":"The input token count exceeds the maximum number of tokens allowed 1048576","status":"INVALID_ARGUMENT"}}` +
      ` at ChatCompressionService.compress (.../gemini-cli/...)`;
    expect(isGeminiUnknownSessionError("", stderr)).toBe(true);
  });

  test("matches 'input token count exceeds' phrasing", () => {
    expect(
      isGeminiUnknownSessionError("", "Error: input token count exceeds maximum allowed"),
    ).toBe(true);
  });
});

describe("isGeminiTransientNetworkError", () => {
  test("matches DNS failure on oauth2.googleapis.com", () => {
    const stderr =
      "_GaxiosError: request to https://oauth2.googleapis.com/token failed, reason: getaddrinfo ENOTFOUND oauth2.googleapis.com";
    expect(isGeminiTransientNetworkError("", stderr)).toBe(true);
  });

  test("matches EAI_AGAIN", () => {
    expect(isGeminiTransientNetworkError("", "Error: getaddrinfo EAI_AGAIN sts.googleapis.com")).toBe(true);
  });

  test("matches _UserRefreshClient ENOTFOUND", () => {
    const stderr =
      "at _UserRefreshClient.refreshTokenNoCache (.../google-auth-library/...)\n" +
      "  caused by: ENOTFOUND oauth2.googleapis.com";
    expect(isGeminiTransientNetworkError("", stderr)).toBe(true);
  });

  test("does not match unrelated stderr", () => {
    expect(isGeminiTransientNetworkError("", "Some other error")).toBe(false);
  });

  test("does not match unknown-session errors (those go to isGeminiUnknownSessionError)", () => {
    expect(isGeminiTransientNetworkError("", "Error: unknown session 'abc-123'")).toBe(false);
  });
});
