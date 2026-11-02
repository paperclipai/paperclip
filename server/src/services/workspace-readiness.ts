/**
 * Protected workspace readiness (PAP-17572).
 *
 * `/api/health` answering 200 only proves a listener exists. This module answers
 * the question the control plane and the UI actually need — "can a board user
 * open this clone and see their data?" — from four independent signals: the
 * isolated database, the versioned seed manifest, representative cloned rows,
 * and the login-handoff configuration.
 *
 * Everything here is read-only and deliberately small: structural validation of
 * a clone happens once, during provisioning or repair, not on every probe.
 *
 * `repairing` is intentionally not derivable here. A guest process cannot know
 * that the control plane is running a managed repair against it; the UI layers
 * that state on from the live workspace-operation row.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships, issues } from "@paperclipai/db";
import type {
  WorkspaceReadiness,
  WorkspaceReadinessState,
  WorkspaceSeedReadinessState,
} from "@paperclipai/shared";
import {
  resolveWorkspaceHandoffLocalCompanyId,
  resolveWorkspaceHandoffLocalKey,
  resolveWorkspaceHandoffLocalWorkspaceId,
} from "../auth/workspace-login-handoff.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

const WORKSPACE_SEED_MANIFEST_BASENAME = "seed-manifest.json";
const LEGACY_SEED_PENDING_BASENAME = "seed-pending";
const LEGACY_SEED_COMPLETE_BASENAME = "seed-complete";

type SeedManifestSummary = {
  state: WorkspaceSeedReadinessState;
  phase: string | null;
  mode: "minimal" | "full" | null;
  failurePhase: string | null;
};

/**
 * Directory holding this instance's seed markers.
 *
 * `PAPERCLIP_CONFIG` is the authoritative pointer a seeded worktree is started
 * with; the cwd fallback covers a guest launched without it.
 */
export function resolveWorkspaceSeedMarkerDir(env: NodeJS.ProcessEnv = process.env): string {
  const configPath = env.PAPERCLIP_CONFIG?.trim();
  if (configPath) return path.dirname(path.resolve(configPath));
  return path.resolve(process.cwd(), ".paperclip");
}

function readSeedManifestSummary(markerDir: string): SeedManifestSummary {
  const manifestPath = path.join(markerDir, WORKSPACE_SEED_MANIFEST_BASENAME);
  if (existsSync(manifestPath)) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    } catch {
      // A manifest we cannot parse is evidence of an interrupted write, which is
      // a failure — never a silent "assume seeded".
      return { state: "failed", phase: null, mode: null, failurePhase: "seed_manifest_unreadable" };
    }
    const rawState = typeof manifest.state === "string" ? manifest.state : null;
    const state: WorkspaceSeedReadinessState =
      rawState === "pending" || rawState === "running" || rawState === "verified" || rawState === "failed"
        ? rawState
        : "unknown";
    const phase = typeof manifest.phase === "string" ? manifest.phase : null;
    const mode = manifest.seedMode === "minimal" || manifest.seedMode === "full" ? manifest.seedMode : null;
    return {
      state,
      phase,
      mode,
      failurePhase: state === "failed" ? phase ?? "unknown" : null,
    };
  }

  // Legacy markers predate the versioned manifest. `seed-complete`, or the
  // absence of both markers on an already-running instance, means an adopted
  // legacy clone whose completeness this probe cannot prove.
  if (existsSync(path.join(markerDir, LEGACY_SEED_PENDING_BASENAME))) {
    return { state: "pending", phase: "pending", mode: null, failurePhase: null };
  }
  if (existsSync(path.join(markerDir, LEGACY_SEED_COMPLETE_BASENAME))) {
    return { state: "unknown", phase: "legacy_complete_marker", mode: null, failurePhase: null };
  }
  return { state: "absent", phase: null, mode: null, failurePhase: null };
}

