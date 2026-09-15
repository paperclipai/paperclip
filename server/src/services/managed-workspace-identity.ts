/**
 * Control-plane half of the workspace readiness/handoff contract (PAP-17572).
 *
 * Resolves the identity and derived key material for one managed workspace,
 * injects them into the guest process, and probes the guest's *protected*
 * readiness so `running / healthy` can never be published for a workspace whose
 * clone, identity, or login handoff disagrees with what was expected.
 *
 * Identity always comes from the worktree's own recorded instance pointer, never
 * from a branch name or basename heuristic, and an unresolvable identity fails
 * closed (no key injected, no readiness claimed).
 */

import path from "node:path";
import { and, eq } from "drizzle-orm";
import { authUsers, companyMemberships, type Db } from "@paperclipai/db";
import type { WorkspaceReadiness, WorkspaceReadinessProbeResult } from "@paperclipai/shared";
import {
  deriveWorkspaceHandoffKey,
  deriveWorkspaceReadinessToken,
  resolveWorkspaceHandoffRootSecret,
  WORKSPACE_EXECUTION_WORKSPACE_COMPANY_ID_ENV_KEY,
  WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY,
  WORKSPACE_HANDOFF_KEY_ENV_KEY,
  WORKSPACE_READINESS_TOKEN_ENV_KEY,
  WORKSPACE_READINESS_TOKEN_HEADER,
  WORKSPACE_READINESS_USER_EMAIL_HEADER,
  WORKSPACE_READINESS_USER_ID_HEADER,
} from "../auth/workspace-login-handoff.js";
import { logger } from "../middleware/logger.js";
import {
  deriveWorktreeInstanceId,
  readWorktreeInstanceId,
} from "./workspace-instance-cleanup.js";

/**
 * Per-probe budget. Matched to the semantic transport probe it replaces, so
 * upgrading a runtime health check to the readiness contract cannot make a
 * managed start or a reuse decision slower than it was.
 */
export const WORKSPACE_READINESS_PROBE_TIMEOUT_MS = 2_000;

export type ManagedWorkspaceIdentity = {
  instanceId: string;
  executionWorkspaceId: string;
  companyId: string;
  handoffKey: string;
  readinessToken: string;
  /** Whether the root secret was configured explicitly or derived. */
  secretSource: "dedicated" | "derived";
};

/**
 * Resolve the isolated instance id a worktree actually runs as.
 *
 * The worktree's `.paperclip/.env` pointer is authoritative because it is what
 * the guest process itself loads. The path-derived id is only a fallback for a
 * worktree provisioned before the pointer existed, and the two agree by
 * construction for anything Paperclip provisioned.
 */
export function resolveManagedWorkspaceInstanceId(workspaceCwd: string): string | null {
  const recorded = readWorktreeInstanceId(workspaceCwd);
  if (recorded) return recorded;
  const derived = deriveWorktreeInstanceId(workspaceCwd);
  return derived || null;
}

export function resolveManagedWorkspaceIdentity(input: {
  workspaceCwd: string | null | undefined;
  executionWorkspaceId: string | null | undefined;
  companyId: string | null | undefined;
  env?: NodeJS.ProcessEnv;
}): ManagedWorkspaceIdentity | null {
  const workspaceCwd = input.workspaceCwd?.trim();
  const executionWorkspaceId = input.executionWorkspaceId?.trim();
  const companyId = input.companyId?.trim();
  if (!workspaceCwd || !executionWorkspaceId || !companyId) return null;

  const root = resolveWorkspaceHandoffRootSecret(input.env ?? process.env);
  if (!root) return null;

  const instanceId = resolveManagedWorkspaceInstanceId(path.resolve(workspaceCwd));
  if (!instanceId) return null;

  return {
    instanceId,
    executionWorkspaceId,
    companyId,
    handoffKey: deriveWorkspaceHandoffKey({ rootSecret: root.secret, instanceId, executionWorkspaceId }),
    readinessToken: deriveWorkspaceReadinessToken({ rootSecret: root.secret, instanceId, executionWorkspaceId }),
    secretSource: root.source,
  };
}

/**
 * Env injected into a managed workspace's guest process.
 *
 * Only the *derived* per-workspace values cross the boundary: the guest never
 * receives the root secret, so a compromised workspace cannot mint a ticket for
 * a sibling workspace.
 */
export function buildManagedWorkspaceGuestEnv(identity: ManagedWorkspaceIdentity): Record<string, string> {
  return {
    [WORKSPACE_HANDOFF_KEY_ENV_KEY]: identity.handoffKey,
    [WORKSPACE_READINESS_TOKEN_ENV_KEY]: identity.readinessToken,
    [WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY]: identity.executionWorkspaceId,
    [WORKSPACE_EXECUTION_WORKSPACE_COMPANY_ID_ENV_KEY]: identity.companyId,
  };
}

