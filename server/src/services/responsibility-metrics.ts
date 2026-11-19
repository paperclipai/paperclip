import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { responsibilities, responsibilityMetricReadings, responsibilityMetrics } from "@paperclipai/db";
import {
  RESPONSIBILITY_AUTOMATION_RECENT_DAYS,
  RESPONSIBILITY_METRIC_HISTORY_LIMIT,
  RESPONSIBILITY_METRIC_SET_LIMIT,
  RESPONSIBILITY_METRIC_STALE_DAYS,
  RESPONSIBILITY_PRIMARY_METRIC_POSITION,
  RESPONSIBILITY_STARTER_WEEKS,
  RESPONSIBILITY_SUPPORTING_METRIC_LIMIT,
  chooseStarterMetrics,
  defaultPrimaryDisplay,
  normalizeResponsibilityMetricDefinition,
  normalizeResponsibilityReading,
  primaryDisplaysFor,
  responsibilityMetricDisplaysFor,
  responsibilityMetricReadingIssue,
  responsibilityReadingIssue,
  weeklyCounts,
  type ProposeResponsibilityBarPayload,
  type RecordResponsibilityMetricReading,
  type ResponsibilityMetricDefinition,
  type ResponsibilityMetricDirection,
  type ResponsibilityMetricDisplay,
  type ResponsibilityMetricPoint,
  type ResponsibilityMetricSet,
  type ResponsibilityMetricView,
  type ResponsibilityStarterChoice,
  type ResponsibilityWithRollup,
  type SetResponsibilityMetrics,
} from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { responsibilitiesDisabledError } from "./responsibilities-disabled.js";
import { instanceSettingsService } from "./instance-settings.js";
import { responsibilityService, type DbTransaction, type ResponsibilityReadScope } from "./responsibilities.js";
import { responsibilityAutomationService } from "./responsibility-automation.js";
import {
  activeMetricRows,
  archiveSupportingMetrics,
  ensurePrimaryMirror,
  mirrorMatches,
  primaryMirrorShape,
  type MetricActor,
  type MetricReadingRow,
  type MetricRow,
} from "./responsibility-metric-store.js";

