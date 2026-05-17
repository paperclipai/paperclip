/**
 * Phase 4A-S4 B2 (LET-367): persistence layer for the billing-cap monitor.
 *
 * Wraps the `sandbox_billing_cap_state` (current counters + layer states) and
 * `sandbox_billing_cap_events` (audit log) tables. The monitor never touches
 * Drizzle directly; it goes through this module so tests can substitute an
 * in-memory store (see `InMemoryBillingCapStore`).
 */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { sandboxBillingCapEvents, sandboxBillingCapState } from "@paperclipai/db";
import { isSameUtcDay, isSameUtcMonth, utcDayBounds, utcMonthBounds } from "./window.js";
import type { SandboxBillingSourceLabel } from "./usage-source.js";

export interface BillingCapStateRow {
  companyId: string;
  provider: string;
  dayWindowStart: Date;
  daySpentCents: number;
  dayHardCapBreachedAt: Date | null;
  monthWindowStart: Date;
  monthSpentCents: number;
  monthHardCapBreachedAt: Date | null;
  providerEnableLayerEnabled: boolean;
  providerEnableReason: string | null;
  providerEnableActorLabel: string | null;
  providerEnableTransitionAt: Date | null;
  operatorToggleEnabled: boolean;
  operatorToggleReason: string | null;
  operatorToggleActorLabel: string | null;
  operatorToggleTransitionAt: Date | null;
  lastPolledAt: Date | null;
  lastSource: SandboxBillingSourceLabel | null;
}

export interface BillingCapEventRow {
  id: string;
  companyId: string;
  provider: string;
  kind: string;
  windowKind: "day" | "month" | null;
  spentCents: number | null;
  thresholdCents: number | null;
  projectionCents: number | null;
  actorLabel: string;
  reason: string | null;
  incidentIssueId: string | null;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
}

export interface BillingCapInsertEvent {
  companyId: string;
  provider: string;
  kind: BillingCapEventRow["kind"];
  windowKind?: "day" | "month" | null;
  spentCents?: number | null;
  thresholdCents?: number | null;
  projectionCents?: number | null;
  actorLabel: string;
  reason?: string | null;
  incidentIssueId?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt?: Date;
}

export interface UpsertCountersInput {
  companyId: string;
  provider: string;
  now: Date;
  source: SandboxBillingSourceLabel;
  daySpentCents: number;
  monthSpentCents: number;
}

export interface FlipProviderEnableInput {
  companyId: string;
  provider: string;
  enabled: boolean;
  actorLabel: string;
  reason: string | null;
  at: Date;
  /** When `true`, also record the day/month hard-cap breach timestamp. */
  recordHardCapBreach?: "day" | "month" | null;
}

export interface FlipOperatorToggleInput {
  companyId: string;
  provider: string;
  enabled: boolean;
  actorLabel: string;
  reason: string;
  at: Date;
}

export interface BillingCapStore {
  load(companyId: string, provider: string): Promise<BillingCapStateRow | null>;
  upsertCounters(input: UpsertCountersInput): Promise<BillingCapStateRow>;
  flipProviderEnable(input: FlipProviderEnableInput): Promise<BillingCapStateRow>;
  flipOperatorToggle(input: FlipOperatorToggleInput): Promise<BillingCapStateRow>;
  appendEvent(event: BillingCapInsertEvent): Promise<BillingCapEventRow>;
  listEvents(
    companyId: string,
    provider: string,
    options?: { limit?: number; kinds?: string[] },
  ): Promise<BillingCapEventRow[]>;
}