function isWorkspaceReadinessShape(value: unknown): value is WorkspaceReadiness {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.state === "string"
    && typeof candidate.databaseReady === "boolean"
    && typeof candidate.cloneDataReady === "boolean"
    && typeof candidate.authHandoffReady === "boolean"
    && (typeof candidate.authHandoffUserId === "string" || candidate.authHandoffUserId === null)
    && typeof candidate.seedState === "string"
    && (typeof candidate.companyId === "string" || candidate.companyId === null)
  );
}

/**
 * Read a managed workspace's protected readiness over loopback.
 *
 * Failure modes are distinguished so callers can tell "not reachable" from
 * "reachable but serving somebody else's clone" — the second is what made a
 * relocated port able to masquerade as healthy.
 */
export async function probeManagedWorkspaceReadiness(input: {
  healthUrl: string;
  identity: ManagedWorkspaceIdentity;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  handoffSubject?: { userId: string; email: string } | null;
}): Promise<WorkspaceReadinessProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(input.healthUrl, {
      headers: {
        [WORKSPACE_READINESS_TOKEN_HEADER]: input.identity.readinessToken,
        ...(input.handoffSubject
          ? {
              [WORKSPACE_READINESS_USER_ID_HEADER]: input.handoffSubject.userId,
              [WORKSPACE_READINESS_USER_EMAIL_HEADER]: input.handoffSubject.email,
            }
          : {}),
      },
      signal: AbortSignal.timeout(input.timeoutMs ?? WORKSPACE_READINESS_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: "unreachable",
      readiness: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const payload = await response.json().catch(() => null) as
    | { status?: unknown; workspace?: unknown }
    | null;

  if (!response.ok) {
    const readiness = isWorkspaceReadinessShape(payload?.workspace) ? payload.workspace : null;
    return { ok: false, reason: "http_error", readiness, detail: `HTTP ${response.status}` };
  }
  if (payload?.status !== "ok") {
    return { ok: false, reason: "unhealthy_payload", readiness: null, detail: String(payload?.status ?? "missing") };
  }
  if (
    payload.workspace
    && typeof payload.workspace === "object"
    && !("companyId" in payload.workspace)
  ) {
    // A guest that implements readiness but predates the company binding is not
    // a legacy transport-only guest. Treat the partial contract as an identity
    // disagreement so auto compatibility mode cannot publish an unopenable clone.
    return {
      ok: false,
      reason: "identity_mismatch",
      readiness: null,
      detail: `expected company ${input.identity.companyId}, got missing`,
    };
  }
  if (
    input.handoffSubject
    && payload.workspace
    && typeof payload.workspace === "object"
    && !("authHandoffUserId" in payload.workspace)
  ) {
    return {
      ok: false,
      reason: "identity_mismatch",
      readiness: null,
      detail: `expected handoff user ${input.handoffSubject.userId}, got missing`,
    };
  }
  if (!isWorkspaceReadinessShape(payload.workspace)) {
    // Either the token was rejected or the guest predates this contract. Both
    // mean the control plane cannot prove user readiness, so neither may publish.
    return { ok: false, reason: "readiness_missing", readiness: null, detail: null };
  }

  const readiness = payload.workspace;
  if (
    readiness.instanceId !== input.identity.instanceId
    || readiness.executionWorkspaceId !== input.identity.executionWorkspaceId
    || readiness.companyId !== input.identity.companyId
  ) {
    return {
      ok: false,
      reason: "identity_mismatch",
      readiness,
      detail: `expected ${input.identity.instanceId}/${input.identity.executionWorkspaceId}/${input.identity.companyId}, got ${readiness.instanceId}/${readiness.executionWorkspaceId}/${readiness.companyId}`,
    };
  }
  if (!readiness.databaseReady || !readiness.cloneDataReady || !readiness.authHandoffReady) {
    return { ok: false, reason: "not_ready", readiness, detail: readiness.failurePhase };
  }
  if (input.handoffSubject && readiness.authHandoffUserId !== input.handoffSubject.userId) {
    return {
      ok: false,
      reason: "identity_mismatch",
      readiness,
      detail: `expected handoff user ${input.handoffSubject.userId}, got ${readiness.authHandoffUserId}`,
    };
  }

  return { ok: true, readiness };
}

/** Current board identities that must survive the clone for it to publish ready. */
export async function listManagedWorkspaceHandoffSubjects(
  db: Db,
  companyId: string,
): Promise<Array<{ userId: string; email: string }>> {
  const rows = await db
    .select({ userId: authUsers.id, email: authUsers.email })
    .from(authUsers)
    .innerJoin(
      companyMemberships,
      and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, authUsers.id),
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.status, "active"),
      ),
    );
  return rows.flatMap((row) => {
    const userId = row.userId?.trim();
    const email = row.email?.trim();
    return userId && email ? [{ userId, email }] : [];
  });
}

