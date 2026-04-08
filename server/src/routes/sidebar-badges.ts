import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { and, eq, sql } from "drizzle-orm";
import { joinRequests } from "@ironworksai/db";
import { sidebarBadgeService } from "../services/sidebar-badges.js";
import { accessService } from "../services/access.js";
import { dashboardService } from "../services/dashboard.js";
import { assertCompanyAccess } from "./authz.js";

// In-memory cache for sidebar badge results (badges don't need to be real-time)
type CachedBadgeEntry = { value: ReturnType<typeof computeBadges> extends Promise<infer T> ? T : never; expiresAt: number };
const badgeCache = new Map<string, { value: unknown; expiresAt: number }>();
const BADGE_CACHE_TTL_MS = 30_000; // 30 seconds

function getCachedBadges(cacheKey: string): unknown | null {
  const entry = badgeCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    badgeCache.delete(cacheKey);
    return null;
  }
  return entry.value;
}

function setCachedBadges(cacheKey: string, value: unknown): void {
  badgeCache.set(cacheKey, { value, expiresAt: Date.now() + BADGE_CACHE_TTL_MS });
}

// Suppress unused type alias — used implicitly via the cache map
void ({} as CachedBadgeEntry);

async function computeBadges(
  db: Db,
  svc: ReturnType<typeof sidebarBadgeService>,
  access: ReturnType<typeof accessService>,
  dashboard: ReturnType<typeof dashboardService>,
  companyId: string,
  actorType: string,
  actorSource: string | undefined,
  actorIsInstanceAdmin: boolean | undefined,
  actorUserId: string,
  actorAgentId: string | undefined,
) {
  // Step 1: resolve join-approve permission (needed before counting join requests)
  let canApproveJoins = false;
  if (actorType === "board") {
    canApproveJoins =
      actorSource === "local_implicit" ||
      Boolean(actorIsInstanceAdmin) ||
      (await access.canUser(companyId, actorUserId, "joins:approve"));
  } else if (actorType === "agent" && actorAgentId) {
    canApproveJoins = await access.hasPermission(companyId, "agent", actorAgentId, "joins:approve");
  }

  // Step 2: fetch join request count (depends on canApproveJoins) and all badge/summary data in parallel
  const joinRequestCountPromise = canApproveJoins
    ? db
      .select({ count: sql<number>`count(*)` })
      .from(joinRequests)
      .where(and(eq(joinRequests.companyId, companyId), eq(joinRequests.status, "pending_approval")))
      .then((rows) => Number(rows[0]?.count ?? 0))
    : Promise.resolve(0);

  const [joinRequestCount, badges, summary] = await Promise.all([
    joinRequestCountPromise,
    svc.get(companyId),
    dashboard.summary(companyId),
  ]);

  const hasFailedRuns = badges.failedRuns > 0;
  const alertsCount =
    (summary.agents.error > 0 && !hasFailedRuns ? 1 : 0) +
    (summary.costs.monthBudgetCents > 0 && summary.costs.monthUtilizationPercent >= 80 ? 1 : 0);
  badges.inbox = badges.failedRuns + alertsCount + joinRequestCount + badges.approvals;
  badges.joinRequests = joinRequestCount;

  return badges;
}

export function sidebarBadgeRoutes(db: Db) {
  const router = Router();
  const svc = sidebarBadgeService(db);
  const access = accessService(db);
  const dashboard = dashboardService(db);

  router.get("/companies/:companyId/sidebar-badges", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    // Build a cache key scoped to company + actor (permission-sensitive)
    const actorKey = req.actor.type === "board" ? `user:${req.actor.userId}` : `agent:${req.actor.agentId ?? "anon"}`;
    const cacheKey = `${companyId}:${actorKey}`;

    const cached = getCachedBadges(cacheKey);
    if (cached !== null) {
      res.json(cached);
      return;
    }

    const result = await computeBadges(
      db,
      svc,
      access,
      dashboard,
      companyId,
      req.actor.type,
      req.actor.type === "board" ? req.actor.source : undefined,
      req.actor.type === "board" ? req.actor.isInstanceAdmin : undefined,
      req.actor.type === "board" ? (req.actor.userId ?? "") : "",
      req.actor.type === "agent" ? req.actor.agentId : undefined,
    );

    setCachedBadges(cacheKey, result);
    res.json(result);
  });

  return router;
}
