/**
 * Claude → Codex 자동 페일오버 오케스트레이터.
 *
 * claude-local 어댑터 헬스 상태를 읽고, 프리셋을 자동 적용한다.
 * - Claude 소진 감지 → codex 프리셋 자동 스왑
 * - Claude 복구 감지 → claude 프리셋 자동 복귀
 * - cooldown / manualOverride 보호장치 포함
 */

import { and, count, desc, eq, gte, inArray, like, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentPresets, agents, issues, projects } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { agentPresetService } from "./agent-presets.js";
import { issueService } from "./issues.js";

// ──────────────────────────────────────────────────────────────────────────────
// 상수
// ──────────────────────────────────────────────────────────────────────────────

const COOLDOWN_MS = 5 * 60 * 1000; // 5분: 같은 방향 연속 스왑 차단
const MANUAL_OVERRIDE_DURATION_MS = 24 * 60 * 60 * 1000; // 24h 수동 오버라이드
const CRITICAL_ESCALATE_COUNT = 3; // 24h 내 이 횟수 초과 시 critical

// 프리셋 이름 규칙 (회사가 이 이름으로 저장해야 함)
const PRESET_NAME_CLAUDE = "claude-default";
const PRESET_NAME_CODEX = "codex-fallback";

// 이슈 제목 접두사
const FAILOVER_ISSUE_PREFIX = "[자동 페일오버]";
const RECOVERY_ISSUE_PREFIX = "[자동 복구]";

// ──────────────────────────────────────────────────────────────────────────────
// 프로세스-레벨 상태 (서버 수명 동안 유지)
// ──────────────────────────────────────────────────────────────────────────────

interface FailoverState {
  activePresetName: string | null; // 현재 활성 프리셋 이름
  lastSwapAt: Date | null;
  lastSwapDirection: "claude_to_codex" | "codex_to_claude" | null;
  manualOverrideUntil: Date | null; // 수동 스왑 후 자동 중지
  failoverEnabled: boolean;
}

const _state: Record<string, FailoverState> = {};

function getState(companyId: string): FailoverState {
  if (!_state[companyId]) {
    _state[companyId] = {
      activePresetName: null,
      lastSwapAt: null,
      lastSwapDirection: null,
      manualOverrideUntil: null,
      failoverEnabled: true,
    };
  }
  return _state[companyId]!;
}

// ──────────────────────────────────────────────────────────────────────────────
// 헬퍼
// ──────────────────────────────────────────────────────────────────────────────

async function findPresetByName(db: Db, companyId: string, name: string) {
  return db
    .select()
    .from(agentPresets)
    .where(and(eq(agentPresets.companyId, companyId), eq(agentPresets.name, name)))
    .then((rows) => rows[0] ?? null);
}

async function claudeAgentCount(db: Db, companyId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
        like(agents.adapterType, "claude%"),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

async function findSystemRoutineProjectId(db: Db, companyId: string): Promise<string | null> {
  const row = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.companyId, companyId),
        like(projects.name, "%시스템 루틴%"),
      ),
    )
    .then((r) => r[0] ?? null);
  return row?.id ?? null;
}

/** 24h 내 [자동 페일오버] 이슈 발생 횟수 */
async function recentFailoverIssueCount(db: Db, companyId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ n: count() })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        like(issues.title, `${FAILOVER_ISSUE_PREFIX}%`),
        gte(issues.createdAt, since),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

