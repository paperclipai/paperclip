import { describe, expect, it } from "vitest";
import {
  classifyErrorClass,
  classifyFailureRetryability,
  shouldRetryProcessLoss,
  PROCESS_LOSS_CHAIN_CAP,
  type FailureErrorClass,
} from "../services/run-retry-policy.ts";

describe("classifyFailureRetryability (G3)", () => {
  const deterministic: FailureErrorClass[] = [
    "config",
    "auth",
    "unsupported-model",
    "missing-secret",
  ];
  for (const cls of deterministic) {
    it(`suppresses + blocks deterministic class '${cls}' after first failure`, () => {
      const c = classifyFailureRetryability("codex_local", "gpt-5.5", cls);
      expect(c.action).toBe("suppress-block");
      expect(c.retryable).toBe(false);
      expect(c.block).toBe(true);
      expect(c.errorClass).toBe(cls);
      expect(c.reason).toContain("codex_local:gpt-5.5");
    });
  }

  const cooldown: FailureErrorClass[] = ["quota", "rate-limit"];
  for (const cls of cooldown) {
    it(`defers cooldown class '${cls}' without blocking`, () => {
      const c = classifyFailureRetryability("claude_local", "claude-sonnet-4-6", cls);
      expect(c.action).toBe("defer");
      expect(c.retryable).toBe(false);
      expect(c.block).toBe(false);
      expect(c.errorClass).toBe(cls);
    });
  }

  const retryable: FailureErrorClass[] = ["transient", "process-lost", "unknown"];
  for (const cls of retryable) {
    it(`retries transient class '${cls}'`, () => {
      const c = classifyFailureRetryability("gemini_api", null, cls);
      expect(c.action).toBe("retry");
      expect(c.retryable).toBe(true);
      expect(c.block).toBe(false);
      // model omitted -> no model tag in reason
      expect(c.reason).toContain("gemini_api");
      expect(c.reason).not.toContain("gemini_api:");
    });
  }
});

describe("classifyErrorClass", () => {
  it.each([
    ["process_lost", null, "process-lost"],
    ["adapter_failed", "401 Unauthorized", "auth"],
    ["adapter_failed", "invalid api key", "auth"],
    ["adapter_failed", "insufficient_quota: billing hard limit", "quota"],
    ["adapter_failed", "429 Too Many Requests", "rate-limit"],
    ["adapter_failed", "model not allowed for this account", "unsupported-model"],
    ["adapter_failed", "missing secret OPENAI_API_KEY", "missing-secret"],
    ["adapter_failed", "command not found: codex", "config"],
    ["adapter_failed", "503 service temporarily unavailable", "transient"],
    ["adapter_failed", "ECONNRESET while streaming", "transient"],
    ["adapter_failed", "something weird happened", "unknown"],
  ] as Array<[string, string | null, FailureErrorClass]>)(
    "maps code=%s msg=%s -> %s",
    (code, msg, expected) => {
      expect(classifyErrorClass(code, msg)).toBe(expected);
    },
  );

  it("prefers explicit typed error codes over message heuristics", () => {
    expect(classifyErrorClass("unsupported_model", "looks like a quota error")).toBe(
      "unsupported-model",
    );
    expect(classifyErrorClass("missing_secret", "429 rate limited")).toBe("missing-secret");
  });
});

describe("shouldRetryProcessLoss (G1 reaper robustness)", () => {
  const base = {
    tracksLocalChild: true,
    processPid: null as number | null,
    processGroupId: null as number | null,
    startedAt: null as Date | null,
    processLossRetryCount: 0,
  };

  it("retries a run that has a persisted pid", () => {
    expect(shouldRetryProcessLoss({ ...base, processPid: 4242 })).toBe(true);
  });

  it("retries a run that has a persisted process group", () => {
    expect(shouldRetryProcessLoss({ ...base, processGroupId: 4242 })).toBe(true);
  });

  it("retries a pid-less run killed in the early-start window (startedAt set)", () => {
    // Simulated restart: a `running` run that began but whose pid/pgid was
    // never persisted before the process was lost.
    expect(
      shouldRetryProcessLoss({ ...base, processPid: null, processGroupId: null, startedAt: new Date() }),
    ).toBe(true);
  });

  it("does NOT retry a pid-less run that never started", () => {
    expect(shouldRetryProcessLoss({ ...base, startedAt: null })).toBe(false);
  });

  it("retries a pid-less started run EXACTLY once (bounded by processLossRetryCount)", () => {
    const firstAttempt = { ...base, startedAt: new Date(), processLossRetryCount: 0 };
    expect(shouldRetryProcessLoss(firstAttempt)).toBe(true);
    // After the single retry has been enqueued, the retry run carries count=1.
    const secondAttempt = { ...firstAttempt, processLossRetryCount: 1 };
    expect(shouldRetryProcessLoss(secondAttempt)).toBe(false);
  });

  it("never retries non-local-child adapters", () => {
    expect(
      shouldRetryProcessLoss({ ...base, tracksLocalChild: false, processPid: 4242 }),
    ).toBe(false);
    expect(
      shouldRetryProcessLoss({ ...base, tracksLocalChild: false, startedAt: new Date() }),
    ).toBe(false);
  });

  it("retries when chain count is below the ancestry cap", () => {
    const run = { ...base, processPid: 4242, processLossChainCount: PROCESS_LOSS_CHAIN_CAP - 1 };
    expect(shouldRetryProcessLoss(run)).toBe(true);
  });

  it("suppresses retry when chain count equals the ancestry cap", () => {
    const run = { ...base, processPid: 4242, processLossChainCount: PROCESS_LOSS_CHAIN_CAP };
    expect(shouldRetryProcessLoss(run)).toBe(false);
  });

  it("suppresses retry when chain count exceeds the ancestry cap", () => {
    const run = { ...base, processPid: 4242, processLossChainCount: PROCESS_LOSS_CHAIN_CAP + 2 };
    expect(shouldRetryProcessLoss(run)).toBe(false);
  });

  it("ancestry cap takes precedence over per-run count=0", () => {
    // Even if this run's own count is 0 (never retried), the chain cap prevents a new retry.
    const run = { ...base, processPid: 4242, processLossRetryCount: 0, processLossChainCount: PROCESS_LOSS_CHAIN_CAP };
    expect(shouldRetryProcessLoss(run)).toBe(false);
  });

  it("treats missing processLossChainCount as 0 (below cap)", () => {
    const run = { ...base, processPid: 4242 }; // processLossChainCount omitted
    expect(shouldRetryProcessLoss(run)).toBe(true);
  });

  it("treats null processLossChainCount as 0 (below cap)", () => {
    const run = { ...base, processPid: 4242, processLossChainCount: null };
    expect(shouldRetryProcessLoss(run)).toBe(true);
  });
});
