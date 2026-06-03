import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { budgetCaps, costEvents, costEventsWindowAgg } from "@paperclipai/db";
import {
  type BudgetCapAction,
  type CapEvaluation,
  type CapResolution,
  capFiringAction,
  calendarWindowBounds,
  isCalendarWindow,
  resolveBindingCap,
  rollingWindowBounds,
} from "@paperclipai/shared";

// Cap evaluation for the budgeting lifecycle endpoints (policy §4). Mirrors the
// SQL cost_events_scope_projection (migration 0099): a single charge attributes
// to one (scope, scopeKey) per dimension it carries. We load the active caps for
// those scopes, read each cap's window spend (calendar windows from the
// inline-maintained cost_events_window_agg; rolling/total windows live off
// cost_events), and resolve the binding cap via the §2.3 precedence function.

export interface ChargeAttribution {
  companyId: string;
  agentId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  issueId?: string | null;
  provider: string;
  model: string;
  billingCode?: string | null;
}

export interface ScopeRef {
  scope: string;
  scopeKey: string;
}

// The (scope, scopeKey) pairs a charge attributes to, derived from the row
// alone. agent-template / route / routine are intentionally omitted — they are
// not derivable from a cost_events row (same omission as the SQL projection).
export function scopeProjection(attr: ChargeAttribution): ScopeRef[] {
  const refs: ScopeRef[] = [
    { scope: "cluster", scopeKey: "_" },
    { scope: "company", scopeKey: attr.companyId },
    { scope: "provider", scopeKey: attr.provider },
    { scope: "model", scopeKey: `${attr.provider}:${attr.model}` },
  ];
  if (attr.agentId) refs.push({ scope: "agent", scopeKey: attr.agentId });
  if (attr.projectId) refs.push({ scope: "project", scopeKey: attr.projectId });
  if (attr.goalId) refs.push({ scope: "goal", scopeKey: attr.goalId });
  if (attr.issueId) refs.push({ scope: "issue", scopeKey: attr.issueId });
  if (attr.billingCode) refs.push({ scope: "billingCode", scopeKey: attr.billingCode });
  return refs;
}

type CapRow = typeof budgetCaps.$inferSelect;

export interface CapFiring extends CapEvaluation {
  cap: CapRow;
  spendMicros: number;
  limitMicros: number;
}

export interface CapEvalResult {
  applicableCaps: CapRow[];
  firing: CapFiring[];
  resolution: CapResolution;
  // Remaining budget to the cap limit, min across applicable caps (clamped ≥0).
  // Null when no cap binds/applies (unbounded; 0 would be misleading "no budget").
  headroomMicros: number | null;
  // Remaining budget to the hard-stop line, min across applicable caps (§4.4).
  // Null when no cap binds/applies.
  softHeadroomMicros: number | null;
  warnings: Array<{ capId: string; percent: number }>;
}

// Filter, in TS, the loaded caps down to the ones that actually apply to this
// charge. Exact (scope, scopeKey) match for every dimension except billingCode,
// where a cap's scopeKey is a prefix (policy §2.2: `code/%`).
function capApplies(cap: CapRow, attr: ChargeAttribution, refs: ScopeRef[]): boolean {
  if (cap.scope === "billingCode") {
    const code = attr.billingCode;
    if (!code) return false;
    // §2.2: a billingCode cap's scopeKey is a hierarchical prefix (`code/%`).
    return code === cap.scopeKey || code.startsWith(`${cap.scopeKey}/`);
  }
  return refs.some((r) => r.scope === cap.scope && r.scopeKey === cap.scopeKey);
}