/** Prove that every current board member can use the advertised handoff. */
export async function probeManagedWorkspaceHandoffSubjects(input: {
  db: Db;
  healthUrl: string;
  identity: ManagedWorkspaceIdentity;
  fetchImpl?: typeof fetch;
}): Promise<WorkspaceReadinessProbeResult> {
  const subjects = await listManagedWorkspaceHandoffSubjects(input.db, input.identity.companyId);
  if (subjects.length === 0) {
    return {
      ok: false,
      reason: "not_ready",
      readiness: null,
      detail: "no active board user is eligible for workspace login handoff",
    };
  }
  const results = await Promise.all(subjects.map((handoffSubject) => probeManagedWorkspaceReadiness({
    healthUrl: input.healthUrl,
    identity: input.identity,
    fetchImpl: input.fetchImpl,
    handoffSubject,
  })));
  return results.find((result) => !result.ok) ?? results[0]!;
}

/**
 * How strictly a managed start is gated on the guest's protected readiness.
 *
 *  - `auto` (default): a guest that *reports* readiness must satisfy it, and a
 *    guest serving a different instance/workspace is always rejected. A guest
 *    that reports no readiness block at all — an older checkout, which a managed
 *    worktree can legitimately be — falls back to the semantic transport check
 *    and is logged. Failing that case closed would turn an upgrade lag into an
 *    outage of every existing workspace, which is a worse reliability outcome
 *    than the defect this gate exists to fix. Such a workspace is still not
 *    silently "usable": it has no handoff plugin, so `Open workspace` reports the
 *    snapshot-local credential fallback rather than pretending to be ready.
 *  - `strict`: a missing readiness block also blocks publication. Intended for
 *    deployments that have finished rolling the new guest build everywhere.
 */
export type WorkspaceReadinessGateMode = "auto" | "strict";

export function resolveWorkspaceReadinessGateMode(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceReadinessGateMode {
  return env.PAPERCLIP_WORKSPACE_READINESS_GATE?.trim().toLowerCase() === "strict" ? "strict" : "auto";
}

/**
 * Whether a rejected probe must stop the runtime from being published.
 *
 * Everything except "this guest does not implement the contract" is a real
 * disagreement about the clone and always blocks.
 */
export function shouldBlockPublicationOnReadiness(
  result: Extract<WorkspaceReadinessProbeResult, { ok: false }>,
  mode: WorkspaceReadinessGateMode = resolveWorkspaceReadinessGateMode(),
): boolean {
  if (result.reason === "readiness_missing") return mode === "strict";
  return true;
}

/**
 * How long a freshly started workspace may take to satisfy readiness.
 *
 * Deliberately short. The transport readiness probe has already required a
 * `status: ok` response from this guest by the time the gate runs, so the only
 * thing left to absorb is a one-off blip — not a cold start. A longer budget
 * would add latency to every managed start to no benefit.
 */
export const WORKSPACE_READINESS_GATE_TIMEOUT_MS = 3_000;
const WORKSPACE_READINESS_GATE_INTERVAL_MS = 250;

/**
 * Poll readiness until it passes or the gate budget runs out.
 *
 * `identity_mismatch` and `readiness_missing` are terminal and return
 * immediately: another instance owning the port, or a guest that does not
 * implement the contract, are not conditions that polling can change.
 */
export async function waitForManagedWorkspaceReadiness(input: {
  healthUrl: string;
  identity: ManagedWorkspaceIdentity;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<WorkspaceReadinessProbeResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const deadline = now() + (input.timeoutMs ?? WORKSPACE_READINESS_GATE_TIMEOUT_MS);
  let last: WorkspaceReadinessProbeResult = {
    ok: false,
    reason: "unreachable",
    readiness: null,
    detail: "readiness gate did not run",
  };
  for (;;) {
    last = await probeManagedWorkspaceReadiness({
      healthUrl: input.healthUrl,
      identity: input.identity,
      fetchImpl: input.fetchImpl,
    });
    if (last.ok || last.reason === "identity_mismatch" || last.reason === "readiness_missing") return last;
    if (now() >= deadline) return last;
    await sleep(WORKSPACE_READINESS_GATE_INTERVAL_MS);
  }
}

/** Log a rejected probe once, with the machine reason kept intact for operators. */
export function logManagedWorkspaceReadinessRejection(input: {
  executionWorkspaceId: string;
  healthUrl: string;
  result: Extract<WorkspaceReadinessProbeResult, { ok: false }>;
}) {
  logger.warn(
    {
      executionWorkspaceId: input.executionWorkspaceId,
      healthUrl: input.healthUrl,
      reason: input.result.reason,
      detail: input.result.detail,
      seedState: input.result.readiness?.seedState ?? null,
      failurePhase: input.result.readiness?.failurePhase ?? null,
    },
    "managed workspace readiness probe rejected the runtime",
  );
}
