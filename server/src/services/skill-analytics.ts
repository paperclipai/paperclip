import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companySkillUsageEvents,
  companySkills,
} from "@paperclipai/db";
import {
  badRequest,
} from "../errors.js";
import type {
  CompanySkillTopUsageItem,
  CompanySkillUsageByAgent,
  CompanySkillUsageDetail,
  SkillUsageEventKind,
  SkillUsageWindow,
} from "@paperclipai/shared";

type SkillUsageMetric = "loaded" | "invoked";

const WINDOW_DAYS: Record<SkillUsageWindow, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

const SKILL_USAGE_DEFAULT_WINDOW: SkillUsageWindow = "30d";
const SKILL_USAGE_DEFAULT_LIMIT = 100;
const SKILL_USAGE_MAX_LIMIT = 500;

export type SkillUsageWindowInput = {
  window?: SkillUsageWindow;
  since?: Date;
  until?: Date;
  limit?: number;
  metric?: SkillUsageMetric;
};

type SkillUsageRange = {
  window: SkillUsageWindow;
  since: Date;
  until: Date;
};

type BoundedSkillUsageRange = SkillUsageRange & {
  limit: number;
  metric: SkillUsageMetric;
};

type UsageAggregateRow = {
  date: string;
  eventKind: SkillUsageEventKind;
  count: number | string | bigint;
  agentId: string;
  agentName: string;
  lastUsedAt: string;
};

type ParsedCount = number | string | bigint | null | undefined;

type SkillUsageDetailAggregate = {
  totals: { loadCount: number; invocationCount: number; };
  daily: Array<{ date: string; loadCount: number; invocationCount: number; }>;
  topAgents: CompanySkillUsageByAgent[];
  lastUsedAt: Date | null;
};

function parseUsageCount(value: ParsedCount): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function parseOptionalDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseSkillUsageWindow(raw: unknown): SkillUsageWindow {
  if (raw == null || raw === "") return SKILL_USAGE_DEFAULT_WINDOW;
  if (raw !== "7d" && raw !== "30d" && raw !== "90d") {
    throw badRequest("invalid 'window' value");
  }
  return raw;
}

export function parseSkillUsageLimit(raw: unknown) {
  const parsed = raw == null || raw === "" ? SKILL_USAGE_DEFAULT_LIMIT : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > SKILL_USAGE_MAX_LIMIT) {
    throw badRequest("invalid 'limit' value");
  }
  return parsed;
}

export function parseSkillUsageMetric(raw: unknown): SkillUsageMetric {
  if (raw == null || raw === "") return "loaded";
  if (raw === "loaded" || raw === "invoked") return raw;
  throw badRequest("invalid 'metric' value");
}

export function resolveUsageRange(input: {
  window?: SkillUsageWindow;
  since?: Date;
  until?: Date;
  now?: Date;
}): SkillUsageRange {
  const until = input.until ?? input.now ?? new Date();
  const window = parseSkillUsageWindow(input.window);
  const windowDays = WINDOW_DAYS[window];
  const since = input.since ?? new Date(until.getTime() - windowDays * 24 * 60 * 60 * 1000);
  if (since > until) {
    throw badRequest("invalid 'window' range");
  }
  return { window, since, until };
}

function parseUsageRange(input: SkillUsageWindowInput): BoundedSkillUsageRange {
  const boundedWindow = resolveUsageRange({
    window: input.window,
    since: input.since,
    until: input.until,
  });
  const limit = parseSkillUsageLimit(input.limit);
  const metric = parseSkillUsageMetric(input.metric);
  return {
    ...boundedWindow,
    limit,
    metric,
  };
}

