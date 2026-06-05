/**
 * 프로세스-레벨 in-memory Claude 어댑터 헬스 트래커.
 *
 * 4종 실패 시그널을 기록하고 `isClaudeUsable()` 판단을 제공한다.
 * `preset-failover.ts`가 이 상태를 읽어 자동 스왑을 결정한다.
 */

export type ClaudeFailureKind =
  | "quota_exhausted"
  | "rate_limited"
  | "auth_failed"
  | "cascading_failure";

const CASCADING_FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5분
const CASCADING_FAILURE_THRESHOLD = 3;

interface FailureRecord {
  runId: string;
  kind: ClaudeFailureKind;
  message: string;
  recordedAt: Date;
}

interface ClaudeHealthState {
  lastFailureKind: ClaudeFailureKind | null;
  consecutiveFailures: number;
  nextRetryAt: Date | null;
  recentFailures: FailureRecord[];
  lastSuccessAt: Date | null;
}

// 싱글톤 상태 — 어댑터 process 수명 동안 유지
const state: ClaudeHealthState = {
  lastFailureKind: null,
  consecutiveFailures: 0,
  nextRetryAt: null,
  recentFailures: [],
  lastSuccessAt: null,
};

function pruneOldRecords(): void {
  const cutoff = Date.now() - CASCADING_FAILURE_WINDOW_MS;
  state.recentFailures = state.recentFailures.filter(
    (r) => r.recordedAt.getTime() >= cutoff,
  );
}

function classifyKind(errorCode: string | null | undefined, errorMessage: string): ClaudeFailureKind {
  const code = errorCode ?? "";
  const msg = errorMessage.toLowerCase();

  // 세션/토큰 소진: usage limit, quota, 5h/weekly
  if (
    code === "claude_transient_upstream" &&
    /usage.limit|quota|5[-\s]?hour|weekly.limit|usage.cap|out.of.extra.usage/.test(msg)
  ) {
    return "quota_exhausted";
  }

  // rate limit / 429
  if (
    code === "claude_transient_upstream" &&
    /rate.limit|too.many.request|429|throttl/.test(msg)
  ) {
    return "rate_limited";
  }

  // 인증 실패
  if (
    code === "claude_auth_required" ||
    /invalid.api.key|expired.session|auth.*fail|unauthorized|not.logged.in|authentication.required/.test(msg)
  ) {
    return "auth_failed";
  }

  return "cascading_failure";
}

export function recordFailure(input: {
  runId: string;
  errorCode: string | null | undefined;
  errorMessage: string;
  retryNotBefore?: string | null;
}): void {
  pruneOldRecords();
  const kind = classifyKind(input.errorCode, input.errorMessage);
  const now = new Date();

  state.lastFailureKind = kind;
  state.consecutiveFailures += 1;
  state.recentFailures.push({
    runId: input.runId,
    kind,
    message: input.errorMessage,
    recordedAt: now,
  });

  if (kind === "rate_limited" && input.retryNotBefore) {
    const parsed = new Date(input.retryNotBefore);
    if (!Number.isNaN(parsed.getTime())) {
      state.nextRetryAt = parsed;
    }
  } else if (kind === "quota_exhausted") {
    // 세션 소진: 다음 retry는 외부에서 판단 (복구 ping으로 확인)
    state.nextRetryAt = null;
  }
}

export function recordSuccess(): void {
  state.lastSuccessAt = new Date();
  state.consecutiveFailures = 0;
  state.lastFailureKind = null;
  state.nextRetryAt = null;
  // recentFailures는 유지 (윈도우 기반 통계용)
}

export function isClaudeUsable(): boolean {
  // rate limit cooldown 아직 남아있으면 사용 불가
  if (state.nextRetryAt && state.nextRetryAt > new Date()) {
    return false;
  }

  // 최근 5분 내 3회 이상 연속 실패 = cascading failure
  pruneOldRecords();
  if (state.recentFailures.length >= CASCADING_FAILURE_THRESHOLD) {
    return false;
  }

  // quota_exhausted / auth_failed 상태면 즉시 불가
  if (state.lastFailureKind === "quota_exhausted" || state.lastFailureKind === "auth_failed") {
    return false;
  }

  return true;
}

export function getHealthSnapshot(): Readonly<{
  lastFailureKind: ClaudeFailureKind | null;
  consecutiveFailures: number;
  nextRetryAt: Date | null;
  recentFailureCount: number;
  lastSuccessAt: Date | null;
  usable: boolean;
}> {
  pruneOldRecords();
  return {
    lastFailureKind: state.lastFailureKind,
    consecutiveFailures: state.consecutiveFailures,
    nextRetryAt: state.nextRetryAt,
    recentFailureCount: state.recentFailures.length,
    lastSuccessAt: state.lastSuccessAt,
    usable: isClaudeUsable(),
  };
}

/** 테스트 전용: 상태 초기화 */
export function _resetHealthStateForTests(): void {
  state.lastFailureKind = null;
  state.consecutiveFailures = 0;
  state.nextRetryAt = null;
  state.recentFailures = [];
  state.lastSuccessAt = null;
}
