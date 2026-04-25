import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";

// PMSA-15 / PMSA-11 §2.1 / §2.2: granular Claude quota error codes that we want to
// count separately so the cost dashboard can distinguish auth-token rejections
// (401) from upstream rate limits (429) from provider 5xx incidents.
const QUOTA_INCIDENT_ERROR_CODES = [
  "claude_quota_exhausted",
  "claude_rate_limited",
  "claude_provider_5xx",
] as const;

export type QuotaIncidentErrorCode =
  (typeof QUOTA_INCIDENT_ERROR_CODES)[number];

export interface QuotaIncidentAgentBreakdown {
  agentId: string;
  agentName: string | null;
  count: number;
  countByCode: Record<QuotaIncidentErrorCode, number>;
  lastAt: Date | null;
}

export interface QuotaIncidentsResult {
  windowMinutes: number;
  windowStart: Date;
  windowEnd: Date;
  total: number;
  totalByCode: Record<QuotaIncidentErrorCode, number>;
  oldestAt: Date | null;
  newestAt: Date | null;
  byAgent: QuotaIncidentAgentBreakdown[];
}

export const DEFAULT_QUOTA_INCIDENT_WINDOW_MINUTES = 30;
export const MAX_QUOTA_INCIDENT_WINDOW_MINUTES = 24 * 60;

function emptyCountByCode(): Record<QuotaIncidentErrorCode, number> {
  return {
    claude_quota_exhausted: 0,
    claude_rate_limited: 0,
    claude_provider_5xx: 0,
  };
}

export function clampQuotaIncidentWindowMinutes(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(Math.floor(value), MAX_QUOTA_INCIDENT_WINDOW_MINUTES);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, MAX_QUOTA_INCIDENT_WINDOW_MINUTES);
    }
  }
  return DEFAULT_QUOTA_INCIDENT_WINDOW_MINUTES;
}

/**
 * PMSA-15 / PMSA-11 §2.2: aggregate recent Claude quota-shaped incidents for a
 * company. The result is intentionally small and decision-ready for the costs
 * dashboard and the future board-notification watcher (Phase 3).
 */
export function quotaIncidentsService(db: Db) {
  return {
    async listRecent(
      companyId: string,
      options: { windowMinutes?: number; now?: Date } = {},
    ): Promise<QuotaIncidentsResult> {
      const windowMinutes = clampQuotaIncidentWindowMinutes(
        options.windowMinutes ?? DEFAULT_QUOTA_INCIDENT_WINDOW_MINUTES,
      );
      const windowEnd = options.now ?? new Date();
      const windowStart = new Date(
        windowEnd.getTime() - windowMinutes * 60 * 1000,
      );

      const rows = await db
        .select({
          agentId: heartbeatRuns.agentId,
          errorCode: heartbeatRuns.errorCode,
          finishedAt: heartbeatRuns.finishedAt,
          agentName: agents.name,
        })
        .from(heartbeatRuns)
        .leftJoin(agents, eq(agents.id, heartbeatRuns.agentId))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.errorCode, [...QUOTA_INCIDENT_ERROR_CODES]),
            gte(heartbeatRuns.finishedAt, windowStart),
          ),
        )
        .orderBy(desc(heartbeatRuns.finishedAt));

      const totalByCode = emptyCountByCode();
      const byAgentMap = new Map<string, QuotaIncidentAgentBreakdown>();
      let oldestAt: Date | null = null;
      let newestAt: Date | null = null;

      for (const row of rows) {
        const code = row.errorCode as QuotaIncidentErrorCode | null;
        if (!code || !QUOTA_INCIDENT_ERROR_CODES.includes(code)) continue;

        totalByCode[code] += 1;

        const finishedAt = row.finishedAt ?? null;
        if (finishedAt) {
          if (!newestAt || finishedAt > newestAt) newestAt = finishedAt;
          if (!oldestAt || finishedAt < oldestAt) oldestAt = finishedAt;
        }

        const existing = byAgentMap.get(row.agentId) ?? {
          agentId: row.agentId,
          agentName: row.agentName ?? null,
          count: 0,
          countByCode: emptyCountByCode(),
          lastAt: null,
        };
        existing.count += 1;
        existing.countByCode[code] += 1;
        if (finishedAt && (!existing.lastAt || finishedAt > existing.lastAt)) {
          existing.lastAt = finishedAt;
        }
        if (!existing.agentName && row.agentName) {
          existing.agentName = row.agentName;
        }
        byAgentMap.set(row.agentId, existing);
      }

      const byAgent = [...byAgentMap.values()].sort(
        (a, b) => b.count - a.count,
      );
      const total =
        totalByCode.claude_quota_exhausted +
        totalByCode.claude_rate_limited +
        totalByCode.claude_provider_5xx;

      return {
        windowMinutes,
        windowStart,
        windowEnd,
        total,
        totalByCode,
        oldestAt,
        newestAt,
        byAgent,
      };
    },
  };
}

export type QuotaIncidentsService = ReturnType<typeof quotaIncidentsService>;