export function aggregateSkillUsageRows(
  rows: readonly UsageAggregateRow[],
): SkillUsageDetailAggregate {
  const buckets = new Map<string, { loadCount: number; invocationCount: number }>();
  const byAgent = new Map<string, {
    agentName: string;
    loadCount: number;
    invocationCount: number;
    lastUsedAt: Date;
  }>();

  let totalLoad = 0;
  let totalInvocations = 0;

  for (const row of rows) {
    const count = parseUsageCount(row.count);
    const isLoaded = row.eventKind === "loaded";

    const bucket = buckets.get(row.date) ?? { loadCount: 0, invocationCount: 0 };
    if (isLoaded) {
      bucket.loadCount += count;
      totalLoad += count;
    } else {
      bucket.invocationCount += count;
      totalInvocations += count;
    }
    buckets.set(row.date, bucket);

    const rowLastUsedAt = parseOptionalDate(row.lastUsedAt) ?? new Date(0);
    const agent = byAgent.get(row.agentId);
    if (agent) {
      if (isLoaded) agent.loadCount += count;
      else agent.invocationCount += count;
      if (agent.lastUsedAt < rowLastUsedAt) {
        agent.lastUsedAt = rowLastUsedAt;
      }
      continue;
    }

    byAgent.set(row.agentId, {
      agentName: row.agentName,
      loadCount: isLoaded ? count : 0,
      invocationCount: isLoaded ? 0 : count,
      lastUsedAt: rowLastUsedAt,
    });
  }

  const daily = Array.from(buckets.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, bucket]) => ({
      date,
      loadCount: bucket.loadCount,
      invocationCount: bucket.invocationCount,
    }));

  const topAgents = Array.from(byAgent.entries())
    .map(([agentId, summary]) => ({
      agentId,
      agentName: summary.agentName,
      totals: {
        loadCount: summary.loadCount,
        invocationCount: summary.invocationCount,
      },
      lastUsedAt: summary.lastUsedAt,
    }))
    .sort((left, right) => {
      const leftTotal = left.totals.loadCount + left.totals.invocationCount;
      const rightTotal = right.totals.loadCount + right.totals.invocationCount;
      if (leftTotal !== rightTotal) return rightTotal - leftTotal;
      return right.lastUsedAt.getTime() - left.lastUsedAt.getTime();
    });

  return {
    totals: {
      loadCount: totalLoad,
      invocationCount: totalInvocations,
    },
    daily,
    topAgents,
    lastUsedAt: topAgents[0]?.lastUsedAt ?? null,
  };
}