/**
 * Collapse the individual signals into one state.
 *
 * `degraded` is reserved for "the clone exists and was verified, but a signal
 * regressed", which is the case an operator can fix with one bounded repair.
 * A clone that never finished reports `provisioning`/`validating`/`failed`
 * instead, so the UI never offers a repair for work that is still in progress.
 */
export function resolveWorkspaceReadinessState(input: {
  databaseReady: boolean;
  cloneDataReady: boolean;
  authHandoffReady: boolean;
  seedState: WorkspaceSeedReadinessState;
}): WorkspaceReadinessState {
  if (input.seedState === "failed") return "failed";
  if (input.seedState === "pending") return "provisioning";
  if (input.seedState === "running") return "provisioning";
  if (!input.databaseReady) return input.seedState === "verified" ? "degraded" : "provisioning";
  if (!input.cloneDataReady || !input.authHandoffReady) {
    return input.seedState === "verified" ? "degraded" : "validating";
  }
  // Cloned data and handoff both check out. A legacy or absent manifest is not
  // proof of a verified seed, so surface it as validating rather than ready.
  if (input.seedState !== "verified") return "validating";
  return "ready";
}

/**
 * Whether this process is a cloned workspace instance at all.
 *
 * The primary control plane has no seed manifest and no injected workspace
 * identity, and reporting a hollow readiness block for it would invite consumers
 * to treat "no clone" as "broken clone". Detection is by evidence on disk or
 * injected identity, never by a branch-name or path heuristic.
 */
let managedWorkspaceInstanceCache: { markerDir: string; value: boolean; checkedAtMs: number } | null = null;

/**
 * How long the marker-file answer is reused. `/api/health` is polled by the dev
 * runner, the control plane's readiness probe and the UI, so three `existsSync`
 * calls per request would be pure overhead on an instance whose answer is
 * effectively static. Short enough that a manifest appearing mid-provision is
 * picked up promptly.
 */
const MANAGED_WORKSPACE_DETECTION_TTL_MS = 5_000;

export function isManagedWorkspaceInstance(
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): boolean {
  // Injected identity is authoritative and free to read, so it short-circuits
  // ahead of any filesystem work.
  if (resolveWorkspaceHandoffLocalKey(env)) return true;
  if (resolveWorkspaceHandoffLocalWorkspaceId(env)) return true;

  const markerDir = resolveWorkspaceSeedMarkerDir(env);
  const cached = managedWorkspaceInstanceCache;
  if (
    cached
    && cached.markerDir === markerDir
    && now() - cached.checkedAtMs < MANAGED_WORKSPACE_DETECTION_TTL_MS
  ) {
    return cached.value;
  }
  const value = existsSync(path.join(markerDir, WORKSPACE_SEED_MANIFEST_BASENAME))
    || existsSync(path.join(markerDir, LEGACY_SEED_PENDING_BASENAME))
    || existsSync(path.join(markerDir, LEGACY_SEED_COMPLETE_BASENAME));
  managedWorkspaceInstanceCache = { markerDir, value, checkedAtMs: now() };
  return value;
}

/** Test-only seam so a suite can change marker files without waiting out the TTL. */
export function resetManagedWorkspaceInstanceCacheForTests(): void {
  managedWorkspaceInstanceCache = null;
}

export type WorkspaceReadinessDeps = {
  db: Db | null | undefined;
  env?: NodeJS.ProcessEnv;
  handoffSubject?: { userId: string; email: string } | null;
};

/**
 * Assemble this instance's readiness. Never throws: a probe that cannot read the
 * database must report `databaseReady: false`, not fail the health endpoint.
 */
