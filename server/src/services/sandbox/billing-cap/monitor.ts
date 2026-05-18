/**
 * Phase 4A-S4 B2 (LET-367): billing-cap monitor service.
 *
 * Responsibilities per tick:
 *   1. Resolve cumulative day/month spend via Source A (vendor) → Source B
 *      (internal counter) fallback.
 *   2. Persist counters with day/month UTC window rollover.
 *   3. Classify spend against `E2B_PILOT_THRESHOLDS`.
 *   4. On crossing a soft cap that wasn't already breached this window:
 *        - emit `soft_cap_breached` event + notifier warning (no flip).
 *   5. On crossing a hard cap:
 *        - atomically flip `sandbox.providers.e2b.enabled=false` for the
 *          remainder of the window.
 *        - emit `hard_cap_breached` + `auto_disable_engaged` events.
 *        - emit a `danger` + `interrupt` notification.
 *        - for monthly hard cap, also surface a `monthly_incident_opened`
 *          notification carrying the incident reference.
 *   6. Refuse to re-enable autonomously while a monthly hard-cap breach is on
 *      record for the current month, even at UTC day rollover.
 *
 * Idempotency: the monitor uses the persisted `dayHardCapBreachedAt` /
 * `monthHardCapBreachedAt` timestamps as a debouncer. If both are set inside
 * the current window, no further breach notifications fire until rollover or
 * an external operator action.
 */

import type { Logger } from "pino";
import {
  E2B_PILOT_THRESHOLDS,
  evaluateCaps,
  type BillingCapThresholds,
  type WindowKind,
} from "./policy.js";
import type { CapNotifier, CapNotification } from "./notifier.js";
import type {
  BillingCapEventRow,
  BillingCapInsertEvent,
  BillingCapStateRow,
  BillingCapStore,
} from "./store.js";
import type { ResolvedSpend, SourceA, SourceB } from "./usage-source.js";
import { resolveSpend } from "./usage-source.js";

export const AUTO_CAP_MONITOR_ACTOR = "auto-cap-monitor";
export const E2B_PROVIDER_KEY = "e2b";

export interface BillingCapMonitorTickInput {
  companyId: string;
  /** Override the wall clock for deterministic tests. */
  now?: Date;
  signal?: AbortSignal;
}

export interface BillingCapMonitorTickResult {
  companyId: string;
  provider: string;
  source: ResolvedSpend["source"];
  spend: { dayCents: number; monthCents: number };
  capState: ReturnType<typeof evaluateCaps>["capState"];
  /** Events appended to the audit log on this tick. */
  events: BillingCapEventRow[];
  notifications: CapNotification[];
  state: BillingCapStateRow;
}

export interface CapActivityLogEntry {
  /**
   * Canonical `activity_log.action` label. Soft/hard breaches and auto-disable
   * all surface as `sandbox.cost_breach` so a single activity filter catches
   * every breach; operator toggle + re-enable refusals stay distinct.
   */
  action: string;
  companyId: string;
  provider: string;
  /** Persisted `sandbox_billing_cap_events.id`; serves as `activity_log.entity_id`. */
  capEventId: string;
  /** Pre-redacted detail payload safe for `activity_log.details`. */
  details: Record<string, unknown>;
}

export function actionForCapEventKind(kind: string): string {
  if (kind === "hard_cap_breached" || kind === "soft_cap_breached" || kind === "auto_disable_engaged") {
    return "sandbox.cost_breach";
  }
  if (kind === "monthly_incident_opened") return "sandbox.cost_breach.incident_opened";
  if (kind === "operator_toggle_flipped") return "sandbox.kill_switch.flipped";
  if (kind === "reenable_refused") return "sandbox.kill_switch.reenable_refused";
  return `sandbox.${kind}`;
}

