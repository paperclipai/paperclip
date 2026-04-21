// ---------------------------------------------------------------------------
// Gateway routing service — multi-vendor model routing with rate limiting,
// circuit breaking, and weighted load balancing.
// ---------------------------------------------------------------------------

import { eq, and, desc, asc, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { gatewayRoutes, gatewayCircuitState, gatewayUsageCounters } from "@paperclipai/db";
import type { GatewayCircuitBreakerState, GatewayRouteHealth } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// In-memory rate-limit counters (fast reads, periodic DB flush)
// ---------------------------------------------------------------------------

interface WindowCounter {
  tokens: number;
  requests: number;
}

/** routeId → windowType → windowKey → counter */
const counters = new Map<string, Map<string, Map<string, WindowCounter>>>();

function getWindowKey(windowType: "minute" | "hour" | "day"): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const mi = String(now.getUTCMinutes()).padStart(2, "0");
  switch (windowType) {
    case "minute": return `${y}-${mo}-${d}T${h}:${mi}`;
    case "hour":   return `${y}-${mo}-${d}T${h}`;
    case "day":    return `${y}-${mo}-${d}`;
  }
}

function getCounter(routeId: string, windowType: "minute" | "hour" | "day"): WindowCounter {
  const key = getWindowKey(windowType);
  let routeMap = counters.get(routeId);
  if (!routeMap) { routeMap = new Map(); counters.set(routeId, routeMap); }
  let windowMap = routeMap.get(windowType);
  if (!windowMap) { windowMap = new Map(); routeMap.set(windowType, windowMap); }
  let counter = windowMap.get(key);
  if (!counter) {
    windowMap.clear(); // New window — clear old keys
    counter = { tokens: 0, requests: 0 };
    windowMap.set(key, counter);
  }
  return counter;
}

function getUsageSnapshot(routeId: string): GatewayRouteHealth["usage"] {
  return {
    minute: { ...getCounter(routeId, "minute") },
    hour:   { ...getCounter(routeId, "hour") },
    day:    { ...getCounter(routeId, "day") },
  };
}

// ---------------------------------------------------------------------------
// In-memory circuit breaker state
// ---------------------------------------------------------------------------

interface CircuitState {
  state: GatewayCircuitBreakerState;
  failureCount: number;
  lastFailureAt: Date | null;
  openedAt: Date | null;
}

const circuitStates = new Map<string, CircuitState>();

function getCircuitState(routeId: string): CircuitState {
  let state = circuitStates.get(routeId);
  if (!state) {
    state = { state: "closed", failureCount: 0, lastFailureAt: null, openedAt: null };
    circuitStates.set(routeId, state);
  }
  return state;
}