export async function resolveWorkspaceReadiness(deps: WorkspaceReadinessDeps): Promise<WorkspaceReadiness> {
  const env = deps.env ?? process.env;
  const seed = readSeedManifestSummary(resolveWorkspaceSeedMarkerDir(env));
  const instanceId = resolvePaperclipInstanceId();
  const executionWorkspaceId = resolveWorkspaceHandoffLocalWorkspaceId(env);
  // The company this workspace's board represents. Both product probes below are
  // scoped to it: "some company in the clone has issues" and "some user has some
  // membership" can both be true while the company the operator is opening is
  // missing or has no members, which is a workspace that must not report ready.
  const companyId = resolveWorkspaceHandoffLocalCompanyId(env);
  const handoffKeyPresent = Boolean(resolveWorkspaceHandoffLocalKey(env));
  const handoffUserId = deps.handoffSubject?.userId.trim() || null;
  const handoffUserEmail = deps.handoffSubject?.email.trim().toLowerCase() || null;

  let databaseReady = false;
  let cloneDataReady = false;
  let clonedAdminPresent = false;
  let probeFailurePhase: string | null = null;

  if (deps.db) {
    try {
      await deps.db.execute(sql`SELECT 1`);
      databaseReady = true;
    } catch (error) {
      logger.warn({ err: error }, "workspace readiness database probe failed");
      probeFailurePhase = "database_unreachable";
    }

    if (databaseReady && companyId) {
      try {
        // One representative cloned company/issue pair proves the restore carried
        // product rows, not just an empty migrated schema.
        const clonedRows = await deps.db
          .select({ companyId: companies.id })
          .from(companies)
          .innerJoin(issues, eq(issues.companyId, companies.id))
          .where(eq(companies.id, companyId))
          .limit(1)
          .then((rows) => rows.length);
        cloneDataReady = clonedRows > 0;
        if (!cloneDataReady) probeFailurePhase ??= "clone_data_missing";
      } catch (error) {
        logger.warn({ err: error }, "workspace readiness clone-data probe failed");
        probeFailurePhase ??= "clone_data_unreadable";
      }

      try {
        // The handoff can only sign in a user who survived the clone with an
        // active membership *in this workspace's company*, so readiness asserts
        // that identity exists here rather than discovering it at click time.
        // Existence, not a count: this runs on every protected health request and
        // counting the whole join would scale with instance size for an answer
        // that needs one row.
        const eligibleUsers = await deps.db
          .select({ userId: authUsers.id })
          .from(authUsers)
          .innerJoin(
            companyMemberships,
            and(
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, authUsers.id),
              eq(companyMemberships.status, "active"),
              eq(companyMemberships.companyId, companyId),
              ...(handoffUserId ? [eq(authUsers.id, handoffUserId)] : []),
              ...(handoffUserEmail ? [sql`lower(${authUsers.email}) = ${handoffUserEmail}`] : []),
            ),
          )
          .limit(1)
          .then((rows) => rows.length);
        clonedAdminPresent = eligibleUsers > 0;
        if (!clonedAdminPresent) probeFailurePhase ??= "cloned_membership_missing";
      } catch (error) {
        logger.warn({ err: error }, "workspace readiness identity probe failed");
        probeFailurePhase ??= "cloned_identity_unreadable";
      }
    }
  } else {
    probeFailurePhase = "database_not_configured";
  }

  const authHandoffReady = Boolean(
    handoffKeyPresent
    && executionWorkspaceId
    && companyId
    && clonedAdminPresent,
  );
  if (!companyId) probeFailurePhase ??= "workspace_company_not_configured";
  if (!executionWorkspaceId) probeFailurePhase ??= "workspace_identity_not_configured";
  if (!handoffKeyPresent) probeFailurePhase ??= "auth_handoff_not_configured";

  const state = resolveWorkspaceReadinessState({
    databaseReady,
    cloneDataReady,
    authHandoffReady,
    seedState: seed.state,
  });

  return {
    state,
    databaseReady,
    cloneDataReady,
    authHandoffReady,
    authHandoffUserId: handoffUserId,
    seedState: seed.state,
    seedPhase: seed.phase,
    seedMode: seed.mode,
    instanceId,
    executionWorkspaceId,
    companyId,
    // A seed-recorded failure phase is more specific than anything this probe
    // can infer, so it wins.
    failurePhase: seed.failurePhase ?? (state === "ready" ? null : probeFailurePhase),
  };
}
