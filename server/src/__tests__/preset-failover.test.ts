/**
 * preset-failover.ts 단위 테스트.
 *
 * DB는 mock으로 처리. 4종 시그널 시나리오 + flap 방지 + 복구 시나리오 검증.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

// agentPresetService mock
vi.mock("../services/agent-presets.js", () => ({
  agentPresetService: () => ({
    apply: vi.fn().mockResolvedValue({ appliedAgentIds: ["a1"], unmatched: [], total: 1, dryRun: false }),
  }),
}));

// issueService mock (보드 알림용)
vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    create: vi.fn().mockResolvedValue({ id: "issue-1", title: "mock" }),
  }),
}));

// logger mock
vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  evaluateFailoverOnRunFailed,
  evaluateRecovery,
  recordManualOverride,
  setFailoverEnabled,
  syncActivePresetName,
  _resetFailoverStateForTests,
  _getFailoverStateForTests,
} from "../services/preset-failover.js";

const COMPANY_ID = "test-company-1";

// agentPresets 테이블 조회 mock
function makeMockDb(opts: {
  claudePresetId?: string | null;
  codexPresetId?: string | null;
  agentCount?: number;
} = {}) {
  const { claudePresetId = "preset-claude", codexPresetId = "preset-codex", agentCount = 5 } = opts;

  const presets = [
    ...(claudePresetId ? [{ id: claudePresetId, name: "claude-default", companyId: COMPANY_ID, snapshot: [] }] : []),
    ...(codexPresetId ? [{ id: codexPresetId, name: "codex-fallback", companyId: COMPANY_ID, snapshot: [] }] : []),
  ];

  // 각 체인 호출을 추적해 `then` 시 적절한 결과 반환
  let callType: "preset" | "count" | "distinct" = "preset";

  const chain = {
    select: vi.fn().mockImplementation((fields?: unknown) => {
      // count() 쿼리 감지
      if (fields && typeof fields === "object" && "n" in (fields as Record<string, unknown>)) {
        callType = "count";
      } else {
        callType = "preset";
      }
      return chain;
    }),
    selectDistinct: vi.fn().mockImplementation(() => {
      callType = "distinct";
      return chain;
    }),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) => {
      if (callType === "count") {
        return Promise.resolve(cb([{ n: agentCount }]));
      }
      if (callType === "distinct") {
        return Promise.resolve(cb([{ companyId: COMPANY_ID }]));
      }
      return Promise.resolve(cb(presets));
    }),
  };

  return chain as unknown as import("@paperclipai/db").Db;
}

describe("evaluateFailoverOnRunFailed", () => {
  beforeEach(() => {
    _resetFailoverStateForTests(COMPANY_ID);
    setFailoverEnabled(COMPANY_ID, true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetFailoverStateForTests(COMPANY_ID);
    vi.useRealTimers();
  });

  it("quota_exhausted: claude 소진 → codex 프리셋 자동 스왑", async () => {
    const db = makeMockDb();
    // 현재 claude 프리셋 활성 상태로 설정
    syncActivePresetName(COMPANY_ID, "claude-default");

    await evaluateFailoverOnRunFailed(db, {
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-1",
      errorCode: "claude_transient_upstream",
      errorMessage: "usage limit reached",
      adapterType: "claude_local",
      claudeHealth: { usable: false, lastFailureKind: "quota_exhausted" },
    });

    const st = _getFailoverStateForTests(COMPANY_ID);
    expect(st?.activePresetName).toBe("codex-fallback");
    expect(st?.lastSwapDirection).toBe("claude_to_codex");
  });

  it("rate_limited: rate limit → codex 스왑", async () => {
    const db = makeMockDb();
    syncActivePresetName(COMPANY_ID, "claude-default");

    await evaluateFailoverOnRunFailed(db, {
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-2",
      errorCode: "claude_transient_upstream",
      errorMessage: "rate_limit_error too many requests",
      adapterType: "claude_local",
      claudeHealth: { usable: false, lastFailureKind: "rate_limited" },
    });

    const st = _getFailoverStateForTests(COMPANY_ID);
    expect(st?.activePresetName).toBe("codex-fallback");
  });

  it("auth_failed: 인증 오류 → codex 스왑", async () => {
    const db = makeMockDb();
    syncActivePresetName(COMPANY_ID, "claude-default");

    await evaluateFailoverOnRunFailed(db, {
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-3",
      errorCode: "claude_auth_required",
      errorMessage: "Not logged in",
      adapterType: "claude_local",
      claudeHealth: { usable: false, lastFailureKind: "auth_failed" },
    });

    const st = _getFailoverStateForTests(COMPANY_ID);
    expect(st?.activePresetName).toBe("codex-fallback");
  });

  it("cascading_failure: 연속 실패 → codex 스왑", async () => {
    const db = makeMockDb();
    syncActivePresetName(COMPANY_ID, "claude-default");

    await evaluateFailoverOnRunFailed(db, {
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-4",
      errorCode: null,
      errorMessage: "unknown failure",
      adapterType: "claude_local",
      claudeHealth: { usable: false, lastFailureKind: "cascading_failure" },
    });

    const st = _getFailoverStateForTests(COMPANY_ID);
    expect(st?.activePresetName).toBe("codex-fallback");
  });

  it("non-claude adapter는 처리하지 않음", async () => {
    const db = makeMockDb();
    syncActivePresetName(COMPANY_ID, "claude-default");

    await evaluateFailoverOnRunFailed(db, {
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-5",
      errorCode: null,
      errorMessage: "codex error",
      adapterType: "codex_local",
      claudeHealth: { usable: false },
    });

    const st = _getFailoverStateForTests(COMPANY_ID);
    // 스왑 발생하지 않음 — activePresetName은 그대로 claude-default
    expect(st?.activePresetName).toBe("claude-default");
    expect(st?.lastSwapDirection).toBeNull();
  });

  it("flap 방지: 5분 cooldown 내 같은 방향 스왑 차단", async () => {
    const db = makeMockDb();
    syncActivePresetName(COMPANY_ID, "claude-default");

    // 첫 번째 스왑
    await evaluateFailoverOnRunFailed(db, {
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-6",
      errorCode: "claude_transient_upstream",
      errorMessage: "usage limit reached",
      adapterType: "claude_local",
      claudeHealth: { usable: false, lastFailureKind: "quota_exhausted" },
    });

    expect(_getFailoverStateForTests(COMPANY_ID)?.activePresetName).toBe("codex-fallback");

    // codex 활성이지만 claude도 usable 아님 → 재스왑 시도 (claude_to_codex 방향)
    // activePresetName이 이미 codex-fallback이므로 스왑 자체가 발생하지 않음 (조건 미충족)
    // 별도 테스트: lastSwapAt 직후 claude로 복귀 시도 → cooldown 차단
    _resetFailoverStateForTests(COMPANY_ID);
    syncActivePresetName(COMPANY_ID, "codex-fallback");
    // lastSwapAt을 직전으로 설정하기 위해 state를 조작
    const st = _getFailoverStateForTests(COMPANY_ID)!;
    // @ts-expect-error - 테스트 전용 직접 접근
    st.lastSwapAt = new Date();
    // @ts-expect-error
    st.lastSwapDirection = "codex_to_claude";

    // 4분 경과 (cooldown 5분 미만)
    vi.advanceTimersByTime(4 * 60 * 1000);

    // 같은 방향(codex→claude) 스왑 시도 — 차단돼야 함
    await evaluateRecovery(db, COMPANY_ID, { usable: true });
    // activePresetName이 여전히 codex-fallback
    expect(_getFailoverStateForTests(COMPANY_ID)?.activePresetName).toBe("codex-fallback");
  });

  it("manualOverride 24h 중 자동 스왑 비활성", async () => {
    const db = makeMockDb();
    syncActivePresetName(COMPANY_ID, "claude-default");
    recordManualOverride(COMPANY_ID);

    await evaluateFailoverOnRunFailed(db, {
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-7",
      errorCode: "claude_transient_upstream",
      errorMessage: "usage limit reached",
      adapterType: "claude_local",
      claudeHealth: { usable: false, lastFailureKind: "quota_exhausted" },
    });

    // 스왑 발생 안 함
    expect(_getFailoverStateForTests(COMPANY_ID)?.activePresetName).toBe("claude-default");
  });

  it("failoverEnabled=false 시 스왑 비활성", async () => {
    const db = makeMockDb();
    syncActivePresetName(COMPANY_ID, "claude-default");
    setFailoverEnabled(COMPANY_ID, false);

    await evaluateFailoverOnRunFailed(db, {
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-8",
      errorCode: "claude_transient_upstream",
      errorMessage: "usage limit reached",
      adapterType: "claude_local",
      claudeHealth: { usable: false, lastFailureKind: "quota_exhausted" },
    });

    expect(_getFailoverStateForTests(COMPANY_ID)?.activePresetName).toBe("claude-default");
  });
});

describe("evaluateRecovery", () => {
  beforeEach(() => {
    _resetFailoverStateForTests(COMPANY_ID);
    setFailoverEnabled(COMPANY_ID, true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetFailoverStateForTests(COMPANY_ID);
    vi.useRealTimers();
  });

  it("codex 가동 중 claude 복구 → claude 복귀", async () => {
    const db = makeMockDb({ agentCount: 5 });
    syncActivePresetName(COMPANY_ID, "codex-fallback");
    // cooldown 없이 즉시 복귀 가능하도록 lastSwapAt 설정 안 함

    await evaluateRecovery(db, COMPANY_ID, { usable: true });

    const st = _getFailoverStateForTests(COMPANY_ID);
    expect(st?.activePresetName).toBe("claude-default");
    expect(st?.lastSwapDirection).toBe("codex_to_claude");
  });

  it("현재 claude 프리셋 중이면 복귀 스킵", async () => {
    const db = makeMockDb();
    syncActivePresetName(COMPANY_ID, "claude-default");

    await evaluateRecovery(db, COMPANY_ID, { usable: true });
    // 스왑이 발생하지 않아야 함 — lastSwapDirection 없음
    expect(_getFailoverStateForTests(COMPANY_ID)?.lastSwapDirection).toBeNull();
    expect(_getFailoverStateForTests(COMPANY_ID)?.activePresetName).toBe("claude-default");
  });
});