type ResponsibilityRow = typeof responsibilities.$inferSelect;
type Executor = Db | DbTransaction;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Two readings this close in time are the same reading (the bar's own and its history row). */
const SAME_READING_MS = 1_000;

export type MetricRecorder =
  | { type: "board"; userId: string }
  | { type: "agent"; agentId: string; scope: ResponsibilityReadScope };

function toPoint(row: Pick<MetricReadingRow, "id" | "value" | "recordedAt" | "recordedByAgentId" | "recordedByUserId">): ResponsibilityMetricPoint {
  return {
    id: row.id,
    value: Number(row.value),
    recordedAt: new Date(row.recordedAt).toISOString(),
    recordedByAgentId: row.recordedByAgentId,
    recordedByUserId: row.recordedByUserId,
  };
}

function computedPoint(value: number, at: Date): ResponsibilityMetricPoint {
  return { id: null, value, recordedAt: at.toISOString(), recordedByAgentId: null, recordedByUserId: null };
}

function isStale(latest: ResponsibilityMetricPoint | null, now: Date) {
  return latest !== null && now.getTime() - new Date(latest.recordedAt).getTime() > RESPONSIBILITY_METRIC_STALE_DAYS * DAY_MS;
}

/** A chosen set: any supporting metric, or a primary someone shaped. */
function isChosen(rows: readonly MetricRow[]) {
  return rows.some((row) => row.position !== RESPONSIBILITY_PRIMARY_METRIC_POSITION || row.createdByAgentId || row.createdByUserId);
}

/**
 * The bar's metric with its history: the mirror's readings, plus the bar's
 * own reading when the history does not have it yet (readings from before
 * there was history).
 */
export function primaryReadings(
  row: Pick<ResponsibilityRow, "metricCurrent" | "metricUpdatedAt">,
  history: readonly ResponsibilityMetricPoint[],
  limit = RESPONSIBILITY_METRIC_HISTORY_LIMIT,
): ResponsibilityMetricPoint[] {
  const points = [...history];
  if (row.metricCurrent !== null && row.metricUpdatedAt) {
    const at = new Date(row.metricUpdatedAt).getTime();
    const newest = points.at(-1);
    if (!newest || new Date(newest.recordedAt).getTime() < at - SAME_READING_MS) {
      points.push(computedPoint(Number(row.metricCurrent), new Date(row.metricUpdatedAt)));
    }
  }
  return points.slice(-limit);
}

/**
 * A responsibility's metric set (experimental, `enableResponsibilities`): the
 * read the bar module draws, recording readings, the owner setting or
 * removing supporting metrics, and applying the set an agent proposed with a
 * bar. The bar and its reading belong to the responsibilities service; the
 * metric rows to this module (the row-level helpers both share are in
 * responsibility-metric-store.ts). Starters are computed on read, never stored.
 */
export function responsibilityMetricService(db: Db) {
  const settings = instanceSettingsService(db);
  const responsibilitiesSvc = responsibilityService(db);

  async function assertEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableResponsibilities !== true) throw responsibilitiesDisabledError();
  }

  /** The newest readings of each metric, oldest first, at most `limit` each. */
  async function historyFor(executor: Executor, metricIds: readonly string[], limit = RESPONSIBILITY_METRIC_HISTORY_LIMIT) {
    const byMetric = new Map<string, ResponsibilityMetricPoint[]>();
    await Promise.all(metricIds.map(async (metricId) => {
      const rows = await executor.select().from(responsibilityMetricReadings)
        .where(eq(responsibilityMetricReadings.metricId, metricId))
        .orderBy(desc(responsibilityMetricReadings.recordedAt), desc(responsibilityMetricReadings.createdAt))
        .limit(limit);
      byMetric.set(metricId, rows.reverse().map(toPoint));
    }));
    return byMetric;
  }

  function primaryView(
    row: ResponsibilityRow,
    rollup: ResponsibilityWithRollup["rollup"],
    readings: ResponsibilityMetricPoint[],
    shape: { display: ResponsibilityMetricDisplay; description: string | null; starter: boolean },
    now: Date,
  ): ResponsibilityMetricView | null {
    const metric = rollup.metric;
    if (!metric) return null;
    const latest = readings.at(-1) ?? null;
    return {
      key: shape.starter ? "starter:bar_metric" : "primary",
      id: null,
      role: "primary",
      starter: shape.starter ? "bar_metric" : null,
      title: metric.name,
      description: shape.description ?? metric.statusRule,
      display: shape.display,
      unit: metric.unit,
      target: metric.target,
      direction: metric.direction,
      kind: metric.kind,
      low: metric.low,
      high: metric.high,
      latest,
      readings,
      period: shape.display === "bar" ? "week" : null,
      stale: metric.stale || isStale(latest, now),
      note: null,
      health: rollup.health,
    };
  }

  function supportingView(metric: MetricRow, readings: ResponsibilityMetricPoint[], now: Date): ResponsibilityMetricView {
    const latest = readings.at(-1) ?? null;
    const display = metric.display as ResponsibilityMetricDisplay;
    return {
      key: metric.id,
      id: metric.id,
      role: "supporting",
      starter: null,
      title: metric.title,
      description: metric.description,
      display,
      unit: display === "percent" ? "%" : metric.unit,
      target: metric.target === null ? null : Number(metric.target),
      direction: (metric.direction as ResponsibilityMetricDirection | null) ?? null,
      kind: null,
      low: null,
      high: null,
      latest,
      readings,
      period: display === "bar" ? "week" : null,
      stale: isStale(latest, now),
      note: null,
      health: null,
    };
  }

  /** The starters other than the bar's metric, from the work under it. */
  function starterView(
    choice: ResponsibilityStarterChoice,
    facts: { finished: { start: Date; count: number }[]; openTasks: number; blockedTasks: number; automationShare: number | null },
    now: Date,
  ): ResponsibilityMetricView | null {
    const base = {
      key: `starter:${choice.key}`,
      id: null,
      role: "supporting" as const,
      starter: choice.key,
      display: choice.display,
      target: null,
      direction: null,
      kind: null,
      low: null,
      high: null,
      stale: false,
      health: null,
    };
    switch (choice.key) {
      case "tasks_finished": {
        const readings = facts.finished.map((bucket) => computedPoint(bucket.count, bucket.start));
        return {
          ...base,
          title: "Tasks finished per week",
          description: `Tasks under this responsibility marked done, per week, over the last ${RESPONSIBILITY_STARTER_WEEKS} weeks.`,
          unit: null,
          latest: readings.at(-1) ?? null,
          readings,
          period: "week",
          note: null,
        };
      }
      case "open_tasks": {
        const latest = computedPoint(facts.openTasks, now);
        return {
          ...base,
          title: "Open tasks",
          description: "Tasks under this responsibility that are not done or cancelled, counted now.",
          unit: null,
          latest,
          readings: [latest],
          period: null,
          note: facts.blockedTasks > 0 ? `${facts.blockedTasks} blocked` : null,
        };
      }
      case "automation_share": {
        if (facts.automationShare === null) return null;
        const latest = computedPoint(Math.round(facts.automationShare * 100), now);
        return {
          ...base,
          title: "Work that runs on routines",
          description: `Running routines as a share of running routines and the tasks done by hand in the last ${RESPONSIBILITY_AUTOMATION_RECENT_DAYS} days.`,
          unit: "%",
          latest,
          readings: [latest],
          period: null,
          note: null,
        };
      }
      case "bar_metric":
        return null;
    }
  }

  async function automationShareFor(row: ResponsibilityRow, scope: ResponsibilityReadScope, now: Date) {
    if (row.status !== "active") return null;
    const overview = await responsibilityAutomationService(db, { responsibilities: responsibilitiesSvc })
      .overview(row.companyId, row.ownerUserId, { scope, now });
    return overview.responsibilities.find((item) => item.responsibilityId === row.id)?.share ?? null;
  }

  async function read(row: ResponsibilityRow, scope: ResponsibilityReadScope, now = new Date()): Promise<ResponsibilityMetricSet> {
    const [withRollup, rows] = await Promise.all([responsibilitiesSvc.withRollup(row, scope), activeMetricRows(db, row)]);
    const { rollup } = withRollup;
    const bar = primaryMirrorShape(row);
    const mirror = bar
      ? rows.find((metric) => metric.position === RESPONSIBILITY_PRIMARY_METRIC_POSITION && mirrorMatches(metric, bar)) ?? null
      : null;
    const supporting = rows
      .filter((metric) => metric.position !== RESPONSIBILITY_PRIMARY_METRIC_POSITION)
      .slice(0, RESPONSIBILITY_SUPPORTING_METRIC_LIMIT);
    const history = await historyFor(db, [...(mirror ? [mirror.id] : []), ...supporting.map((metric) => metric.id)]);
    const primaryHistory = primaryReadings(row, mirror ? history.get(mirror.id) ?? [] : []);
    const chosenRows = [...(mirror ? [mirror] : []), ...supporting];

    if (isChosen(chosenRows)) {
      const display = mirror && bar && primaryDisplaysFor(bar.kind).includes(mirror.display as ResponsibilityMetricDisplay)
        ? mirror.display as ResponsibilityMetricDisplay
        : bar ? defaultPrimaryDisplay(bar.kind, primaryHistory.length) : "number";
      const primary = primaryView(row, rollup, primaryHistory, { display, description: mirror?.description ?? null, starter: false }, now);
      const chooser = [...supporting, ...(mirror ? [mirror] : [])].find((metric) => metric.createdByAgentId || metric.createdByUserId);
      return {
        responsibilityId: row.id,
        source: "chosen",
        chosenBy: chooser ? { agentId: chooser.createdByAgentId, userId: chooser.createdByUserId } : null,
        metrics: [
          ...(primary ? [primary] : []),
          ...supporting.map((metric) => supportingView(metric, history.get(metric.id) ?? [], now)),
        ].slice(0, RESPONSIBILITY_METRIC_SET_LIMIT),
        historyLimit: RESPONSIBILITY_METRIC_HISTORY_LIMIT,
      };
    }

    const since = new Date(now.getTime() - RESPONSIBILITY_STARTER_WEEKS * WEEK_MS);
    const [finishedTimes, automationShare] = await Promise.all([
      responsibilitiesSvc.finishedTaskTimes(row, scope, since),
      automationShareFor(row, scope, now),
    ]);
    const finished = weeklyCounts(finishedTimes, now);
    const choices = chooseStarterMetrics({
      primary: rollup.metric ? { kind: rollup.metric.kind, readings: primaryHistory.length } : null,
      finishedByWeek: finished.map((bucket) => bucket.count),
      openTasks: rollup.openTasks,
      blockedTasks: rollup.blockedTasks,
      automationShare,
    });
    const facts = { finished, openTasks: rollup.openTasks, blockedTasks: rollup.blockedTasks, automationShare };
    const metrics = choices.flatMap((choice) => {
      const view = choice.key === "bar_metric"
        ? primaryView(row, rollup, primaryHistory, { display: choice.display, description: null, starter: true }, now)
        : starterView(choice, facts, now);
      return view ? [view] : [];
    });
    return {
      responsibilityId: row.id,
      source: "starter",
      chosenBy: null,
      metrics,
      historyLimit: RESPONSIBILITY_METRIC_HISTORY_LIMIT,
    };
  }

  /** Insert supporting metrics at positions after the primary, with their starting readings. */
  async function insertSupporting(
    tx: Executor,
    row: ResponsibilityRow,
    definitions: readonly ResponsibilityMetricDefinition[],
    chosenBy: MetricActor,
  ) {
    for (const [index, definition] of definitions.slice(0, RESPONSIBILITY_SUPPORTING_METRIC_LIMIT).entries()) {
      const [metric] = await tx.insert(responsibilityMetrics).values({
        companyId: row.companyId,
        responsibilityId: row.id,
        position: RESPONSIBILITY_PRIMARY_METRIC_POSITION + 1 + index,
        title: definition.title,
        description: definition.description,
        display: definition.display,
        unit: definition.unit,
        target: definition.target,
        direction: definition.direction,
        status: "active",
        createdByAgentId: chosenBy.agentId ?? null,
        createdByUserId: chosenBy.userId ?? null,
      }).returning();
      if (definition.readings.length > 0) {
        await tx.insert(responsibilityMetricReadings).values(definition.readings.map((reading) => ({
          companyId: row.companyId,
          metricId: metric!.id,
          value: reading.value,
          recordedAt: new Date(reading.recordedAt),
          recordedByAgentId: chosenBy.agentId ?? null,
          recordedByUserId: chosenBy.userId ?? null,
          note: definition.readingsEvidence,
        })));
      }
    }
  }

  async function lockRow(tx: DbTransaction, ref: { id: string; companyId: string }) {
    const [row] = await tx.select().from(responsibilities)
      .where(and(eq(responsibilities.id, ref.id), eq(responsibilities.companyId, ref.companyId)))
      .for("update");
    if (!row) throw notFound("Responsibility not found");
    return row;
  }

  async function supportingMetric(executor: Executor, row: ResponsibilityRow, metricId: string) {
    if (!UUID.test(metricId)) throw notFound("Metric not found");
    const [metric] = await executor.select().from(responsibilityMetrics).where(and(
      eq(responsibilityMetrics.id, metricId),
      eq(responsibilityMetrics.responsibilityId, row.id),
      eq(responsibilityMetrics.companyId, row.companyId),
      eq(responsibilityMetrics.status, "active"),
    ));
    if (!metric || metric.position === RESPONSIBILITY_PRIMARY_METRIC_POSITION) throw notFound("Metric not found");
    return metric;
  }

  return {
    assertEnabled,
    read,

    /**
     * Inside the bar-accept transaction: apply the metric set a proposal
     * carries. Its supporting metrics replace the ones there (when it carries
     * any list, even an empty one), and the primary takes its display and is
     * marked as chosen by the agent. Nothing happens for a proposal without a
     * set (made before metric sets, or keeping the set as it is).
     */
    async applyProposalInTx(
      tx: DbTransaction,
      after: ResponsibilityRow,
      payload: Pick<ProposeResponsibilityBarPayload, "metrics" | "primaryDisplay">,
      chosenBy: MetricActor,
    ): Promise<{ applied: boolean; supporting: number }> {
      const metrics = payload.metrics ?? null;
      const primaryDisplay = payload.primaryDisplay ?? null;
      if (metrics === null && primaryDisplay === null) return { applied: false, supporting: 0 };
      if (metrics !== null) {
        await archiveSupportingMetrics(tx, after);
        await insertSupporting(tx, after, metrics, chosenBy);
      }
      await ensurePrimaryMirror(tx, after, { display: primaryDisplay, chosenBy });
      return { applied: true, supporting: metrics?.length ?? 0 };
    },

    /** The owner sets the supporting metrics (replacing any) and how the primary is drawn. */
    async setChosen(row: ResponsibilityRow, input: SetResponsibilityMetrics, actor: { userId: string }) {
      await assertEnabled();
      const primaryDisplay = input.primaryDisplay ?? null;
      const bar = primaryMirrorShape(row);
      if (primaryDisplay && bar && !primaryDisplaysFor(bar.kind).includes(primaryDisplay)) {
        throw unprocessable(`This bar's metric can be drawn as ${primaryDisplaysFor(bar.kind).join(", ")}`);
      }
      const definitions = input.metrics.map(normalizeResponsibilityMetricDefinition);
      const titles = new Set<string>(bar ? [bar.title.toLowerCase()] : []);
      for (const definition of definitions) {
        const title = definition.title.toLowerCase();
        if (titles.has(title)) throw unprocessable("Each metric measures something different: a title repeats the bar's metric or another metric");
        titles.add(title);
      }
      await db.transaction(async (tx) => {
        const locked = await lockRow(tx, row);
        await archiveSupportingMetrics(tx, locked);
        await insertSupporting(tx, locked, definitions, { userId: actor.userId });
        await ensurePrimaryMirror(tx, locked, { display: primaryDisplay, chosenBy: { userId: actor.userId } });
      });
      return definitions;
    },

    /**
     * Switch how one metric is drawn (`metricRef` is a supporting metric's id
     * or `primary`), among the forms its data allows; its readings stay. The
     * bar's own metric keeps who chose it; a primary nobody shaped yet becomes
     * the owner's choice, as `setChosen` does.
     */
    async setDisplay(row: ResponsibilityRow, metricRef: string, display: ResponsibilityMetricDisplay, actor: { userId: string }) {
      await assertEnabled();
      if (metricRef === "primary") {
        const bar = primaryMirrorShape(row);
        if (!bar) throw unprocessable("This responsibility's bar has no metric to draw yet");
        const allowed = responsibilityMetricDisplaysFor({ role: "primary", kind: bar.kind, display });
        if (!allowed.includes(display)) throw unprocessable(`This bar's metric can be drawn as ${allowed.join(", ")}`);
        return db.transaction(async (tx) => {
          const locked = await lockRow(tx, row);
          const existing = (await activeMetricRows(tx, locked)).find((metric) =>
            metric.position === RESPONSIBILITY_PRIMARY_METRIC_POSITION && mirrorMatches(metric, bar)) ?? null;
          const from = existing?.display ?? null;
          const shaped = !!(existing?.createdByAgentId || existing?.createdByUserId);
          await ensurePrimaryMirror(tx, locked, { display, ...(shaped ? {} : { chosenBy: { userId: actor.userId } }) });
          return { metricId: null, metricTitle: bar.title, from, to: display };
        });
      }
      const metric = await supportingMetric(db, row, metricRef);
      const current = metric.display as ResponsibilityMetricDisplay;
      const allowed = responsibilityMetricDisplaysFor({ role: "supporting", display: current, unit: metric.unit });
      if (!allowed.includes(display)) throw unprocessable(`This metric can be drawn as ${allowed.join(", ")}`);
      await db.update(responsibilityMetrics).set({ display, updatedAt: new Date() })
        .where(eq(responsibilityMetrics.id, metric.id));
      return { metricId: metric.id, metricTitle: metric.title, from: current, to: display };
    },

    /** Archive one supporting metric; its readings stay with it. */
    async remove(row: ResponsibilityRow, metricId: string) {
      await assertEnabled();
      const metric = await supportingMetric(db, row, metricId);
      await db.update(responsibilityMetrics).set({ status: "archived", updatedAt: new Date() })
        .where(eq(responsibilityMetrics.id, metric.id));
      return metric;
    },

    /**
     * Record (or, for the owner, correct) a reading. `metricRef` is a
     * supporting metric's id or `primary`. The primary's reading is the bar's
     * own: the newest one becomes `metricCurrent` (so status follows it); an
     * older one the owner backfills only joins the history. The route has
     * already checked who may record; here: agents never backdate or correct.
     */
    async record(
      row: ResponsibilityRow,
      metricRef: string,
      input: RecordResponsibilityMetricReading,
      recorder: MetricRecorder,
      now = new Date(),
    ): Promise<{
      metricId: string | null;
      metricTitle: string;
      primary: boolean;
      value: number;
      recordedAt: Date;
      corrected: boolean;
      backfilled: boolean;
      updated: ResponsibilityRow | null;
    }> {
      await assertEnabled();
      if (recorder.type === "agent" && input.recordedAt !== undefined) {
        throw forbidden("An agent records what is true now: leave recordedAt out. Only the owner can record a past reading");
      }
      if (recorder.type === "agent" && input.readingId !== undefined) {
        throw forbidden("Only the owner can correct a reading");
      }
      const recordedAt = input.recordedAt ? new Date(input.recordedAt) : now;
      if (recordedAt.getTime() > now.getTime() + 60_000) throw unprocessable("A reading cannot be in the future");
      const actor: MetricActor = recorder.type === "agent" ? { agentId: recorder.agentId } : { userId: recorder.userId };
      const note = input.note ?? null;

      if (metricRef === "primary") {
        const bar = primaryMirrorShape(row);
        if (!bar) throw unprocessable("This responsibility's bar has no metric to read yet");
        const issue = responsibilityReadingIssue(bar.kind, input.value);
        if (issue) throw unprocessable(issue);
        const value = normalizeResponsibilityReading(input.value);
        if (input.readingId) {
          return db.transaction(async (tx) => {
            const locked = await lockRow(tx, row);
            const mirror = await ensurePrimaryMirror(tx, locked);
            const [reading] = await tx.update(responsibilityMetricReadings).set({ value, note })
              .where(and(eq(responsibilityMetricReadings.id, input.readingId!), eq(responsibilityMetricReadings.metricId, mirror!.id)))
              .returning();
            if (!reading) throw notFound("Reading not found");
            const [newest] = await tx.select({ id: responsibilityMetricReadings.id }).from(responsibilityMetricReadings)
              .where(eq(responsibilityMetricReadings.metricId, mirror!.id))
              .orderBy(desc(responsibilityMetricReadings.recordedAt), desc(responsibilityMetricReadings.createdAt))
              .limit(1);
            let updated: ResponsibilityRow | null = null;
            if (newest?.id === reading.id) {
              [updated] = await tx.update(responsibilities).set({ metricCurrent: value, updatedAt: now })
                .where(eq(responsibilities.id, locked.id)).returning();
            }
            return { metricId: mirror!.id, metricTitle: bar.title, primary: true, value, recordedAt: reading.recordedAt, corrected: true, backfilled: false, updated };
          });
        }
        const current = row.metricUpdatedAt ? new Date(row.metricUpdatedAt).getTime() : null;
        if (current !== null && row.metricCurrent !== null && recordedAt.getTime() < current) {
          // Older than the reading the bar shows: it joins the history only.
          return db.transaction(async (tx) => {
            const locked = await lockRow(tx, row);
            const mirror = await ensurePrimaryMirror(tx, locked);
            await tx.insert(responsibilityMetricReadings).values({
              companyId: row.companyId,
              metricId: mirror!.id,
              value,
              recordedAt,
              recordedByAgentId: actor.agentId ?? null,
              recordedByUserId: actor.userId ?? null,
              note,
            });
            return { metricId: mirror!.id, metricTitle: bar.title, primary: true, value, recordedAt, corrected: false, backfilled: true, updated: null };
          });
        }
        const { responsibility: updated, olderReading } = await responsibilitiesSvc.update(
          row,
          { metricCurrent: input.value },
          recorder.type === "agent" ? { type: "agent", agentId: recorder.agentId, scope: recorder.scope } : { type: "board", userId: recorder.userId },
          { readingAt: recordedAt, readingNote: note },
        );
        return {
          metricId: null, metricTitle: bar.title, primary: true, value, recordedAt, corrected: false,
          backfilled: olderReading, updated: olderReading ? null : updated,
        };
      }

      const metric = await supportingMetric(db, row, metricRef);
      const issue = responsibilityMetricReadingIssue(metric.display as ResponsibilityMetricDisplay, input.value);
      if (issue) throw unprocessable(issue);
      const value = Number(input.value);
      if (input.readingId) {
        const [reading] = await db.update(responsibilityMetricReadings).set({ value, note })
          .where(and(eq(responsibilityMetricReadings.id, input.readingId), eq(responsibilityMetricReadings.metricId, metric.id)))
          .returning();
        if (!reading) throw notFound("Reading not found");
        return { metricId: metric.id, metricTitle: metric.title, primary: false, value, recordedAt: reading.recordedAt, corrected: true, backfilled: false, updated: null };
      }
      await db.insert(responsibilityMetricReadings).values({
        companyId: row.companyId,
        metricId: metric.id,
        value,
        recordedAt,
        recordedByAgentId: actor.agentId ?? null,
        recordedByUserId: actor.userId ?? null,
        note,
      });
      await db.update(responsibilityMetrics).set({ updatedAt: now }).where(eq(responsibilityMetrics.id, metric.id));
      return { metricId: metric.id, metricTitle: metric.title, primary: false, value, recordedAt, corrected: false, backfilled: false, updated: null };
    },

  };
}
