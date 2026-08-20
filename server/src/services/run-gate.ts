/**
 * Run gate: the single choke point that decides whether a queued heartbeat run
 * may start executing right now. It layers, in order:
 *
 *   1. instance-wide pause (instance_settings.run_controls.pauseAll)
 *   2. per-adapter-family pause (instance_settings.run_controls.adapterPauses)
 *   3. per-company pause (companies.run_pause_state)
 *   4. company activity window / "sprint" (companies.activity_window)
 *   5. per-adapter-type concurrency cap (instance_settings.run_controls.adapterConcurrency)
 *   6. instance-wide global concurrency cap (instance_settings.run_controls.globalConcurrency)
 *
 * A non-null block means the run must be DEFERRED: left queued, never failed
 * or cancelled. The periodic heartbeat scheduler retries deferred runs, so
 * work resumes automatically when the gate opens (window opens, pause lifted,
 * a running slot frees up).
 *
 * Exemptions (activity window + concurrency only — explicit pauses always win):
 *   - adapterType "paperclip_shell_handler" (deterministic, near-zero cost)
 *   - agents with runtimeConfig.ignoreActivityWindow === true (window only)
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, heartbeatRuns, instanceSettings } from "@paperclipai/db";
import {
  ACTIVITY_WINDOW_EXEMPT_ADAPTER_TYPES,
  CONCURRENCY_EXEMPT_ADAPTER_TYPES,
  DEFAULT_ADAPTER_CONCURRENCY,
  DEFAULT_GLOBAL_CONCURRENCY,
  IGNORE_ACTIVITY_WINDOW_RUNTIME_CONFIG_KEY,
  formatActivityWindowOpensAt,
  getActivityWindowState,
  parseCompanyActivityWindow,
  parseCompanyRunPauseState,
  type CompanyActivityWindow,
  type CompanyActivityWindowState,
  type CompanyRunPauseState,
  type InstanceRunControls,
  type InstanceRunPause,
} from "@paperclipai/shared";

const INSTANCE_SETTINGS_SINGLETON_KEY = "default";

export type RunGateBlockKind =
  | "instance_paused"
  | "adapter_family_paused"
  | "company_paused"
  | "outside_activity_window"
  | "adapter_concurrency_limit"
  | "global_concurrency_limit";

export interface RunGateBlock {
  kind: RunGateBlockKind;
  reason: string;
  /** When the gate is expected to change next (activity windows only). */
  nextChangeAt: Date | null;
}

export interface RunGateAgentContext {
  companyId: string;
  agentId: string;
  /** Optional pre-fetched agent fields to avoid a redundant query. */
  adapterType?: string | null;
  agentRuntimeConfig?: Record<string, unknown> | null;
  /**
   * True when this run was started by a manual operator override (the
   * /heartbeat/invoke or /wakeup endpoints, which stamp triggerDetail "manual").
   * Such runs bypass the `outside_activity_window` defer so an operator can wake
   * a dormant company on demand — mirroring the enqueue-time dormancy guard,
   * which also lets manual wakes through. Explicit pauses (instance / adapter /
   * company / emergency stop) and concurrency caps still apply.
   */
  isManualOverride?: boolean;
  now?: Date;
}

// pausedAt may arrive as a Date (set in-process by the pause route via
// `new Date()`), an ISO string (round-tripped from the DB jsonb), or an epoch
// number. Accepting only strings silently dropped the timestamp on every fresh
// pause, so a paused instance never rendered as paused.
function coercePausedAt(value: unknown): Date | null {
  let date: Date | null = null;
  if (value instanceof Date) date = value;
  else if (typeof value === "string" || typeof value === "number") date = new Date(value);
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function readPauseRecord(raw: unknown): InstanceRunPause | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  return {
    reason: typeof candidate.reason === "string" && candidate.reason.length > 0 ? candidate.reason : null,
    pausedAt: coercePausedAt(candidate.pausedAt),
    pausedBy: typeof candidate.pausedBy === "string" && candidate.pausedBy.length > 0 ? candidate.pausedBy : null,
  };
}

/**
 * Companies carry an emergency-stop state (companies.emergency_stop_state,
 * migration 0095). The run gate treats an uncleared "stop_mutation" stop as a
 * company-level pause: no new agent runs may start until it is cleared.
 * "recovery" mode does NOT block run starts — recovery work itself has to run;
 * mutation-level enforcement for both modes lives with the board-mutation
 * guard, not here.
 */