function rollWindowsIfNeeded(
  row: BillingCapStateRow,
  now: Date,
): { dayReset: boolean; monthReset: boolean; nextState: BillingCapStateRow } {
  const day = utcDayBounds(now);
  const month = utcMonthBounds(now);
  const dayReset = !isSameUtcDay(row.dayWindowStart, now);
  const monthReset = !isSameUtcMonth(row.monthWindowStart, now);
  const nextState: BillingCapStateRow = {
    ...row,
    dayWindowStart: dayReset ? day.start : row.dayWindowStart,
    daySpentCents: dayReset ? 0 : row.daySpentCents,
    dayHardCapBreachedAt: dayReset ? null : row.dayHardCapBreachedAt,
    monthWindowStart: monthReset ? month.start : row.monthWindowStart,
    monthSpentCents: monthReset ? 0 : row.monthSpentCents,
    monthHardCapBreachedAt: monthReset ? null : row.monthHardCapBreachedAt,
    // If the day rolls and the month does NOT have a hard-cap breach, the
    // monitor is free to re-enable the provider at the next tick.
    providerEnableLayerEnabled: dayReset && !row.monthHardCapBreachedAt && !row.providerEnableLayerEnabled
      ? true
      : row.providerEnableLayerEnabled,
    providerEnableReason: dayReset && !row.monthHardCapBreachedAt && !row.providerEnableLayerEnabled
      ? "day_window_rolled_over_no_active_monthly_breach"
      : row.providerEnableReason,
    providerEnableActorLabel: dayReset && !row.monthHardCapBreachedAt && !row.providerEnableLayerEnabled
      ? "auto-cap-monitor"
      : row.providerEnableActorLabel,
    providerEnableTransitionAt: dayReset && !row.monthHardCapBreachedAt && !row.providerEnableLayerEnabled
      ? day.start
      : row.providerEnableTransitionAt,
  };
  return { dayReset, monthReset, nextState };
}

/**
 * Helper used by both the real and the in-memory store to derive the next
 * state row from the previous one after a counter upsert.
 */
export function projectAfterUpsert(
  previous: BillingCapStateRow | null,
  input: UpsertCountersInput,
): BillingCapStateRow {
  const day = utcDayBounds(input.now);
  const month = utcMonthBounds(input.now);
  if (!previous) {
    return {
      companyId: input.companyId,
      provider: input.provider,
      dayWindowStart: day.start,
      daySpentCents: Math.max(0, Math.trunc(input.daySpentCents)),
      dayHardCapBreachedAt: null,
      monthWindowStart: month.start,
      monthSpentCents: Math.max(0, Math.trunc(input.monthSpentCents)),
      monthHardCapBreachedAt: null,
      providerEnableLayerEnabled: true,
      providerEnableReason: null,
      providerEnableActorLabel: null,
      providerEnableTransitionAt: null,
      operatorToggleEnabled: true,
      operatorToggleReason: null,
      operatorToggleActorLabel: null,
      operatorToggleTransitionAt: null,
      lastPolledAt: input.now,
      lastSource: input.source,
    };
  }
  const rolled = rollWindowsIfNeeded(previous, input.now);
  return {
    ...rolled.nextState,
    daySpentCents: Math.max(0, Math.trunc(input.daySpentCents)),
    monthSpentCents: Math.max(0, Math.trunc(input.monthSpentCents)),
    lastPolledAt: input.now,
    lastSource: input.source,
  };
}

function mapRowFromDb(
  row: typeof sandboxBillingCapState.$inferSelect,
): BillingCapStateRow {
  return {
    companyId: row.companyId,
    provider: row.provider,
    dayWindowStart: row.dayWindowStart,
    daySpentCents: row.daySpentCents,
    dayHardCapBreachedAt: row.dayHardCapBreachedAt ?? null,
    monthWindowStart: row.monthWindowStart,
    monthSpentCents: row.monthSpentCents,
    monthHardCapBreachedAt: row.monthHardCapBreachedAt ?? null,
    providerEnableLayerEnabled: row.providerEnableLayerEnabled,
    providerEnableReason: row.providerEnableReason ?? null,
    providerEnableActorLabel: row.providerEnableActorLabel ?? null,
    providerEnableTransitionAt: row.providerEnableTransitionAt ?? null,
    operatorToggleEnabled: row.operatorToggleEnabled,
    operatorToggleReason: row.operatorToggleReason ?? null,
    operatorToggleActorLabel: row.operatorToggleActorLabel ?? null,
    operatorToggleTransitionAt: row.operatorToggleTransitionAt ?? null,
    lastPolledAt: row.lastPolledAt ?? null,
    lastSource: (row.lastSource as SandboxBillingSourceLabel | null) ?? null,
  };
}