export function budgetCapsService(db: Db) {
  // Live spend for a cap whose window is rolling_* or total — summed straight
  // off cost_events for the cap's scope. Calendar windows never reach here.
  async function rollingSpendMicros(cap: CapRow, attr: ChargeAttribution, at: Date): Promise<number> {
    const bounds = rollingWindowBounds(cap.window as never, at);
    const conds = [] as ReturnType<typeof eq>[];

    switch (cap.scope) {
      case "cluster":
        break; // cross-tenant: no company filter
      case "company":
        conds.push(eq(costEvents.companyId, cap.scopeKey));
        break;
      case "project":
        conds.push(eq(costEvents.projectId, cap.scopeKey));
        break;
      case "goal":
        conds.push(eq(costEvents.goalId, cap.scopeKey));
        break;
      case "agent":
        conds.push(eq(costEvents.agentId, cap.scopeKey));
        break;
      case "issue":
        conds.push(eq(costEvents.issueId, cap.scopeKey));
        break;
      case "provider":
        conds.push(eq(costEvents.provider, cap.scopeKey));
        break;
      case "model": {
        const idx = cap.scopeKey.indexOf(":");
        const provider = idx >= 0 ? cap.scopeKey.slice(0, idx) : cap.scopeKey;
        const model = idx >= 0 ? cap.scopeKey.slice(idx + 1) : "";
        conds.push(eq(costEvents.provider, provider), eq(costEvents.model, model));
        break;
      }
      case "billingCode":
        // Exact code or a hierarchical descendant (`scopeKey/%`), matching the
        // §2.2 prefix semantics in capApplies().
        conds.push(
          or(
            eq(costEvents.billingCode, cap.scopeKey),
            sql`${costEvents.billingCode} LIKE ${`${cap.scopeKey}/%`}`,
          ) as never,
        );
        break;
      default:
        // route / routine / agent-template are not derivable from cost_events.
        return 0;
    }

    if (bounds.windowStart) conds.push(gte(costEvents.occurredAt, bounds.windowStart));
    conds.push(lt(costEvents.occurredAt, bounds.windowEnd));

    const [row] = await db
      .select({ spend: sql<number>`coalesce(sum(${costEvents.costMicros}), 0)::double precision` })
      .from(costEvents)
      .where(and(...conds));
    return Number(row?.spend ?? 0);
  }

  // Calendar-window spend: read the inline-maintained rollup by its exact key.
  async function calendarSpendMicros(cap: CapRow, at: Date): Promise<number> {
    const { windowKey } = calendarWindowBounds(cap.window as never, at);
    const [row] = await db
      .select({ spend: costEventsWindowAgg.spendMicros })
      .from(costEventsWindowAgg)
      .where(
        and(
          eq(costEventsWindowAgg.scope, cap.scope),
          eq(costEventsWindowAgg.scopeKey, cap.scopeKey),
          eq(costEventsWindowAgg.windowKey, windowKey),
        ),
      );
    return Number(row?.spend ?? 0);
  }

  async function capSpendMicros(cap: CapRow, attr: ChargeAttribution, at: Date): Promise<number> {
    return isCalendarWindow(cap.window) ? calendarSpendMicros(cap, at) : rollingSpendMicros(cap, attr, at);
  }

  return {
    scopeProjection,

    // Evaluate every active cap that applies to this charge. `addMicros` is the
    // prospective spend to fold in before comparing to the limit — the estimate
    // at preflight, and 0 at charge (the row is already in the rollup).
    async evaluate(
      attr: ChargeAttribution,
      opts: { at?: Date; addMicros?: number } = {},
    ): Promise<CapEvalResult> {
      const at = opts.at ?? new Date();
      const addMicros = opts.addMicros ?? 0;
      const refs = scopeProjection(attr);

      // Load active, unexpired caps for this tenant plus all cluster caps.
      const loaded = await db
        .select()
        .from(budgetCaps)
        .where(
          and(
            eq(budgetCaps.isActive, true),
            or(eq(budgetCaps.companyId, attr.companyId), eq(budgetCaps.scope, "cluster")),
            or(isNull(budgetCaps.expiresAt), gte(budgetCaps.expiresAt, at)),
          ),
        );

      const applicableCaps = loaded.filter((cap) => capApplies(cap, attr, refs));

      const firing: CapFiring[] = [];
      const warnings: Array<{ capId: string; percent: number }> = [];
      let headroomMicros = Number.POSITIVE_INFINITY;
      let softHeadroomMicros = Number.POSITIVE_INFINITY;

      for (const cap of applicableCaps) {
        const spend = (await capSpendMicros(cap, attr, at)) + addMicros;
        const limit = Number(cap.limitMicros);
        const currentPercent = limit > 0 ? (spend / limit) * 100 : spend > 0 ? Infinity : 0;

        headroomMicros = Math.min(headroomMicros, Math.max(0, limit - spend));
        const hardStopLine = (limit * cap.hardStopAtPercent) / 100;
        softHeadroomMicros = Math.min(softHeadroomMicros, Math.max(0, hardStopLine - spend));

        const action = capFiringAction(
          { ...cap, action: cap.action as BudgetCapAction },
          currentPercent,
        );
        if (!action) continue;

        warnings.push({ capId: cap.id, percent: Number(currentPercent.toFixed(2)) });
        firing.push({
          cap,
          spendMicros: spend,
          limitMicros: limit,
          capId: cap.id,
          scope: cap.scope,
          scopeKey: cap.scopeKey,
          action,
          currentPercent,
          approvalGate: cap.approvalGate as CapEvaluation["approvalGate"],
          // Approval-grant relaxation is wired by the runtime gate (ELI-77);
          // until then no per-company grant relaxes a firing cap.
          relaxed: false,
        });
      }

      const resolution = resolveBindingCap(firing);

      return {
        applicableCaps,
        firing,
        resolution,
        // Sentinel null (not 0) when no caps apply: 0 would misleadingly read as "no budget left".
        headroomMicros: Number.isFinite(headroomMicros) ? headroomMicros : null,
        softHeadroomMicros: Number.isFinite(softHeadroomMicros) ? softHeadroomMicros : null,
        warnings,
      };
    },
  };
}

export type BudgetCapsService = ReturnType<typeof budgetCapsService>;
export type { BudgetCapAction };