async function postNotificationIssue(
  db: Db,
  companyId: string,
  title: string,
  description: string,
  priority: "medium" | "critical",
): Promise<void> {
  try {
    const projectId = await findSystemRoutineProjectId(db, companyId);
    const issuesSvc = issueService(db);
    await issuesSvc.create(companyId, {
      title,
      description,
      status: "done",
      priority,
      projectId: projectId ?? undefined,
      hiddenAt: priority === "medium" ? new Date() : null,
    });
  } catch (err) {
    logger.warn({ err, companyId }, "preset-failover: 알림 이슈 생성 실패");
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 공개 API
// ──────────────────────────────────────────────────────────────────────────────

export interface AdapterHealthInput {
  usable: boolean;
  lastFailureKind?: string | null;
}

/**
 * 수동 스왑 기록 — 24h 자동 페일오버 비활성.
 * 프리셋 apply route에서 호출.
 */
export function recordManualOverride(companyId: string): void {
  const st = getState(companyId);
  st.manualOverrideUntil = new Date(Date.now() + MANUAL_OVERRIDE_DURATION_MS);
  logger.info({ companyId }, "preset-failover: 수동 오버라이드 기록 (24h 자동 비활성)");
}

/**
 * 자동 페일오버 활성화 여부 설정.
 */
export function setFailoverEnabled(companyId: string, enabled: boolean): void {
  getState(companyId).failoverEnabled = enabled;
}

/**
 * 현재 활성 프리셋 이름을 동기화.
 * 프리셋 apply 완료 후 호출.
 */
export function syncActivePresetName(companyId: string, presetName: string): void {
  getState(companyId).activePresetName = presetName;
}

/**
 * Run 완료 후 페일오버 평가.
 * heartbeat.ts의 publishRunLifecyclePluginEvent에서 agent.run.failed 시 호출.
 */
export async function evaluateFailoverOnRunFailed(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    errorCode: string | null | undefined;
    errorMessage: string | null | undefined;
    adapterType: string;
    claudeHealth: AdapterHealthInput;
  },
): Promise<void> {
  // claude_local 에이전트 실패만 처리
  if (!input.adapterType.startsWith("claude")) return;

  const st = getState(input.companyId);

  if (!st.failoverEnabled) return;

  // 수동 오버라이드 기간 중이면 자동 스왑 금지
  if (st.manualOverrideUntil && st.manualOverrideUntil > new Date()) {
    logger.debug({ companyId: input.companyId }, "preset-failover: 수동 오버라이드 기간 — 스킵");
    return;
  }

  await evaluateFailover(db, input.companyId, input.claudeHealth);
}

/**
 * 5분 복구 ping 후 평가.
 * Claude API가 복구되었으면 claude 프리셋으로 복귀.
 */
export async function evaluateRecovery(
  db: Db,
  companyId: string,
  claudeHealth: AdapterHealthInput,
): Promise<void> {
  const st = getState(companyId);
  if (!st.failoverEnabled) return;
  if (st.manualOverrideUntil && st.manualOverrideUntil > new Date()) return;
  if (st.activePresetName !== PRESET_NAME_CODEX) return;

  if (claudeHealth.usable) {
    await evaluateFailover(db, companyId, claudeHealth);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 내부 페일오버 로직
// ──────────────────────────────────────────────────────────────────────────────

async function evaluateFailover(
  db: Db,
  companyId: string,
  claudeHealth: AdapterHealthInput,
): Promise<void> {
  const st = getState(companyId);
  const now = new Date();

  // cooldown: 5분 내 같은 방향 스왑 차단
  const cooldownActive = st.lastSwapAt && now.getTime() - st.lastSwapAt.getTime() < COOLDOWN_MS;

  const activePreset = st.activePresetName;
  const claudeUsable = claudeHealth.usable;

  // ── claude 소진 → codex 스왑 ──────────────────────────────────────────────
  if (!claudeUsable && activePreset !== PRESET_NAME_CODEX) {
    if (cooldownActive && st.lastSwapDirection === "claude_to_codex") {
      logger.debug({ companyId }, "preset-failover: cooldown 중 — claude→codex 스왑 스킵");
      return;
    }

    const codexPreset = await findPresetByName(db, companyId, PRESET_NAME_CODEX);
    if (!codexPreset) {
      logger.warn(
        { companyId, presetName: PRESET_NAME_CODEX },
        "preset-failover: codex 프리셋 없음 — 페일오버 불가",
      );
      return;
    }

    const presets = agentPresetService(db);
    try {
      await presets.apply(companyId, codexPreset.id);
    } catch (err) {
      logger.error({ err, companyId }, "preset-failover: codex 프리셋 적용 실패");
      return;
    }

    st.activePresetName = PRESET_NAME_CODEX;
    st.lastSwapAt = now;
    st.lastSwapDirection = "claude_to_codex";

    const failureKind = claudeHealth.lastFailureKind ?? "unknown";
    const recentCount = await recentFailoverIssueCount(db, companyId);
    const isCritical = recentCount >= CRITICAL_ESCALATE_COUNT;

    logger.info(
      { companyId, failureKind, recentCount, isCritical },
      "preset-failover: Claude→Codex 자동 스왑 완료",
    );

    await postNotificationIssue(
      db,
      companyId,
      `${FAILOVER_ISSUE_PREFIX} Claude → Codex`,
      [
        `## 자동 페일오버 발생`,
        ``,
        `- **원인**: ${failureKind}`,
        `- **시각**: ${now.toISOString()}`,
        `- **24h 누적**: ${recentCount + 1}회`,
        isCritical ? `\n> ⚠️ 24h 내 ${recentCount + 1}회 발생 — CEO 확인 필요` : "",
      ].join("\n"),
      isCritical ? "critical" : "medium",
    );

    return;
  }

  // ── codex 가동 중 + claude 복구 → claude 복귀 ─────────────────────────────
  if (claudeUsable && activePreset === PRESET_NAME_CODEX) {
    if (cooldownActive && st.lastSwapDirection === "codex_to_claude") {
      logger.debug({ companyId }, "preset-failover: cooldown 중 — codex→claude 복귀 스킵");
      return;
    }

    // 이전 스왑이 자동으로 일어난 경우에만 자동 복귀
    // (수동 오버라이드로 codex를 선택했다면 activePresetName이 null이거나 수동 설정)
    const claudePreset = await findPresetByName(db, companyId, PRESET_NAME_CLAUDE);
    if (!claudePreset) {
      logger.warn(
        { companyId, presetName: PRESET_NAME_CLAUDE },
        "preset-failover: claude 프리셋 없음 — 복귀 불가",
      );
      return;
    }

    // Claude 에이전트가 실제로 있는지 확인 (Codex 전용 회사 제외)
    const claudeCount = await claudeAgentCount(db, companyId);
    if (claudeCount === 0) {
      logger.info({ companyId }, "preset-failover: claude 에이전트 없음 — 복귀 스킵");
      return;
    }

    const presets = agentPresetService(db);
    try {
      await presets.apply(companyId, claudePreset.id);
    } catch (err) {
      logger.error({ err, companyId }, "preset-failover: claude 프리셋 적용 실패");
      return;
    }

    st.activePresetName = PRESET_NAME_CLAUDE;
    st.lastSwapAt = now;
    st.lastSwapDirection = "codex_to_claude";

    logger.info({ companyId }, "preset-failover: Codex→Claude 자동 복귀 완료");

    await postNotificationIssue(
      db,
      companyId,
      `${RECOVERY_ISSUE_PREFIX} Codex → Claude`,
      [
        `## 자동 복구 발생`,
        ``,
        `- **시각**: ${now.toISOString()}`,
        `- Claude 가용성 복구 감지 → claude-default 프리셋 복귀`,
      ].join("\n"),
      "medium",
    );
  }
}

/** 테스트 전용: 상태 초기화 */
export function _resetFailoverStateForTests(companyId: string): void {
  delete _state[companyId];
}

/** 테스트 전용: 현재 상태 조회 */
export function _getFailoverStateForTests(companyId: string): FailoverState | undefined {
  return _state[companyId];
}