function mapEventFromDb(
  row: typeof sandboxBillingCapEvents.$inferSelect,
): BillingCapEventRow {
  return {
    id: row.id,
    companyId: row.companyId,
    provider: row.provider,
    kind: row.kind,
    windowKind: (row.windowKind as "day" | "month" | null) ?? null,
    spentCents: row.spentCents ?? null,
    thresholdCents: row.thresholdCents ?? null,
    projectionCents: row.projectionCents ?? null,
    actorLabel: row.actorLabel,
    reason: row.reason ?? null,
    incidentIssueId: row.incidentIssueId ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    occurredAt: row.occurredAt,
  };
}

export class DrizzleBillingCapStore implements BillingCapStore {
  constructor(private readonly db: Db) {}

  async load(companyId: string, provider: string): Promise<BillingCapStateRow | null> {
    const rows = await this.db
      .select()
      .from(sandboxBillingCapState)
      .where(
        and(
          eq(sandboxBillingCapState.companyId, companyId),
          eq(sandboxBillingCapState.provider, provider),
        ),
      )
      .limit(1);
    if (rows.length === 0) return null;
    return mapRowFromDb(rows[0]);
  }

  async upsertCounters(input: UpsertCountersInput): Promise<BillingCapStateRow> {
    const previous = await this.load(input.companyId, input.provider);
    const next = projectAfterUpsert(previous, input);
    if (!previous) {
      const inserted = await this.db
        .insert(sandboxBillingCapState)
        .values({
          companyId: next.companyId,
          provider: next.provider,
          dayWindowStart: next.dayWindowStart,
          daySpentCents: next.daySpentCents,
          monthWindowStart: next.monthWindowStart,
          monthSpentCents: next.monthSpentCents,
          providerEnableLayerEnabled: next.providerEnableLayerEnabled,
          operatorToggleEnabled: next.operatorToggleEnabled,
          lastPolledAt: next.lastPolledAt,
          lastSource: next.lastSource,
        })
        .returning();
      return mapRowFromDb(inserted[0]);
    }
    const updated = await this.db
      .update(sandboxBillingCapState)
      .set({
        dayWindowStart: next.dayWindowStart,
        daySpentCents: next.daySpentCents,
        dayHardCapBreachedAt: next.dayHardCapBreachedAt,
        monthWindowStart: next.monthWindowStart,
        monthSpentCents: next.monthSpentCents,
        monthHardCapBreachedAt: next.monthHardCapBreachedAt,
        providerEnableLayerEnabled: next.providerEnableLayerEnabled,
        providerEnableReason: next.providerEnableReason,
        providerEnableActorLabel: next.providerEnableActorLabel,
        providerEnableTransitionAt: next.providerEnableTransitionAt,
        lastPolledAt: next.lastPolledAt,
        lastSource: next.lastSource,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(sandboxBillingCapState.companyId, input.companyId),
          eq(sandboxBillingCapState.provider, input.provider),
        ),
      )
      .returning();
    return mapRowFromDb(updated[0]);
  }

  async flipProviderEnable(input: FlipProviderEnableInput): Promise<BillingCapStateRow> {
    const previous = await this.load(input.companyId, input.provider);
    const day = utcDayBounds(input.at);
    const month = utcMonthBounds(input.at);
    if (!previous) {
      // Establish the row defensively so the flip is durable even when no
      // counter tick has hit yet.
      const inserted = await this.db
        .insert(sandboxBillingCapState)
        .values({
          companyId: input.companyId,
          provider: input.provider,
          dayWindowStart: day.start,
          daySpentCents: 0,
          monthWindowStart: month.start,
          monthSpentCents: 0,
          providerEnableLayerEnabled: input.enabled,
          providerEnableReason: input.reason,
          providerEnableActorLabel: input.actorLabel,
          providerEnableTransitionAt: input.at,
          dayHardCapBreachedAt: input.recordHardCapBreach === "day" ? input.at : null,
          monthHardCapBreachedAt: input.recordHardCapBreach === "month" ? input.at : null,
          lastPolledAt: null,
          lastSource: null,
        })
        .returning();
      return mapRowFromDb(inserted[0]);
    }
    const dayHardCapBreachedAt =
      input.recordHardCapBreach === "day" ? input.at : previous.dayHardCapBreachedAt;
    const monthHardCapBreachedAt =
      input.recordHardCapBreach === "month" ? input.at : previous.monthHardCapBreachedAt;
    const updated = await this.db
      .update(sandboxBillingCapState)
      .set({
        providerEnableLayerEnabled: input.enabled,
        providerEnableReason: input.reason,
        providerEnableActorLabel: input.actorLabel,
        providerEnableTransitionAt: input.at,
        dayHardCapBreachedAt,
        monthHardCapBreachedAt,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(sandboxBillingCapState.companyId, input.companyId),
          eq(sandboxBillingCapState.provider, input.provider),
        ),
      )
      .returning();
    return mapRowFromDb(updated[0]);
  }