async function persistCircuitState(db: Db, routeId: string, state: CircuitState): Promise<void> {
  try {
    await db.insert(gatewayCircuitState).values({
      routeId,
      state: state.state,
      failureCount: state.failureCount,
      lastFailureAt: state.lastFailureAt,
      openedAt: state.openedAt,
    }).onConflictDoUpdate({
      target: gatewayCircuitState.routeId,
      set: {
        state: state.state,
        failureCount: state.failureCount,
        lastFailureAt: state.lastFailureAt,
        openedAt: state.openedAt,
        updatedAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn({ routeId, err }, "Failed to persist circuit breaker state");
  }
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------

export interface GatewayRouteDecision {
  routeId: string;
  adapterType: string;
  model: string;
  timeoutSec: number | null;
  adapterConfigOverrides: Record<string, unknown> | null;
}

type RouteRow = typeof gatewayRoutes.$inferSelect;

/**
 * Resolve which gateway route to use for a given agent.
 * Returns null if no gateway routes are configured or all are exhausted.
 */
export async function resolveRoute(
  db: Db,
  agentId: string,
  companyId: string,
): Promise<GatewayRouteDecision | null> {
  const routes = await db
    .select()
    .from(gatewayRoutes)
    .where(and(eq(gatewayRoutes.companyId, companyId), eq(gatewayRoutes.isEnabled, true)))
    .orderBy(desc(gatewayRoutes.priority), asc(gatewayRoutes.createdAt));

  // Merge agent-specific and company-wide routes into a single candidate pool.
  // Agent-specific routes are already preferred via natural priority ordering;
  // if all agent routes are exhausted/tripped, the loop falls through to
  // company-wide routes instead of returning null (default adapter).
  const agentRoutes = routes.filter((r: RouteRow) => r.agentId === agentId);
  const companyRoutes = routes.filter((r: RouteRow) => r.agentId === null);
  const candidates = [...agentRoutes, ...companyRoutes];
  if (candidates.length === 0) return null;

  // Group by priority for weighted load balancing
  const byPriority = new Map<number, RouteRow[]>();
  for (const route of candidates) {
    const group = byPriority.get(route.priority) ?? [];
    group.push(route);
    byPriority.set(route.priority, group);
  }

  const priorities = Array.from(byPriority.keys()).sort((a, b) => b - a);

  for (const priority of priorities) {
    const group = byPriority.get(priority)!;
    const available = group.filter((route: RouteRow) => isRouteAvailable(db, route));
    if (available.length === 0) continue;

    // Within the same priority tier, prefer agent-specific routes over
    // company-wide ones. Only fall back to company-wide if no agent-specific
    // routes are available at this priority level.
    const agentSpecific = available.filter((r: RouteRow) => r.agentId !== null);
    const pool = agentSpecific.length > 0 ? agentSpecific : available;

    const selected = weightedSelect(pool);
    if (selected) {
      return {
        routeId: selected.id,
        adapterType: selected.adapterType,
        model: selected.model,
        timeoutSec: selected.timeoutSec,
        adapterConfigOverrides: (selected.adapterConfigOverrides as Record<string, unknown>) ?? null,
      };
    }
  }
  return null;
}

function isRouteAvailable(db: Db, route: RouteRow): boolean {
  if (route.circuitBreakerEnabled) {
    const circuit = getCircuitState(route.id);
    if (circuit.state === "open") {
      if (circuit.openedAt) {
        const elapsed = (Date.now() - circuit.openedAt.getTime()) / 1000;
        if (elapsed < route.circuitBreakerResetSec) return false;
        circuit.state = "half_open"; // cooldown elapsed, allow probe
        void persistCircuitState(db, route.id, circuit);
      } else {
        return false;
      }
    }
  }
  return checkRateLimit(route);
}

function checkRateLimit(route: RouteRow): boolean {
  const windows: Array<{ type: "minute" | "hour" | "day"; tokenLimit: number | null; requestLimit: number | null }> = [
    { type: "minute", tokenLimit: route.quotaTokensPerMinute, requestLimit: route.quotaRequestsPerMinute },
    { type: "hour",   tokenLimit: route.quotaTokensPerHour,   requestLimit: route.quotaRequestsPerHour },
    { type: "day",    tokenLimit: route.quotaTokensPerDay,    requestLimit: route.quotaRequestsPerDay },
  ];
  for (const { type, tokenLimit, requestLimit } of windows) {
    const counter = getCounter(route.id, type);
    if (tokenLimit != null && counter.tokens >= tokenLimit) return false;
    if (requestLimit != null && counter.requests >= requestLimit) return false;
  }
  return true;
}

function weightedSelect(items: RouteRow[]): RouteRow | null {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return items[0];
  let random = Math.random() * totalWeight;
  for (const item of items) {
    random -= item.weight;
    if (random <= 0) return item;
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------------------
// Post-execution recording
// ---------------------------------------------------------------------------

async function persistUsageCounter(
  db: Db,
  routeId: string,
  windowType: "minute" | "hour" | "day",
  tokens: number,
  requests: number,
): Promise<void> {
  try {
    const key = getWindowKey(windowType);
    await db
      .insert(gatewayUsageCounters)
      .values({
        routeId,
        windowType,
        windowKey: key,
        tokenCount: tokens,
        requestCount: requests,
      })
      .onConflictDoUpdate({
        target: [gatewayUsageCounters.routeId, gatewayUsageCounters.windowType, gatewayUsageCounters.windowKey],
        set: {
          tokenCount: sql`${gatewayUsageCounters.tokenCount} + ${tokens}`,
          requestCount: sql`${gatewayUsageCounters.requestCount} + ${requests}`,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    logger.warn({ routeId, windowType, err }, "Failed to persist usage counter");
  }
}

export async function recordSuccess(db: Db, routeId: string, tokenCount: number): Promise<void> {
  for (const type of ["minute", "hour", "day"] as const) {
    const counter = getCounter(routeId, type);
    counter.tokens += tokenCount;
    counter.requests += 1;
    void persistUsageCounter(db, routeId, type, tokenCount, 1);
  }
  const circuit = getCircuitState(routeId);
  if (circuit.state === "half_open" || circuit.failureCount > 0) {
    circuit.state = "closed";
    circuit.failureCount = 0;
    circuit.lastFailureAt = null;
    circuit.openedAt = null;
    await persistCircuitState(db, routeId, circuit);
  }
}

export async function recordFailure(db: Db, routeId: string): Promise<void> {
  for (const type of ["minute", "hour", "day"] as const) {
    getCounter(routeId, type).requests += 1;
    void persistUsageCounter(db, routeId, type, 0, 1);
  }
  const [route] = await db.select().from(gatewayRoutes).where(eq(gatewayRoutes.id, routeId)).limit(1);
  if (!route?.circuitBreakerEnabled) return;

  const circuit = getCircuitState(routeId);
  circuit.failureCount += 1;
  circuit.lastFailureAt = new Date();

  if (circuit.state === "half_open") {
    circuit.state = "open";
    circuit.openedAt = new Date();
  } else if (circuit.failureCount >= route.circuitBreakerFailureThreshold) {
    circuit.state = "open";
    circuit.openedAt = new Date();
  }
  await persistCircuitState(db, routeId, circuit);
}

export async function resetCircuit(db: Db, routeId: string): Promise<void> {
  const circuit = getCircuitState(routeId);
  circuit.state = "closed";
  circuit.failureCount = 0;
  circuit.lastFailureAt = null;
  circuit.openedAt = null;
  await persistCircuitState(db, routeId, circuit);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listRoutes(db: Db, companyId: string, agentId?: string) {
  const routes = await db.select().from(gatewayRoutes)
    .where(eq(gatewayRoutes.companyId, companyId))
    .orderBy(desc(gatewayRoutes.priority), asc(gatewayRoutes.createdAt));
  if (!agentId) return routes;
  // When filtering by agent, return agent-specific routes + company-wide (agentId=null)
  return routes.filter((r: RouteRow) => r.agentId === agentId || r.agentId === null);
}

export async function getRoute(db: Db, routeId: string) {
  const [route] = await db.select().from(gatewayRoutes).where(eq(gatewayRoutes.id, routeId)).limit(1);
  return route ?? null;
}

export async function createRoute(db: Db, data: typeof gatewayRoutes.$inferInsert) {
  const [route] = await db.insert(gatewayRoutes).values(data).returning();
  return route;
}

export async function updateRoute(db: Db, routeId: string, data: Partial<typeof gatewayRoutes.$inferInsert>) {
  const [route] = await db.update(gatewayRoutes)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(gatewayRoutes.id, routeId))
    .returning();
  return route ?? null;
}

export async function deleteRoute(db: Db, routeId: string) {
  await db.delete(gatewayRoutes).where(eq(gatewayRoutes.id, routeId));
  counters.delete(routeId);
  circuitStates.delete(routeId);
}

// ---------------------------------------------------------------------------
// Health / stats
// ---------------------------------------------------------------------------

export function getRouteHealth(routeId: string): GatewayRouteHealth {
  const circuit = getCircuitState(routeId);
  return {
    routeId,
    circuitState: circuit.state,
    failureCount: circuit.failureCount,
    lastFailureAt: circuit.lastFailureAt,
    openedAt: circuit.openedAt,
    usage: getUsageSnapshot(routeId),
  };
}

export async function getRoutesHealth(db: Db, companyId: string): Promise<GatewayRouteHealth[]> {
  const routes = await listRoutes(db, companyId);
  return routes.map((r: RouteRow) => getRouteHealth(r.id));
}

export async function loadPersistedCircuitStates(db: Db): Promise<void> {
  try {
    const rows = await db.select().from(gatewayCircuitState);
    for (const row of rows) {
      circuitStates.set(row.routeId, {
        state: row.state as GatewayCircuitBreakerState,
        failureCount: row.failureCount,
        lastFailureAt: row.lastFailureAt,
        openedAt: row.openedAt,
      });
    }
    if (rows.length > 0) {
      logger.info({ count: rows.length }, "Loaded persisted gateway circuit breaker states");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load persisted gateway circuit states");
  }
}

/** Delete usage counter rows older than 7 days to prevent unbounded table growth. */
export async function purgeStaleUsageCounters(db: Db): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const deleted = await db.delete(gatewayUsageCounters)
      .where(lt(gatewayUsageCounters.updatedAt, cutoff))
      .returning();
    return deleted.length;
  } catch (err) {
    logger.warn({ err }, "Failed to purge stale gateway usage counters");
    return 0;
  }
}