export interface BillingCapMonitorDeps {
  store: BillingCapStore;
  sourceA: SourceA | null;
  sourceB: SourceB;
  notifier: CapNotifier;
  logger: Pick<Logger, "info" | "warn" | "error">;
  /** Defaults to S3 §3 pilot thresholds. */
  thresholds?: BillingCapThresholds;
  /** Provider key, default `e2b`. */
  provider?: string;
  /** Called when a monthly hard cap breaches and an incident needs creating. */
  openMonthlyIncident?: (notification: CapNotification) => Promise<string | null>;
  /**
   * Optional sink for the `activity_log` row required by LET-367 AC #5. The
   * monitor calls this after every cap event so operator-visible activity
   * dashboards reflect the breach in the same surface they use for other
   * platform activity. Failure is logged and does not abort the tick.
   */
  activitySink?: (entry: CapActivityLogEntry) => Promise<void>;
}

export class BillingCapMonitor {
  private readonly thresholds: BillingCapThresholds;
  private readonly provider: string;

  constructor(private readonly deps: BillingCapMonitorDeps) {
    this.thresholds = deps.thresholds ?? E2B_PILOT_THRESHOLDS;
    this.provider = deps.provider ?? E2B_PROVIDER_KEY;
  }

  async tick(input: BillingCapMonitorTickInput): Promise<BillingCapMonitorTickResult> {
    const now = input.now ?? new Date();
    const spend = await resolveSpend({
      companyId: input.companyId,
      now,
      sourceA: this.deps.sourceA,
      sourceB: this.deps.sourceB,
      logger: this.deps.logger,
      signal: input.signal,
    });

    const previous = await this.deps.store.load(input.companyId, this.provider);

    const state = await this.deps.store.upsertCounters({
      companyId: input.companyId,
      provider: this.provider,
      now,
      source: spend.source,
      daySpentCents: spend.dayCents,
      monthSpentCents: spend.monthCents,
    });

    const evaluation = evaluateCaps({
      daySpentCents: state.daySpentCents,
      monthSpentCents: state.monthSpentCents,
      thresholds: this.thresholds,
    });

    const events: BillingCapEventRow[] = [];
    const notifications: CapNotification[] = [];

    // ----- Soft cap (day) -----
    if (
      evaluation.day.tier === "soft" &&
      // Don't double-notify if we have already flipped a hard cap this window.
      !state.dayHardCapBreachedAt &&
      (!previous || previous.daySpentCents < this.thresholds.daySoftCents)
    ) {
      const evt = await this.recordEvent({
        companyId: input.companyId,
        provider: this.provider,
        kind: "soft_cap_breached",
        windowKind: "day",
        spentCents: state.daySpentCents,
        thresholdCents: this.thresholds.daySoftCents,
        actorLabel: AUTO_CAP_MONITOR_ACTOR,
        reason: "day soft cap reached",
        metadata: { source: spend.source },
      });
      events.push(evt);
      notifications.push(
        await this.notify({
          companyId: input.companyId,
          provider: this.provider,
          kind: "soft_cap_breached",
          tone: "warning",
          title: `E2B daily soft cap reached (${formatUsd(state.daySpentCents)} / ${formatUsd(this.thresholds.daySoftCents)})`,
          body: softCapBody({
            windowKind: "day",
            spentCents: state.daySpentCents,
            softCapCents: this.thresholds.daySoftCents,
            hardCapCents: this.thresholds.dayHardCents,
            source: spend.source,
          }),
          metadata: this.notifierMetadata(state, spend),
        }),
      );
    }

    // ----- Soft cap (month) -----
    if (
      evaluation.month.tier === "soft" &&
      !state.monthHardCapBreachedAt &&
      (!previous || previous.monthSpentCents < this.thresholds.monthSoftCents)
    ) {
      const evt = await this.recordEvent({
        companyId: input.companyId,
        provider: this.provider,
        kind: "soft_cap_breached",
        windowKind: "month",
        spentCents: state.monthSpentCents,
        thresholdCents: this.thresholds.monthSoftCents,
        actorLabel: AUTO_CAP_MONITOR_ACTOR,
        reason: "month soft cap reached",
        metadata: { source: spend.source },
      });
      events.push(evt);
      notifications.push(
        await this.notify({
          companyId: input.companyId,
          provider: this.provider,
          kind: "soft_cap_breached",
          tone: "warning",
          title: `E2B monthly soft cap reached (${formatUsd(state.monthSpentCents)} / ${formatUsd(this.thresholds.monthSoftCents)})`,
          body: softCapBody({
            windowKind: "month",
            spentCents: state.monthSpentCents,
            softCapCents: this.thresholds.monthSoftCents,
            hardCapCents: this.thresholds.monthHardCents,
            source: spend.source,
            extraNote:
              "Assignee should post a cost-cause note within 24h (manual follow-up, not enforced by code).",
          }),
          metadata: this.notifierMetadata(state, spend),
        }),
      );
    }

    let mutableState = state;

    // ----- Hard cap (day) -----
    if (
      evaluation.day.tier === "hard" &&
      !mutableState.dayHardCapBreachedAt
    ) {
      const flipped = await this.deps.store.flipProviderEnable({
        companyId: input.companyId,
        provider: this.provider,
        enabled: false,
        actorLabel: AUTO_CAP_MONITOR_ACTOR,
        reason: "day_hard_cap_breached",
        at: now,
        recordHardCapBreach: "day",
      });
      mutableState = flipped;
      const evt = await this.recordEvent({
        companyId: input.companyId,
        provider: this.provider,
        kind: "hard_cap_breached",
        windowKind: "day",
        spentCents: mutableState.daySpentCents,
        thresholdCents: this.thresholds.dayHardCents,
        actorLabel: AUTO_CAP_MONITOR_ACTOR,
        reason: "day hard cap reached — provider auto-disabled",
        metadata: { source: spend.source },
      });
      events.push(evt);
      events.push(
        await this.recordEvent({
          companyId: input.companyId,
          provider: this.provider,
          kind: "auto_disable_engaged",
          windowKind: "day",
          spentCents: mutableState.daySpentCents,
          thresholdCents: this.thresholds.dayHardCents,
          actorLabel: AUTO_CAP_MONITOR_ACTOR,
          reason: "sandbox.providers.e2b.enabled flipped to false",
          metadata: { source: spend.source },
        }),
      );
      notifications.push(
        await this.notify({
          companyId: input.companyId,
          provider: this.provider,
          kind: "hard_cap_breached",
          tone: "danger",
          interrupt: true,
          title: `E2B daily hard cap breached (${formatUsd(mutableState.daySpentCents)} / ${formatUsd(this.thresholds.dayHardCents)}) — provider auto-disabled`,
          body: hardCapBody({
            windowKind: "day",
            spentCents: mutableState.daySpentCents,
            hardCapCents: this.thresholds.dayHardCents,
            source: spend.source,
          }),
          metadata: this.notifierMetadata(mutableState, spend),
        }),
      );
    }

    // ----- Hard cap (month) -----
    if (
      evaluation.month.tier === "hard" &&
      !mutableState.monthHardCapBreachedAt
    ) {
      const flipped = await this.deps.store.flipProviderEnable({
        companyId: input.companyId,
        provider: this.provider,
        enabled: false,
        actorLabel: AUTO_CAP_MONITOR_ACTOR,
        reason: "month_hard_cap_breached",
        at: now,
        recordHardCapBreach: "month",
      });
      mutableState = flipped;
      const hardEvt = await this.recordEvent({
        companyId: input.companyId,
        provider: this.provider,
        kind: "hard_cap_breached",
        windowKind: "month",
        spentCents: mutableState.monthSpentCents,
        thresholdCents: this.thresholds.monthHardCents,
        actorLabel: AUTO_CAP_MONITOR_ACTOR,
        reason: "month hard cap reached — provider auto-disabled",
        metadata: { source: spend.source },
      });
      events.push(hardEvt);
      events.push(
        await this.recordEvent({
          companyId: input.companyId,
          provider: this.provider,
          kind: "auto_disable_engaged",
          windowKind: "month",
          spentCents: mutableState.monthSpentCents,
          thresholdCents: this.thresholds.monthHardCents,
          actorLabel: AUTO_CAP_MONITOR_ACTOR,
          reason: "sandbox.providers.e2b.enabled flipped to false (monthly)",
          metadata: { source: spend.source },
        }),
      );
      const danger = await this.notify({
        companyId: input.companyId,
        provider: this.provider,
        kind: "hard_cap_breached",
        tone: "danger",
        interrupt: true,
        title: `E2B monthly hard cap breached (${formatUsd(mutableState.monthSpentCents)} / ${formatUsd(this.thresholds.monthHardCents)}) — provider auto-disabled`,
        body: hardCapBody({
          windowKind: "month",
          spentCents: mutableState.monthSpentCents,
          hardCapCents: this.thresholds.monthHardCents,
          source: spend.source,
        }),
        metadata: this.notifierMetadata(mutableState, spend),
      });
      notifications.push(danger);

      // Open the incident issue if a hook is provided. Failures here are
      // logged but never abort the tick.
      let incidentIssueId: string | null = null;
      if (this.deps.openMonthlyIncident) {
        try {
          incidentIssueId = await this.deps.openMonthlyIncident(danger);
        } catch (err) {
          this.deps.logger.error(
            { err, companyId: input.companyId },
            "sandbox billing-cap monitor failed to open monthly incident",
          );
        }
      }
      const monthlyEvt = await this.recordEvent({
        companyId: input.companyId,
        provider: this.provider,
        kind: "monthly_incident_opened",
        windowKind: "month",
        actorLabel: AUTO_CAP_MONITOR_ACTOR,
        reason: incidentIssueId
          ? "Paperclip incident issue opened with tag sandbox/cost-breach"
          : "Paperclip incident-issue creation hook not configured or failed; manual follow-up required",
        incidentIssueId,
        metadata: { source: spend.source },
      });
      events.push(monthlyEvt);
      notifications.push(
        await this.notify({
          companyId: input.companyId,
          provider: this.provider,
          kind: "monthly_incident_opened",
          tone: "danger",
          interrupt: true,
          title: incidentIssueId
            ? `E2B monthly cost-breach incident opened (issue ${incidentIssueId})`
            : "E2B monthly cost-breach incident pending (no auto-creation hook configured)",
          body:
            "Re-enable requires a fresh Andrii request_confirmation. The monitor will refuse to re-enable autonomously even at UTC day rollover while this monthly hard-cap breach is on record.",
          metadata: { incidentIssueId, source: spend.source },
        }),
      );
    }

    return {
      companyId: input.companyId,
      provider: this.provider,
      source: spend.source,
      spend: { dayCents: state.daySpentCents, monthCents: state.monthSpentCents },
      capState: evaluation.capState,
      events,
      notifications,
      state: mutableState,
    };
  }

