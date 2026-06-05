/**
 * Claude 복구 감지 5분 폴러.
 *
 * Paperclip 서버 시작 시 `startClaudeRecoveryPoller(db)` 를 호출하면,
 * 5분마다 Claude API를 ping하여 usable 상태가 복구되었는지 확인하고
 * `evaluateRecovery`를 호출한다.
 *
 * codex-fallback 프리셋이 활성 상태일 때만 ping을 전송한다.
 */

import type { Db } from "@paperclipai/db";
import { eq, ne, like } from "drizzle-orm";
import { agents } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { evaluateRecovery } from "./preset-failover.js";
import {
  getHealthSnapshot,
  recordSuccess,
  fetchWithTimeout,
  readClaudeToken,
} from "@paperclipai/adapter-claude-local/server";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5분
const PING_TIMEOUT_MS = 8_000;

let _pollerHandle: ReturnType<typeof setInterval> | null = null;

/** Claude API minimal ping — 성공 여부만 반환 */
async function pingClaudeApi(): Promise<boolean> {
  try {
    const token = await readClaudeToken();
    if (token) {
      // OAuth 토큰: usage 엔드포인트 ping
      const resp = await fetchWithTimeout(
        "https://api.anthropic.com/api/oauth/usage",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
          },
        },
        PING_TIMEOUT_MS,
      );
      return resp.ok;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (apiKey) {
      // API key: 최소 메시지 요청
      const resp = await fetchWithTimeout(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
        },
        PING_TIMEOUT_MS,
      );
      // 429 = rate limited but API reachable; 200 = OK; 401 = auth error
      return resp.status !== 401 && resp.status !== 403;
    }

    // 인증 정보 없으면 ping 불가 → health 판단 불가
    return false;
  } catch {
    return false;
  }
}

async function pollOnce(db: Db): Promise<void> {
  // codex 프리셋 활성 회사만 처리 (adapterType 집계로 간접 판단)
  let companiesWithCodex: string[];
  try {
    const rows = await db
      .selectDistinct({ companyId: agents.companyId })
      .from(agents)
      .where(
        // codex 에이전트가 있는 회사 = 이전에 failover 됐을 가능성
        like(agents.adapterType, "codex%"),
      );
    companiesWithCodex = rows.map((r) => r.companyId);
  } catch (err) {
    logger.warn({ err }, "preset-failover-recovery: 회사 목록 조회 실패");
    return;
  }

  if (companiesWithCodex.length === 0) return;

  const health = getHealthSnapshot();

  // 이미 usable이면 ping 불필요
  if (health.usable) {
    for (const companyId of companiesWithCodex) {
      await evaluateRecovery(db, companyId, { usable: true, lastFailureKind: health.lastFailureKind }).catch(
        (err) => logger.warn({ err, companyId }, "preset-failover-recovery: 복귀 평가 실패"),
      );
    }
    return;
  }

  logger.debug("preset-failover-recovery: Claude API ping 시작");
  const reachable = await pingClaudeApi();

  if (reachable) {
    recordSuccess();
    logger.info("preset-failover-recovery: Claude API 복구 확인 — 복귀 평가");
    for (const companyId of companiesWithCodex) {
      await evaluateRecovery(db, companyId, { usable: true }).catch(
        (err) => logger.warn({ err, companyId }, "preset-failover-recovery: 복귀 평가 실패"),
      );
    }
  } else {
    logger.debug("preset-failover-recovery: Claude API 여전히 비응답");
  }
}

/**
 * Paperclip 서버 시작 시 호출.
 * 이미 실행 중이면 두 번 시작하지 않는다.
 */
export function startClaudeRecoveryPoller(db: Db): void {
  if (_pollerHandle !== null) return;
  _pollerHandle = setInterval(() => {
    pollOnce(db).catch((err) => {
      logger.warn({ err }, "preset-failover-recovery: 폴 중 예외 (무시)");
    });
  }, POLL_INTERVAL_MS);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "preset-failover-recovery: Claude 복구 폴러 시작");
}

export function stopClaudeRecoveryPoller(): void {
  if (_pollerHandle !== null) {
    clearInterval(_pollerHandle);
    _pollerHandle = null;
    logger.info("preset-failover-recovery: Claude 복구 폴러 중지");
  }
}
