// Daily Microsoft Entra group reconciler (BLO-6295 piece D, "Daily
// background job too" cadence).
//
// Why:
//   The signin-time reconciler in auth/better-auth.ts only fires when a
//   user actively signs in. If a user is REMOVED from AdminAgents in
//   Entra and never signs in again, their pending admin-elevation
//   approval would sit forever; if they're removed from ssh-users their
//   company membership would persist indefinitely (the signin path
//   doesn't see them either).
//
//   This service loops every MICROSOFT_GROUP_RECONCILE_INTERVAL_HOURS
//   (default 24h) over every paperclip user that has a Microsoft
//   account linked, queries Graph for their current group memberships,
//   and applies reconcileMicrosoftUser. Off-boarding is deliberately
//   conservative — reconcileMicrosoftUser does NOT auto-archive
//   memberships when ssh-users drops (a transient Graph outage that
//   returns empty groups would mass-remove the team); off-boarding is
//   a Board action.
//
// Gated on MICROSOFT_GROUP_RECONCILE_ENABLED=true (default off). Only
// runs on PAPERCLIP_NODE_ROLE in {worker, all} so an HA API tier
// doesn't spin up parallel reconcilers.

import type { Db } from "@paperclipai/db";
import { authAccounts } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  loadMicrosoftRbacConfig,
  reconcileMicrosoftUser,
  type MicrosoftRbacConfig,
} from "../auth/microsoft-rbac.js";
import { getEntraUserGroupIds } from "../auth/microsoft-graph-client.js";

export interface MicrosoftGroupReconcilerHandle {
  stop(): void;
}

interface StartOptions {
  db: Db;
  intervalHours?: number;
  /** Inject for tests so we can step the clock without sleeping 24h. */
  _now?: () => number;
  _getGroups?: (upn: string) => Promise<string[] | null>;
}

export async function reconcileAllMicrosoftUsers(
  db: Db,
  options: { getGroups?: (upn: string) => Promise<string[] | null> } = {},
): Promise<{
  scanned: number;
  graphFailed: number;
  addedMemberships: number;
  pendingAdminElevations: number;
}> {
  const config: MicrosoftRbacConfig = loadMicrosoftRbacConfig();
  const getGroups = options.getGroups ?? getEntraUserGroupIds;
  const rows = await db
    .select({ userId: authAccounts.userId, upn: authAccounts.accountId })
    .from(authAccounts)
    .where(eq(authAccounts.providerId, "microsoft"));
  let graphFailed = 0;
  let addedMemberships = 0;
  let pendingAdminElevations = 0;
  for (const row of rows) {
    if (!row.upn) continue;
    const groups = await getGroups(row.upn);
    if (groups === null) {
      graphFailed += 1;
      continue;
    }
    const result = await reconcileMicrosoftUser(db, row.userId, groups, config);
    if (result.addedMembership) addedMemberships += 1;
    if (result.pendingAdminElevation) pendingAdminElevations += 1;
  }
  return {
    scanned: rows.length,
    graphFailed,
    addedMemberships,
    pendingAdminElevations,
  };
}

export function startMicrosoftGroupReconciler(
  options: StartOptions,
): MicrosoftGroupReconcilerHandle {
  const intervalHours =
    options.intervalHours ?? (Number(process.env.MICROSOFT_GROUP_RECONCILE_INTERVAL_HOURS) || 24);
  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
  const now = options._now ?? Date.now;
  // Stagger the first run by a small random offset so HA replicas (when
  // node role is `all` on more than one pod) don't all hit Graph at the
  // same wall-clock minute. 1m..interval/4 spread.
  const firstDelayMs = Math.floor((Math.random() * intervalMs) / 4) + 60_000;
  let stopped = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    const startedAt = now();
    try {
      const summary = await reconcileAllMicrosoftUsers(options.db, {
        getGroups: options._getGroups,
      });
      console.log(
        `[microsoft-group-reconciler] tick scanned=${summary.scanned} graphFailed=${summary.graphFailed} addedMemberships=${summary.addedMemberships} pendingAdminElevations=${summary.pendingAdminElevations} durationMs=${now() - startedAt}`,
      );
    } catch (err) {
      console.error("[microsoft-group-reconciler] tick failed:", err);
    } finally {
      if (!stopped) pendingTimer = setTimeout(tick, intervalMs);
    }
  };

  pendingTimer = setTimeout(tick, firstDelayMs);

  return {
    stop() {
      stopped = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
    },
  };
}