  /**
   * Operator-initiated toggle. Encapsulates the "refuse to re-enable while a
   * monthly hard cap is on record" guard from AC #4.
   */
  async flipOperatorToggle(input: {
    companyId: string;
    enable: boolean;
    reason: string;
    actorLabel: string;
    now?: Date;
  }): Promise<{ state: BillingCapStateRow; event: BillingCapEventRow }> {
    const now = input.now ?? new Date();
    if (input.enable) {
      const existing = await this.deps.store.load(input.companyId, this.provider);
      if (existing?.monthHardCapBreachedAt) {
        const refusal = await this.recordEvent({
          companyId: input.companyId,
          provider: this.provider,
          kind: "reenable_refused",
          actorLabel: input.actorLabel,
          reason: "monthly hard-cap breach on record for current month",
          metadata: { requestedEnable: true },
        });
        await this.notify({
          companyId: input.companyId,
          provider: this.provider,
          kind: "reenable_refused",
          tone: "warning",
          title: "E2B re-enable refused: monthly hard-cap breach on record",
          body:
            "Re-enable requires a fresh Andrii request_confirmation after the monthly hard-cap breach is acknowledged and a new month begins.",
          metadata: { requestedBy: input.actorLabel },
        });
        return { state: existing, event: refusal };
      }
    }
    const flipped = await this.deps.store.flipOperatorToggle({
      companyId: input.companyId,
      provider: this.provider,
      enabled: input.enable,
      actorLabel: input.actorLabel,
      reason: input.reason,
      at: now,
    });
    const evt = await this.recordEvent({
      companyId: input.companyId,
      provider: this.provider,
      kind: "operator_toggle_flipped",
      actorLabel: input.actorLabel,
      reason: input.reason,
      metadata: { enable: input.enable },
    });
    await this.notify({
      companyId: input.companyId,
      provider: this.provider,
      kind: "operator_toggle_flipped",
      tone: input.enable ? "info" : "warning",
      title: input.enable
        ? "E2B operator toggle flipped on"
        : "E2B operator toggle flipped off",
      body: `Actor: ${input.actorLabel}\nReason: ${input.reason}`,
      metadata: { enable: input.enable },
    });
    return { state: flipped, event: evt };
  }

