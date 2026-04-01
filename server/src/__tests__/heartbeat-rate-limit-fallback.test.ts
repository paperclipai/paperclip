import { describe, expect, it } from "vitest";
import {
  buildRateLimitFallbackConfig,
  resolveRateLimitFallbackTarget,
  shouldUseRateLimitFallback,
  stripAdapterSessionState,
} from "../services/heartbeat.js";

describe("heartbeat rate-limit fallback helpers", () => {
  it("resolves claude -> codex fallback config", () => {
    expect(
      resolveRateLimitFallbackTarget("claude_local", {
        rateLimitFallback: {
          adapterType: "codex_local",
          adapterConfig: { model: "gpt-5.4" },
        },
      }),
    ).toEqual({
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });
  });

  it("ignores fallback config for non-claude adapters", () => {
    expect(
      resolveRateLimitFallbackTarget("codex_local", {
        rateLimitFallback: { adapterType: "codex_local" },
      }),
    ).toBeNull();
  });

  it("retries only when the primary result is rate limited", () => {
    const fallback = { adapterType: "codex_local", adapterConfig: {} };

    expect(
      shouldUseRateLimitFallback(
        { errorCode: "claude_rate_limited", timedOut: false, exitCode: 1 },
        fallback,
      ),
    ).toBe(true);
    expect(
      shouldUseRateLimitFallback(
        { errorCode: "claude_auth_required", timedOut: false, exitCode: 1 },
        fallback,
      ),
    ).toBe(false);
    expect(
      shouldUseRateLimitFallback(
        { errorCode: "claude_rate_limited", timedOut: true, exitCode: 1 },
        fallback,
      ),
    ).toBe(false);
    expect(
      shouldUseRateLimitFallback(
        {
          errorCode: null,
          errorMessage: "Claude run failed: subtype=success: You're out of extra usage · resets Apr 4, 3am (Asia/Jerusalem)",
          resultJson: {
            result: "You're out of extra usage · resets Apr 4, 3am (Asia/Jerusalem)",
          },
          timedOut: false,
          exitCode: 1,
        },
        fallback,
      ),
    ).toBe(true);
  });

  it("strips incompatible session state from fallback adapter results", () => {
    expect(
      stripAdapterSessionState({
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "codex-thread-1",
        sessionDisplayId: "codex-thread-1",
        sessionParams: { sessionId: "codex-thread-1", cwd: "C:\\work" },
        clearSession: true,
        summary: "done",
      }),
    ).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: null,
      sessionDisplayId: null,
      sessionParams: null,
      clearSession: false,
      summary: "done",
    });
  });

  it("builds fallback config from portable shared settings instead of reusing claude-only command fields", () => {
    expect(
      buildRateLimitFallbackConfig(
        {
          command: "claude",
          promptTemplate: "Continue",
          bootstrapPromptTemplate: "Boot",
          instructionsFilePath: "C:\\agents\\AGENTS.md",
          cwd: "C:\\repo",
          env: { PAPERCLIP_TEST: "1" },
          timeoutSec: 30,
          graceSec: 15,
          effort: "max",
          maxTurnsPerRun: 300,
          chrome: true,
          extraArgs: ["--verbose"],
          paperclipRuntimeSkills: [{ key: "paperclip" }],
        },
        {
          adapterType: "codex_local",
          adapterConfig: {
            model: "gpt-5.4",
          },
        },
      ),
    ).toEqual({
      promptTemplate: "Continue",
      bootstrapPromptTemplate: "Boot",
      instructionsFilePath: "C:\\agents\\AGENTS.md",
      cwd: "C:\\repo",
      env: { PAPERCLIP_TEST: "1" },
      timeoutSec: 30,
      graceSec: 15,
      paperclipRuntimeSkills: [{ key: "paperclip" }],
      model: "gpt-5.4",
    });
  });
});
