import { describe, expect, it } from "vitest";
import { classifyOpenCodeFailure } from "./execute.js";

// Every string here was taken verbatim from a real failed run in a local
// Paperclip instance. Before classification existed all of them landed as an
// unclassified `adapter_failed`, which is why none of them ever earned a retry.
describe("classifyOpenCodeFailure", () => {
  it("classifies provider exhaustion as retryable quota", () => {
    for (const message of [
      "Insufficient Balance",
      "Internal error: You've hit your session limit · resets 6:50pm (America/Cuiaba)",
      "Error: 402 Payment Required",
    ]) {
      expect(classifyOpenCodeFailure(message)).toEqual({
        errorCode: "provider_quota",
        errorFamily: "provider_quota",
      });
    }
  });

  it("classifies credential and opt-in faults as configuration, never retryable", () => {
    for (const message of [
      "OpenAI API key is missing. Pass it using the 'apiKey' parameter or the OPENAI_API_KEY environment variable.",
      "The latest version of this model is only available hosted in China and requires explicit opt in",
    ]) {
      expect(classifyOpenCodeFailure(message)).toEqual({
        errorCode: "configuration_incomplete",
        errorFamily: null,
      });
    }
  });

  it("classifies a gateway giving up on the upstream as retryable", () => {
    for (const message of [
      // Verbatim from a real OpenRouter failure that killed a 410KB run.
      '{"code":504,"message":"Upstream idle timeout exceeded","metadata":{"error_type":"timeout"}}',
      "Error: 502 Bad Gateway",
      "503 Service Unavailable",
      "socket hang up",
      "read ECONNRESET",
    ]) {
      expect(classifyOpenCodeFailure(message)).toEqual({
        errorCode: "opencode_transient_upstream",
        errorFamily: "transient_upstream",
      });
    }
  });

  it("keeps a credential fault out of the transient bucket", () => {
    // 401 must not be retried as a flaky gateway just because it is an HTTP code.
    expect(classifyOpenCodeFailure("401 Unauthorized")).toEqual({
      errorCode: "configuration_incomplete",
      errorFamily: null,
    });
  });

  it("leaves an ordinary failure unclassified", () => {
    expect(classifyOpenCodeFailure("OpenCode exited with code 1")).toBeNull();
    expect(classifyOpenCodeFailure("")).toBeNull();
    expect(classifyOpenCodeFailure(null)).toBeNull();
  });
});