  private async recordEvent(event: BillingCapInsertEvent): Promise<BillingCapEventRow> {
    const row = await this.deps.store.appendEvent(event);
    if (this.deps.activitySink) {
      try {
        await this.deps.activitySink({
          action: actionForCapEventKind(row.kind),
          companyId: row.companyId,
          provider: row.provider,
          capEventId: row.id,
          // Pre-redacted (event.metadata was already sanitised upstream);
          // we still scope to a flat schema so dashboards have stable keys.
          details: {
            kind: row.kind,
            windowKind: row.windowKind,
            spentCents: row.spentCents,
            thresholdCents: row.thresholdCents,
            projectionCents: row.projectionCents,
            actorLabel: row.actorLabel,
            reason: row.reason,
            incidentIssueId: row.incidentIssueId,
            source: typeof row.metadata?.source === "string" ? row.metadata.source : null,
          },
        });
      } catch (err) {
        this.deps.logger.error(
          { err, companyId: row.companyId, capEventId: row.id, kind: row.kind },
          "sandbox billing-cap activity-log sink failed",
        );
      }
    }
    return row;
  }

  private async notify(notification: CapNotification): Promise<CapNotification> {
    try {
      await this.deps.notifier.notify(notification);
    } catch (err) {
      this.deps.logger.error(
        { err, companyId: notification.companyId, kind: notification.kind },
        "sandbox billing-cap notifier failed",
      );
    }
    return notification;
  }