  async flipOperatorToggle(input: FlipOperatorToggleInput): Promise<BillingCapStateRow> {
    const previous = await this.load(input.companyId, input.provider);
    const day = utcDayBounds(input.at);
    const month = utcMonthBounds(input.at);
    if (!previous) {
      const inserted = await this.db
        .insert(sandboxBillingCapState)
        .values({
          companyId: input.companyId,
          provider: input.provider,
          dayWindowStart: day.start,
          daySpentCents: 0,
          monthWindowStart: month.start,
          monthSpentCents: 0,
          operatorToggleEnabled: input.enabled,
          operatorToggleReason: input.reason,
          operatorToggleActorLabel: input.actorLabel,
          operatorToggleTransitionAt: input.at,
          lastPolledAt: null,
          lastSource: null,
        })
        .returning();
      return mapRowFromDb(inserted[0]);
    }
    const updated = await this.db
      .update(sandboxBillingCapState)
      .set({
        operatorToggleEnabled: input.enabled,
        operatorToggleReason: input.reason,
        operatorToggleActorLabel: input.actorLabel,
        operatorToggleTransitionAt: input.at,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(sandboxBillingCapState.companyId, input.companyId),
          eq(sandboxBillingCapState.provider, input.provider),
        ),
      )
      .returning();
    return mapRowFromDb(updated[0]);
  }

  async appendEvent(event: BillingCapInsertEvent): Promise<BillingCapEventRow> {
    const inserted = await this.db
      .insert(sandboxBillingCapEvents)
      .values({
        companyId: event.companyId,
        provider: event.provider,
        kind: event.kind,
        windowKind: event.windowKind ?? null,
        spentCents: event.spentCents ?? null,
        thresholdCents: event.thresholdCents ?? null,
        projectionCents: event.projectionCents ?? null,
        actorLabel: event.actorLabel,
        reason: event.reason ?? null,
        incidentIssueId: event.incidentIssueId ?? null,
        metadata: event.metadata ?? null,
        occurredAt: event.occurredAt ?? new Date(),
      })
      .returning();
    return mapEventFromDb(inserted[0]);
  }

  async listEvents(
    companyId: string,
    provider: string,
    options: { limit?: number; kinds?: string[] } = {},
  ): Promise<BillingCapEventRow[]> {
    const where = and(
      eq(sandboxBillingCapEvents.companyId, companyId),
      eq(sandboxBillingCapEvents.provider, provider),
    );
    const rows = await this.db
      .select()
      .from(sandboxBillingCapEvents)
      .where(where)
      .orderBy(desc(sandboxBillingCapEvents.occurredAt))
      .limit(Math.min(Math.max(1, options.limit ?? 20), 100));
    const mapped = rows.map(mapEventFromDb);
    if (!options.kinds || options.kinds.length === 0) return mapped;
    return mapped.filter((event) => options.kinds!.includes(event.kind));
  }
}

/**
 * In-memory test double that mirrors `DrizzleBillingCapStore` semantics. Used
 * by the monitor unit tests so the tick orchestration can be exercised
 * without a Postgres dependency.
 */
export class InMemoryBillingCapStore implements BillingCapStore {
  private readonly state = new Map<string, BillingCapStateRow>();
  private readonly events: BillingCapEventRow[] = [];

  private key(companyId: string, provider: string) {
    return `${companyId}::${provider}`;
  }

  async load(companyId: string, provider: string): Promise<BillingCapStateRow | null> {
    return this.state.get(this.key(companyId, provider)) ?? null;
  }

  async upsertCounters(input: UpsertCountersInput): Promise<BillingCapStateRow> {
    const previous = (await this.load(input.companyId, input.provider)) ?? null;
    const next = projectAfterUpsert(previous, input);
    this.state.set(this.key(input.companyId, input.provider), next);
    return next;
  }