export function skillAnalyticsService(db: Db) {
  const loadedCount = sql<number>`count(*) FILTER (WHERE ${companySkillUsageEvents.eventKind} = 'loaded')::int`;
  const invokedCount = sql<number>`count(*) FILTER (WHERE ${companySkillUsageEvents.eventKind} = 'invoked')::int`;
  const uniqueAgents = sql<number>`count(DISTINCT ${companySkillUsageEvents.agentId})::int`;
  const lastUsedAtExpr = sql<Date>`max(${companySkillUsageEvents.createdAt})`;

  return {
    topUsedSkills: async (
      companyId: string,
      input: SkillUsageWindowInput = {},
    ): Promise<
      Array<
        CompanySkillTopUsageItem & {
          uses: number;
          invocations: number;
          uniqueAgents: number;
        }
      >
    > => {
      const { since, until, limit, metric, window } = parseUsageRange(input);
      const metricExpr = metric === "loaded" ? loadedCount : invokedCount;

      const rows = await db
        .select({
          skillId: companySkillUsageEvents.skillId,
          skillKey: companySkillUsageEvents.skillKey,
          name: companySkills.name,
          slug: companySkills.slug,
          uses: loadedCount,
          invocations: invokedCount,
          uniqueAgents,
          lastUsedAt: lastUsedAtExpr,
        })
        .from(companySkillUsageEvents)
        .leftJoin(companySkills, eq(companySkills.id, companySkillUsageEvents.skillId))
        .where(
          and(
            eq(companySkillUsageEvents.companyId, companyId),
            gte(companySkillUsageEvents.createdAt, since),
            lte(companySkillUsageEvents.createdAt, until),
          ),
        )
        .groupBy(
          companySkillUsageEvents.skillId,
          companySkillUsageEvents.skillKey,
          companySkills.name,
          companySkills.slug,
        )
        .orderBy(desc(metricExpr), desc(lastUsedAtExpr))
        .limit(limit);

      return rows.map((row) => {
        const loadCount = parseUsageCount(row.uses);
        const invocationCount = parseUsageCount(row.invocations);
        return {
          skillId: row.skillId,
          skillKey: row.skillKey,
          name: row.name ?? null,
          slug: row.slug ?? null,
          window,
          agentCount: Number(row.uniqueAgents),
          lastUsedAt: parseOptionalDate(row.lastUsedAt),
          totals: { loadCount, invocationCount },
          uses: loadCount,
          invocations: invocationCount,
          uniqueAgents: Number(row.uniqueAgents),
        };
      });
    },

    // Aggregates usage totals scoped to an explicit skill id/key set. Listed
    // skills must be enriched through this instead of `topUsedSkills`: a
    // global top-N ranking can crowd a listed skill out entirely (unlisted or
    // bundled usage above it, or the limit cap), which would zero-fill a
    // skill that has real usage.
    usageTotalsForSkills: async (
      companyId: string,
      input: {
        skillIds?: readonly string[];
        skillKeys?: readonly string[];
      } & Omit<SkillUsageWindowInput, "limit" | "metric">,
    ): Promise<Array<{
      skillId: string | null;
      skillKey: string;
      totals: { loadCount: number; invocationCount: number };
    }>> => {
      const { since, until } = resolveUsageRange(input);
      const skillIds = Array.from(new Set((input.skillIds ?? []).filter((id) => id.trim().length > 0)));
      const skillKeys = Array.from(new Set((input.skillKeys ?? []).filter((key) => key.trim().length > 0)));
      if (skillIds.length === 0 && skillKeys.length === 0) return [];

      const rows = await db
        .select({
          skillId: companySkillUsageEvents.skillId,
          skillKey: companySkillUsageEvents.skillKey,
          uses: loadedCount,
          invocations: invokedCount,
        })
        .from(companySkillUsageEvents)
        .where(
          and(
            eq(companySkillUsageEvents.companyId, companyId),
            gte(companySkillUsageEvents.createdAt, since),
            lte(companySkillUsageEvents.createdAt, until),
            or(
              skillIds.length > 0 ? inArray(companySkillUsageEvents.skillId, skillIds) : undefined,
              skillKeys.length > 0 ? inArray(companySkillUsageEvents.skillKey, skillKeys) : undefined,
            ),
          ),
        )
        .groupBy(companySkillUsageEvents.skillId, companySkillUsageEvents.skillKey);

      return rows.map((row) => ({
        skillId: row.skillId,
        skillKey: row.skillKey,
        totals: {
          loadCount: parseUsageCount(row.uses),
          invocationCount: parseUsageCount(row.invocations),
        },
      }));
    },

    skillUsageDetail: async (
      companyId: string,
      skillId: string,
      input: Omit<SkillUsageWindowInput, "metric" | "limit"> = {},
    ): Promise<CompanySkillUsageDetail | null> => {
      const { since, until } = resolveUsageRange(input);

      const skill = await db
        .select({ id: companySkills.id, key: companySkills.key })
        .from(companySkills)
        .where(and(eq(companySkills.companyId, companyId), eq(companySkills.id, skillId)))
        .then((rows) => rows[0] ?? null);
      if (!skill) return null;

      const aggregateRows = (await db.execute(sql`
        SELECT
          to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
          e.event_kind AS event_kind,
          count(*)::bigint AS count,
          e.agent_id AS agent_id,
          a.name AS agent_name,
          max(e.created_at) AS last_used_at
        FROM ${companySkillUsageEvents} AS e
        INNER JOIN ${agents} AS a ON a.id = e.agent_id
        WHERE e.company_id = ${companyId}
          AND e.skill_id = ${skillId}
          AND e.created_at >= ${since.toISOString()}::timestamptz
          AND e.created_at <= ${until.toISOString()}::timestamptz
        GROUP BY date, event_kind, agent_id, agent_name
      `)) as unknown as Iterable<{
        date: string;
        event_kind: SkillUsageEventKind;
        count: number | string | bigint;
        agent_id: string;
        agent_name: string;
        last_used_at: string;
      }>;

      const aggregate = aggregateSkillUsageRows(Array.from(aggregateRows).map((row) => ({
        date: String(row.date),
        eventKind: row.event_kind,
        count: row.count,
        agentId: row.agent_id,
        agentName: row.agent_name,
        lastUsedAt: String(row.last_used_at),
      })));

      const window = parseSkillUsageWindow(input.window);

      return {
        skillId: skill.id,
        skillKey: skill.key,
        window,
        totals: aggregate.totals,
        daily: aggregate.daily,
        topAgents: aggregate.topAgents,
        lastUsedAt: aggregate.lastUsedAt,
      };
    },
  };
}