function readActiveEmergencyStop(raw: unknown): { mode: string; reason: string | null } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.mode !== "stop_mutation") return null;
  if (candidate.clearedAt) return null;
  return {
    mode: candidate.mode,
    reason: typeof candidate.reason === "string" && candidate.reason.length > 0 ? candidate.reason : null,
  };
}

export function normalizeInstanceRunControls(raw: unknown): InstanceRunControls {
  const candidate = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const adapterPauses: Record<string, InstanceRunPause> = {};
  const rawAdapterPauses = candidate.adapterPauses;
  if (rawAdapterPauses && typeof rawAdapterPauses === "object" && !Array.isArray(rawAdapterPauses)) {
    for (const [adapterType, value] of Object.entries(rawAdapterPauses as Record<string, unknown>)) {
      const pause = readPauseRecord(value);
      if (pause) adapterPauses[adapterType] = pause;
    }
  }
  const adapterConcurrency: Record<string, number> = { ...DEFAULT_ADAPTER_CONCURRENCY };
  const rawConcurrency = candidate.adapterConcurrency;
  if (rawConcurrency && typeof rawConcurrency === "object" && !Array.isArray(rawConcurrency)) {
    for (const [adapterType, value] of Object.entries(rawConcurrency as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 50) {
        adapterConcurrency[adapterType] = value;
      }
    }
  }
  const adapterDailyRunBudgets: InstanceRunControls["adapterDailyRunBudgets"] = {};
  const rawDailyBudgets = candidate.adapterDailyRunBudgets;
  if (rawDailyBudgets && typeof rawDailyBudgets === "object" && !Array.isArray(rawDailyBudgets)) {
    for (const [adapterType, value] of Object.entries(rawDailyBudgets as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const budget = value as Record<string, unknown>;
      const maxRunsPerDay = typeof budget.maxRunsPerDay === "number" && Number.isInteger(budget.maxRunsPerDay)
        ? budget.maxRunsPerDay
        : null;
      if (maxRunsPerDay === null || maxRunsPerDay < 0 || maxRunsPerDay > 100_000) continue;
      const alertThresholdPct = typeof budget.alertThresholdPct === "number" && Number.isInteger(budget.alertThresholdPct)
        ? budget.alertThresholdPct
        : 70;
      adapterDailyRunBudgets[adapterType] = {
        maxRunsPerDay,
        alertThresholdPct: Math.min(100, Math.max(1, alertThresholdPct)),
      };
    }
  }
  return {
    pauseAll: candidate.pauseAll ? readPauseRecord(candidate.pauseAll) : null,
    adapterPauses,
    adapterConcurrency,
    adapterDailyRunBudgets,
    globalConcurrency:
      (
        typeof candidate.globalConcurrency === "number"
        && Number.isInteger(candidate.globalConcurrency)
        && candidate.globalConcurrency >= 1
        && candidate.globalConcurrency <= 100
      )
        ? candidate.globalConcurrency
        : DEFAULT_GLOBAL_CONCURRENCY,
  };
}

export function resolveAdapterConcurrencyCap(
  controls: InstanceRunControls,
  adapterType: string,
): number | null {
  if (isConcurrencyExemptAdapterType(adapterType)) return null;
  const explicit = controls.adapterConcurrency[adapterType];
  if (typeof explicit === "number") return explicit;
  const fallback = controls.adapterConcurrency.default;
  return typeof fallback === "number" ? fallback : null;
}

export function isConcurrencyExemptAdapterType(adapterType: string | null | undefined): boolean {
  return !!adapterType && (CONCURRENCY_EXEMPT_ADAPTER_TYPES as readonly string[]).includes(adapterType);
}

export function isActivityWindowExemptAgent(input: {
  adapterType: string | null | undefined;
  runtimeConfig: Record<string, unknown> | null | undefined;
}): boolean {
  if (
    input.adapterType &&
    (ACTIVITY_WINDOW_EXEMPT_ADAPTER_TYPES as readonly string[]).includes(input.adapterType)
  ) {
    return true;
  }
  return input.runtimeConfig?.[IGNORE_ACTIVITY_WINDOW_RUNTIME_CONFIG_KEY] === true;
}

export interface ActivityWindowScheduleSkip {
  /** Human-readable reason, mirrors the run-gate's outside_activity_window text. */
  reason: string;
  /** When the window next opens (the boundary at which the agent should be re-enqueued). */
  nextChangeAt: Date | null;
}

/**
 * Skip-at-schedule companion to the run gate's `outside_activity_window` block.
 *
 * The run gate is a DEFER-and-retry choke point: an out-of-window run is left
 * queued and re-evaluated every tick, so scheduled wakeups for a closed company
 * pile up and read as "frozen". This helper lets the *scheduler* suppress those
 * automated wakeups at the source — if it returns non-null, the caller must NOT
 * enqueue the run, so nothing queues in the first place.
 *
 * It reuses the EXACT same window + exemption rules as `getRunGateBlock`:
 *   - shell-handler / compiler adapters (ACTIVITY_WINDOW_EXEMPT_ADAPTER_TYPES)
 *     and `runtimeConfig.ignoreActivityWindow` agents are exempt -> never skipped
 *     (they run the around-window handshake/liveness and the hourly evals).
 *   - a company with no window, or one whose window is currently open, is never
 *     skipped.
 *
 * Importantly this does NOT touch the agent's due-time / lastHeartbeatAt: a
 * skipped tick leaves the agent due, so the first in-window tick enqueues it
 * normally. The run-gate `outside_activity_window` defer remains as a safety net
 * for any run created via another path.
 */
export function getActivityWindowScheduleSkip(input: {
  activityWindow: unknown;
  adapterType: string | null | undefined;
  runtimeConfig: Record<string, unknown> | null | undefined;
  companyName?: string | null;
  now?: Date;
}): ActivityWindowScheduleSkip | null {
  const window = parseCompanyActivityWindow(input.activityWindow);
  if (!window) return null;
  if (isActivityWindowExemptAgent({ adapterType: input.adapterType, runtimeConfig: input.runtimeConfig })) {
    return null;
  }
  const state = getActivityWindowState(window, input.now ?? new Date());
  if (state.open) return null;
  const label = input.companyName ? `Company ${input.companyName}` : "Company";
  return {
    reason: `${label} is outside its sprint window; scheduled wakeup skipped until it opens at ${formatActivityWindowOpensAt(window)}.`,
    nextChangeAt: state.nextChangeAt,
  };
}

export interface CompanyRunGateStatus {
  activityWindow: CompanyActivityWindow | null;
  activityWindowState: CompanyActivityWindowState | null;
  runPause: CompanyRunPauseState;
  instancePause: InstanceRunPause | null;
  adapterPauses: Record<string, InstanceRunPause>;
}

export function runGateService(db: Db) {
  async function getInstanceRunControls(): Promise<InstanceRunControls> {
    const row = await db
      .select({ runControls: instanceSettings.runControls })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, INSTANCE_SETTINGS_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    return normalizeInstanceRunControls(row?.runControls ?? {});
  }

  async function getCompanyGateRow(companyId: string) {
    return db
      .select({
        id: companies.id,
        name: companies.name,
        activityWindow: companies.activityWindow,
        runPauseState: companies.runPauseState,
        emergencyStopState: companies.emergencyStopState,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function countRunningRunsForAdapterType(adapterType: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(and(eq(heartbeatRuns.status, "running"), eq(agents.adapterType, adapterType)));
    return Number(row?.count ?? 0);
  }

  async function countRunningRunsGlobal(): Promise<number> {
    // Exempt adapters must not OCCUPY the cap either: shell handlers are
    // near-zero cost and were never meant to be governed by it, but their
    // running rows filled the counter that gates real LLM runs — a shell
    // rail burst deferred claude/codex work behind phantom occupancy
    // (2026-08-20: 5 LLM runs "hit" a cap of 20). Exemption must be
    // symmetric: not blocked by the cap, not counted against it.
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(and(
        eq(heartbeatRuns.status, "running"),
        sql`${agents.adapterType} NOT IN ('paperclip_shell_handler')`,
      ));
    return Number(row?.count ?? 0);
  }

  async function getRunGateBlock(input: RunGateAgentContext): Promise<RunGateBlock | null> {
    const now = input.now ?? new Date();

    let adapterType = input.adapterType ?? null;
    let runtimeConfig = input.agentRuntimeConfig ?? null;
    if (adapterType === null || adapterType === undefined) {
      const agent = await db
        .select({ adapterType: agents.adapterType, runtimeConfig: agents.runtimeConfig })
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .then((rows) => rows[0] ?? null);
      adapterType = agent?.adapterType ?? null;
      runtimeConfig = agent?.runtimeConfig ?? runtimeConfig;
    }

    const controls = await getInstanceRunControls();
    if (controls.pauseAll) {
      return {
        kind: "instance_paused",
        reason: controls.pauseAll.reason
          ? `Instance is paused: ${controls.pauseAll.reason}`
          : "Instance is paused; runs are deferred until it is resumed.",
        nextChangeAt: null,
      };
    }
    if (adapterType && controls.adapterPauses[adapterType]) {
      const pause = controls.adapterPauses[adapterType];
      return {
        kind: "adapter_family_paused",
        reason: pause.reason
          ? `Adapter family ${adapterType} is paused: ${pause.reason}`
          : `Adapter family ${adapterType} is paused; runs are deferred until it is resumed.`,
        nextChangeAt: null,
      };
    }

    const company = await getCompanyGateRow(input.companyId);
    if (company) {
      const runPause = parseCompanyRunPauseState(company.runPauseState);
      if (runPause.active) {
        return {
          kind: "company_paused",
          reason: runPause.reason
            ? `Company ${company.name} is paused: ${runPause.reason}`
            : `Company ${company.name} is paused; runs are deferred until it is resumed.`,
          nextChangeAt: null,
        };
      }

      const emergencyStop = readActiveEmergencyStop(company.emergencyStopState);
      if (emergencyStop) {
        return {
          kind: "company_paused",
          reason: emergencyStop.reason
            ? `Company ${company.name} is under an emergency stop (${emergencyStop.mode}): ${emergencyStop.reason}`
            : `Company ${company.name} is under an emergency stop (${emergencyStop.mode}); runs are deferred until it is cleared.`,
          nextChangeAt: null,
        };
      }

      const window = parseCompanyActivityWindow(company.activityWindow);
      if (
        window
        && !input.isManualOverride
        && !isActivityWindowExemptAgent({ adapterType, runtimeConfig })
      ) {
        const state = getActivityWindowState(window, now);
        if (!state.open) {
          return {
            kind: "outside_activity_window",
            reason: `Company ${company.name} is outside its sprint window; runs are deferred until it opens at ${formatActivityWindowOpensAt(window)}.`,
            nextChangeAt: state.nextChangeAt,
          };
        }
      }
    }

    if (adapterType) {
      const cap = resolveAdapterConcurrencyCap(controls, adapterType);
      if (cap !== null) {
        const running = await countRunningRunsForAdapterType(adapterType);
        if (running >= cap) {
          return {
            kind: "adapter_concurrency_limit",
            reason: `Adapter type ${adapterType} is at its concurrency limit (${running}/${cap} running); run is deferred until a slot frees up.`,
            nextChangeAt: null,
          };
        }
      }
    }

    if (!isConcurrencyExemptAdapterType(adapterType)) {
      const runningGlobal = await countRunningRunsGlobal();
      if (runningGlobal >= controls.globalConcurrency) {
        return {
          kind: "global_concurrency_limit",
          reason:
            `Instance is at its global concurrency limit `
            + `(${runningGlobal}/${controls.globalConcurrency} running); run is deferred until a slot frees up.`,
          nextChangeAt: null,
        };
      }
    }

    return null;
  }

  async function getCompanyRunGateStatus(
    companyId: string,
    now: Date = new Date(),
  ): Promise<CompanyRunGateStatus | null> {
    const company = await getCompanyGateRow(companyId);
    if (!company) return null;
    const controls = await getInstanceRunControls();
    const window = parseCompanyActivityWindow(company.activityWindow);
    return {
      activityWindow: window,
      activityWindowState: window ? getActivityWindowState(window, now) : null,
      runPause: parseCompanyRunPauseState(company.runPauseState),
      instancePause: controls.pauseAll,
      adapterPauses: controls.adapterPauses,
    };
  }

  return {
    getInstanceRunControls,
    getRunGateBlock,
    getCompanyRunGateStatus,
  };
}

export type RunGateService = ReturnType<typeof runGateService>;