  private notifierMetadata(state: BillingCapStateRow, spend: ResolvedSpend) {
    return {
      capState: evaluateCaps({
        daySpentCents: state.daySpentCents,
        monthSpentCents: state.monthSpentCents,
        thresholds: this.thresholds,
      }).capState,
      source: spend.source,
      sourceAStatus: spend.sourceAStatus,
      dayWindowStart: state.dayWindowStart.toISOString(),
      monthWindowStart: state.monthWindowStart.toISOString(),
      internalRuntimeSeconds: {
        day: spend.internalEstimate.dayRuntimeSeconds,
        month: spend.internalEstimate.monthRuntimeSeconds,
      },
    };
  }
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function softCapBody(input: {
  windowKind: WindowKind;
  spentCents: number;
  softCapCents: number;
  hardCapCents: number;
  source: ResolvedSpend["source"];
  extraNote?: string;
}): string {
  return [
    `Current ${input.windowKind} spend: ${formatUsd(input.spentCents)} (soft cap ${formatUsd(input.softCapCents)}, hard cap ${formatUsd(input.hardCapCents)}).`,
    `Source: ${input.source}.`,
    input.extraNote ?? null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

function hardCapBody(input: {
  windowKind: WindowKind;
  spentCents: number;
  hardCapCents: number;
  source: ResolvedSpend["source"];
}): string {
  return [
    `Current ${input.windowKind} spend: ${formatUsd(input.spentCents)} (hard cap ${formatUsd(input.hardCapCents)}).`,
    `Source: ${input.source}.`,
    "Provider-enable config flipped to false. Re-enable requires Andrii request_confirmation.",
  ].join("\n\n");
}
