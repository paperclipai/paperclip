import { describe, expect, it } from "vitest";
import {
  classifyTerminalAdapterFailure,
  isTerminalAdapterFailureFamily,
} from "./terminal-adapter-failure.js";

describe("classifyTerminalAdapterFailure", () => {
  it("classifies HTTP 402 Insufficient Balance as billing_402", () => {
    expect(
      classifyTerminalAdapterFailure({
        errorMessage: "HTTP 402: Insufficient Balance — payment required",
      }),
    ).toEqual({ family: "billing_402", errorCode: "billing_402" });
  });

  it("classifies wallet/credit exhaustion as billing_402", () => {
    expect(
      classifyTerminalAdapterFailure({
        errorMessage: "Provider wallet exhausted; out of credits",
      })?.family,
    ).toBe("billing_402");
  });

  it("does not treat usage-limit / session-cap cues as billing_402", () => {
    expect(
      classifyTerminalAdapterFailure({
        errorCode: "adapter_failed",
        errorMessage: "You've hit your usage limit for GPT-5. Try again at 4:30 PM.",
      }),
    ).toBeNull();
    expect(
      classifyTerminalAdapterFailure({
        errorFamily: "provider_quota",
        errorMessage: "You've hit your session limit - resets at 4pm (America/Chicago).",
      }),
    ).toBeNull();
  });

  it("prefers billing_402 over provider_quota when both cues appear", () => {
    expect(
      classifyTerminalAdapterFailure({
        errorFamily: "provider_quota",
        errorCode: "provider_quota",
        errorMessage: "HTTP 402 Insufficient Balance while checking quota",
      }),
    ).toEqual({ family: "billing_402", errorCode: "billing_402" });
  });

  it("classifies explicit errorFamily auth_key", () => {
    expect(
      classifyTerminalAdapterFailure({
        errorFamily: "auth_key",
        errorMessage: "anything",
      }),
    ).toEqual({ family: "auth_key", errorCode: "auth_key" });
  });

  it("classifies invalid/expired API key cues as auth_key", () => {
    expect(
      classifyTerminalAdapterFailure({
        errorMessage: "invalid API key for provider",
      })?.family,
    ).toBe("auth_key");
    expect(
      classifyTerminalAdapterFailure({
        errorMessage: "missing required env OPENAI_API_KEY",
      })?.family,
    ).toBe("auth_key");
  });

  it("classifies EACCES on credential paths as auth_eacces", () => {
    expect(
      classifyTerminalAdapterFailure({
        errorMessage: "EACCES: permission denied, open '/home/agent/.config/opencode/credentials.json'",
      }),
    ).toEqual({ family: "auth_eacces", errorCode: "auth_eacces" });
  });

  it("does not treat generic spawn ENOENT as terminal auth", () => {
    expect(
      classifyTerminalAdapterFailure({
        errorMessage: "spawn opencode ENOENT",
      }),
    ).toBeNull();
  });

  it("reads cues from resultJson stderr/stdout snippets", () => {
    expect(
      classifyTerminalAdapterFailure({
        errorCode: "adapter_failed",
        resultJson: {
          stderr: "Error: HTTP 402 Payment Required",
          stdout: "",
        },
      })?.family,
    ).toBe("billing_402");
  });

  it("precedence: billing_402 > auth_eacces > auth_key", () => {
    expect(
      classifyTerminalAdapterFailure({
        errorMessage: "HTTP 402 Insufficient Balance; also EACCES on api key file; invalid API key",
      })?.family,
    ).toBe("billing_402");
    expect(
      classifyTerminalAdapterFailure({
        errorMessage: "EACCES permission denied reading API key credentials; invalid API key",
      })?.family,
    ).toBe("auth_eacces");
  });
});

describe("isTerminalAdapterFailureFamily", () => {
  it("accepts only the terminal set", () => {
    expect(isTerminalAdapterFailureFamily("billing_402")).toBe(true);
    expect(isTerminalAdapterFailureFamily("auth_key")).toBe(true);
    expect(isTerminalAdapterFailureFamily("auth_eacces")).toBe(true);
    expect(isTerminalAdapterFailureFamily("provider_quota")).toBe(false);
    expect(isTerminalAdapterFailureFamily(null)).toBe(false);
  });
});
