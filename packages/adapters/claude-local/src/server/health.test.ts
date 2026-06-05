import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordFailure,
  recordSuccess,
  isClaudeUsable,
  getHealthSnapshot,
  _resetHealthStateForTests,
} from "./health.js";

describe("claude-local health tracker", () => {
  beforeEach(() => {
    _resetHealthStateForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetHealthStateForTests();
    vi.useRealTimers();
  });

  describe("시그널 분류", () => {
    it("quota_exhausted: usage limit 시그널 감지", () => {
      recordFailure({
        runId: "r1",
        errorCode: "claude_transient_upstream",
        errorMessage: "Claude usage limit reached — resets at ...",
      });
      const snap = getHealthSnapshot();
      expect(snap.lastFailureKind).toBe("quota_exhausted");
      expect(snap.usable).toBe(false);
    });

    it("quota_exhausted: 5-hour limit 시그널 감지", () => {
      recordFailure({
        runId: "r2",
        errorCode: "claude_transient_upstream",
        errorMessage: "5-hour limit reached",
      });
      expect(getHealthSnapshot().lastFailureKind).toBe("quota_exhausted");
    });

    it("rate_limited: 429 / rate-limit 시그널 감지", () => {
      recordFailure({
        runId: "r3",
        errorCode: "claude_transient_upstream",
        errorMessage: "rate_limit_error: too many requests",
        retryNotBefore: new Date(Date.now() + 60_000).toISOString(),
      });
      const snap = getHealthSnapshot();
      expect(snap.lastFailureKind).toBe("rate_limited");
      expect(snap.nextRetryAt).not.toBeNull();
      expect(snap.usable).toBe(false);
    });

    it("auth_failed: 인증 오류 시그널 감지", () => {
      recordFailure({
        runId: "r4",
        errorCode: "claude_auth_required",
        errorMessage: "Not logged in. Please run `claude login`.",
      });
      const snap = getHealthSnapshot();
      expect(snap.lastFailureKind).toBe("auth_failed");
      expect(snap.usable).toBe(false);
    });

    it("cascading_failure: 5분 내 3회 연속 실패", () => {
      recordFailure({ runId: "a", errorCode: null, errorMessage: "unknown error" });
      recordFailure({ runId: "b", errorCode: null, errorMessage: "unknown error" });
      recordFailure({ runId: "c", errorCode: null, errorMessage: "unknown error" });
      const snap = getHealthSnapshot();
      expect(snap.usable).toBe(false);
    });
  });

  describe("isClaudeUsable", () => {
    it("실패 없으면 usable", () => {
      expect(isClaudeUsable()).toBe(true);
    });

    it("rate_limited + retryNotBefore 기간 중 불가", () => {
      const future = new Date(Date.now() + 300_000);
      recordFailure({
        runId: "x",
        errorCode: "claude_transient_upstream",
        errorMessage: "rate_limit_error",
        retryNotBefore: future.toISOString(),
      });
      expect(isClaudeUsable()).toBe(false);
    });

    it("rate_limited + retryNotBefore 지나면 usable", () => {
      const past = new Date(Date.now() - 1_000);
      recordFailure({
        runId: "x",
        errorCode: "claude_transient_upstream",
        errorMessage: "rate_limit_error",
        retryNotBefore: past.toISOString(),
      });
      expect(isClaudeUsable()).toBe(true);
    });

    it("recordSuccess 후 usable 복구", () => {
      recordFailure({
        runId: "r5",
        errorCode: "claude_transient_upstream",
        errorMessage: "usage limit reached",
      });
      expect(isClaudeUsable()).toBe(false);
      recordSuccess();
      expect(isClaudeUsable()).toBe(true);
      expect(getHealthSnapshot().consecutiveFailures).toBe(0);
    });
  });

  describe("flap 방지: 5분 창 슬라이딩", () => {
    it("5분 경과 후 recentFailures 만료", () => {
      recordFailure({ runId: "a", errorCode: null, errorMessage: "err" });
      recordFailure({ runId: "b", errorCode: null, errorMessage: "err" });
      recordFailure({ runId: "c", errorCode: null, errorMessage: "err" });
      expect(getHealthSnapshot().recentFailureCount).toBe(3);
      expect(isClaudeUsable()).toBe(false);

      // 5분 + 1ms 이동
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      expect(getHealthSnapshot().recentFailureCount).toBe(0);
      expect(isClaudeUsable()).toBe(true);
    });
  });
});