  async flipProviderEnable(input: FlipProviderEnableInput): Promise<BillingCapStateRow> {
    const previous = (await this.load(input.companyId, input.provider)) ?? null;
    const day = utcDayBounds(input.at);
    const month = utcMonthBounds(input.at);
    const base: BillingCapStateRow = previous ?? {
      companyId: input.companyId,
      provider: input.provider,
      dayWindowStart: day.start,
      daySpentCents: 0,
      dayHardCapBreachedAt: null,
      monthWindowStart: month.start,
      monthSpentCents: 0,
      monthHardCapBreachedAt: null,
      providerEnableLayerEnabled: true,
      providerEnableReason: null,
      providerEnableActorLabel: null,
      providerEnableTransitionAt: null,
      operatorToggleEnabled: true,
      operatorToggleReason: null,
      operatorToggleActorLabel: null,
      operatorToggleTransitionAt: null,
      lastPolledAt: null,
      lastSource: null,
    };
    const next: BillingCapStateRow = {
      ...base,
      providerEnableLayerEnabled: input.enabled,
      providerEnableReason: input.reason,
      providerEnableActorLabel: input.actorLabel,
      providerEnableTransitionAt: input.at,
      dayHardCapBreachedAt:
        input.recordHardCapBreach === "day" ? input.at : base.dayHardCapBreachedAt,
      monthHardCapBreachedAt:
        input.recordHardCapBreach === "month" ? input.at : base.monthHardCapBreachedAt,
    };
    this.state.set(this.key(input.companyId, input.provider), next);
    return next;
  }

  async flipOperatorToggle(input: FlipOperatorToggleInput): Promise<BillingCapStateRow> {
    const previous = (await this.load(input.companyId, input.provider)) ?? null;
    const day = utcDayBounds(input.at);
    const month = utcMonthBounds(input.at);
    const base: BillingCapStateRow = previous ?? {
      companyId: input.companyId,
      provider: input.provider,
      dayWindowStart: day.start,
      daySpentCents: 0,
      dayHardCapBreachedAt: null,
      monthWindowStart: month.start,
      monthSpentCents: 0,
      monthHardCapBreachedAt: null,
      providerEnableLayerEnabled: true,
      providerEnableReason: null,
      providerEnableActorLabel: null,
      providerEnableTransitionAt: null,
      operatorToggleEnabled: true,
      operatorToggleReason: null,
      operatorToggleActorLabel: null,
      operatorToggleTransitionAt: null,
      lastPolledAt: null,
      lastSource: null,
    };
    const next: BillingCapStateRow = {
      ...base,
      operatorToggleEnabled: input.enabled,
      operatorToggleReason: input.reason,
      operatorToggleActorLabel: input.actorLabel,
      operatorToggleTransitionAt: input.at,
    };
    this.state.set(this.key(input.companyId, input.provider), next);
    return next;
  }

  async appendEvent(event: BillingCapInsertEvent): Promise<BillingCapEventRow> {
    const row: BillingCapEventRow = {
      id: `evt-${this.events.length + 1}`,
      companyId: event.companyId,
      provider: event.provider,
      kind: event.kind,
      windowKind: event.windowKind ?? null,
      spentCents: event.spentCents ?? null,
      thresholdCents: event.thresholdCents ?? null,
      projectionCents: event.projectionCents ?? null,
      actorLabel: event.actorLabel,
      reason: event.reason ?? null,
      incidentIssueId: event.incidentIssueId ?? null,
      metadata: event.metadata ?? null,
      occurredAt: event.occurredAt ?? new Date(),
    };
    this.events.push(row);
    return row;
  }

  async listEvents(
    companyId: string,
    provider: string,
    options: { limit?: number; kinds?: string[] } = {},
  ): Promise<BillingCapEventRow[]> {
    const filtered = this.events
      .filter((event) => event.companyId === companyId && event.provider === provider)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    const slice = filtered.slice(0, options.limit ?? 20);
    if (!options.kinds || options.kinds.length === 0) return slice;
    return slice.filter((event) => options.kinds!.includes(event.kind));
  }
}
