import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { responsibilities, responsibilityMetricReadings, responsibilityMetrics } from "@paperclipai/db";
import {
  RESPONSIBILITY_PRIMARY_METRIC_POSITION,
  defaultPrimaryDisplay,
  resolveResponsibilityMetricKind,
  type ResponsibilityMetricDisplay,
} from "@paperclipai/shared";

/**
 * Row-level helpers for responsibility metrics that both the responsibilities
 * service (which owns the bar and its reading) and the metrics service use.
 * They read and write only the metric tables, so either can call them inside
 * its own transaction without importing the other.
 *
 * The primary metric is the bar's own. Its history lives on a mirror row at
 * `RESPONSIBILITY_PRIMARY_METRIC_POSITION` whose title and unit match the
 * bar's metric. When the bar starts measuring something else, the old mirror
 * is archived (its readings stay with it) and the next reading starts a new
 * one. A mirror created only to carry readings has no creator; one an agent's
 * accepted proposal (or the owner) shaped carries who chose it.
 */

type ResponsibilityRow = typeof responsibilities.$inferSelect;
export type MetricRow = typeof responsibilityMetrics.$inferSelect;
export type MetricReadingRow = typeof responsibilityMetricReadings.$inferSelect;
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface MetricActor {
  agentId?: string | null;
  userId?: string | null;
}

/** The bar's metric as the mirror row stores it; null when the bar has no metric. */
export function primaryMirrorShape(row: Pick<ResponsibilityRow, "metricKind" | "metricName" | "metricUnit" | "metricTarget" | "metricDirection">) {
  const title = row.metricName?.trim();
  if (!title) return null;
  const kind = resolveResponsibilityMetricKind(row.metricKind, row.metricUnit);
  const usesTarget = kind === "volume" || kind === "percentage";
  return {
    kind,
    title,
    unit: kind === "percentage" ? "%" : kind === "yes_no" ? null : row.metricUnit?.trim() || null,
    target: usesTarget && row.metricTarget !== null ? Number(row.metricTarget) : null,
    direction: usesTarget ? (row.metricDirection as "at_least" | "at_most" | null) ?? "at_least" : null,
  };
}

/** True when the mirror row still measures what the bar measures. */
export function mirrorMatches(
  mirror: Pick<MetricRow, "title" | "unit">,
  shape: NonNullable<ReturnType<typeof primaryMirrorShape>>,
) {
  return mirror.title.trim().toLowerCase() === shape.title.toLowerCase() && (mirror.unit ?? null) === shape.unit;
}

/** Active metric rows of a responsibility, by position. */
export async function activeMetricRows(db: Executor, ref: { id: string; companyId: string }) {
  return db.select().from(responsibilityMetrics)
    .where(and(
      eq(responsibilityMetrics.responsibilityId, ref.id),
      eq(responsibilityMetrics.companyId, ref.companyId),
      eq(responsibilityMetrics.status, "active"),
    ))
    .orderBy(asc(responsibilityMetrics.position), asc(responsibilityMetrics.createdAt));
}

/** Archive the primary mirror (the bar now measures something else). */
export async function archivePrimaryMirror(db: Executor, ref: { id: string; companyId: string }) {
  await db.update(responsibilityMetrics)
    .set({ status: "archived", updatedAt: new Date() })
    .where(and(
      eq(responsibilityMetrics.responsibilityId, ref.id),
      eq(responsibilityMetrics.companyId, ref.companyId),
      eq(responsibilityMetrics.position, RESPONSIBILITY_PRIMARY_METRIC_POSITION),
      eq(responsibilityMetrics.status, "active"),
    ));
}

/**
 * The primary mirror for the bar as it is now, created when missing and
 * replaced when it measures something else. `shape` updates its display,
 * description and creator (an accepted proposal, or the owner). Null when the
 * bar has no metric.
 */
export async function ensurePrimaryMirror(
  db: Executor,
  row: ResponsibilityRow,
  shape: { display?: ResponsibilityMetricDisplay | null; description?: string | null; chosenBy?: MetricActor } = {},
): Promise<MetricRow | null> {
  const bar = primaryMirrorShape(row);
  if (!bar) return null;
  const existing = (await activeMetricRows(db, row)).filter((metric) => metric.position === RESPONSIBILITY_PRIMARY_METRIC_POSITION);
  const current = existing.find((metric) => mirrorMatches(metric, bar)) ?? null;
  const stale = existing.filter((metric) => metric !== current);
  if (stale.length > 0) {
    for (const metric of stale) {
      await db.update(responsibilityMetrics).set({ status: "archived", updatedAt: new Date() })
        .where(eq(responsibilityMetrics.id, metric.id));
    }
  }
  const now = new Date();
  const chosen = shape.chosenBy && (shape.chosenBy.agentId || shape.chosenBy.userId) ? shape.chosenBy : null;
  if (current) {
    const set: Partial<typeof responsibilityMetrics.$inferInsert> = { target: bar.target, direction: bar.direction, updatedAt: now };
    if (shape.display) set.display = shape.display;
    if (shape.description !== undefined) set.description = shape.description;
    if (chosen) {
      set.createdByAgentId = chosen.agentId ?? null;
      set.createdByUserId = chosen.userId ?? null;
    }
    const [updated] = await db.update(responsibilityMetrics).set(set).where(eq(responsibilityMetrics.id, current.id)).returning();
    return updated ?? current;
  }
  const [created] = await db.insert(responsibilityMetrics).values({
    companyId: row.companyId,
    responsibilityId: row.id,
    position: RESPONSIBILITY_PRIMARY_METRIC_POSITION,
    title: bar.title,
    description: shape.description ?? null,
    display: shape.display ?? defaultPrimaryDisplay(bar.kind, 0),
    unit: bar.unit,
    target: bar.target,
    direction: bar.direction,
    status: "active",
    createdByAgentId: chosen?.agentId ?? null,
    createdByUserId: chosen?.userId ?? null,
  }).returning();
  return created!;
}

/** Record a reading of the bar's metric in its history (the caller has already set `metricCurrent`). */
export async function recordPrimaryReading(
  db: Executor,
  row: ResponsibilityRow,
  input: { value: number; recordedAt: Date; actor: MetricActor; note?: string | null },
) {
  const mirror = await ensurePrimaryMirror(db, row);
  if (!mirror) return null;
  const [reading] = await db.insert(responsibilityMetricReadings).values({
    companyId: row.companyId,
    metricId: mirror.id,
    value: input.value,
    recordedAt: input.recordedAt,
    recordedByAgentId: input.actor.agentId ?? null,
    recordedByUserId: input.actor.userId ?? null,
    note: input.note ?? null,
  }).returning();
  return reading!;
}

/** Archive the supporting metrics (positions after the primary). */
export async function archiveSupportingMetrics(db: Executor, ref: { id: string; companyId: string }) {
  await db.update(responsibilityMetrics)
    .set({ status: "archived", updatedAt: new Date() })
    .where(and(
      eq(responsibilityMetrics.responsibilityId, ref.id),
      eq(responsibilityMetrics.companyId, ref.companyId),
      ne(responsibilityMetrics.position, RESPONSIBILITY_PRIMARY_METRIC_POSITION),
      eq(responsibilityMetrics.status, "active"),
    ));
}
