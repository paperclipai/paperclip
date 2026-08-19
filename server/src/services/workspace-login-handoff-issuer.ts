/**
 * Issues signed workspace login handoff tickets (PAP-17572).
 *
 * Runs on the authenticated main control plane. Everything a ticket is bound to
 * is resolved here from server-side state — the caller's authenticated identity,
 * the live runtime row's published URL, and the worktree's recorded instance
 * pointer — so a client cannot influence the audience, workspace, or instance a
 * ticket is valid for.
 *
 * A ticket is only minted for a workspace that currently passes the protected
 * readiness probe. Handing out a ticket for a half-restored clone would turn a
 * diagnosable "clone is incomplete" state back into the opaque
 * "invalid email or password" that started this incident.
 */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, instanceUserRoles, workspaceRuntimeServices } from "@paperclipai/db";
import type { WorkspaceReadiness } from "@paperclipai/shared";
import {
  buildWorkspaceHandoffExchangeUrl,
  issueWorkspaceHandoffTicket,
  normalizeWorkspaceHandoffOrigin,
  sanitizeWorkspaceHandoffRedirectPath,
  WORKSPACE_HANDOFF_TICKET_TTL_SECONDS,
} from "../auth/workspace-login-handoff.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import {
  probeManagedWorkspaceReadiness,
  resolveManagedWorkspaceIdentity,
} from "./managed-workspace-identity.js";

export type WorkspaceLoginHandoffActor = {
  userId: string | null | undefined;
  userEmail: string | null | undefined;
  source: string | null | undefined;
};

export type WorkspaceLoginHandoffFailure =
  | { reason: "no_board_identity" }
  | { reason: "handoff_not_configured" }
  | { reason: "runtime_not_running" }
  | { reason: "runtime_url_unusable"; detail: string }
  | { reason: "workspace_not_ready"; detail: string | null; readiness: WorkspaceReadiness | null };

export type WorkspaceLoginHandoffIssuance = {
  url: string;
  expiresAt: string;
  /** The live runtime origin the ticket was bound to. */
  origin: string;
  nonce: string;
  userId: string;
  instanceId: string;
};

export type WorkspaceLoginHandoffResult =
  | { ok: true; issuance: WorkspaceLoginHandoffIssuance }
  | { ok: false; failure: WorkspaceLoginHandoffFailure };

/**
 * Resolve the board user a ticket will be minted for.
 *
 * In `authenticated` mode this is the caller's own session identity. The
 * `local_implicit` actor of a `local_trusted` instance has no auth row, so the
 * instance's oldest instance admin stands in: that mode already grants
 * unrestricted board access to this instance and its clones, so this widens
 * nothing, and it keeps local development password-independent too.
 */
export async function resolveWorkspaceHandoffBoardIdentity(
  db: Db,
  actor: WorkspaceLoginHandoffActor,
): Promise<{ userId: string; email: string } | null> {
  const userId = actor.userId?.trim();
  const email = actor.userEmail?.trim();
  if (userId && email && actor.source !== "local_implicit") {
    return { userId, email };
  }
  if (actor.source !== "local_implicit") return null;

  const admin = await db
    .select({ id: authUsers.id, email: authUsers.email, createdAt: authUsers.createdAt })
    .from(authUsers)
    .innerJoin(
      instanceUserRoles,
      and(eq(instanceUserRoles.userId, authUsers.id), eq(instanceUserRoles.role, "instance_admin")),
    )
    .orderBy(authUsers.createdAt, authUsers.id)
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!admin?.email) return null;
  return { userId: admin.id, email: admin.email };
}

/**
 * The live runtime row a workspace is currently served from.
 *
 * Reading the row (rather than a stored work-product URL) is what keeps the
 * handoff target correct after a port change: the row is the same source the
 * runtime publication path writes.
 */
export async function resolveLiveWorkspaceRuntimeOrigin(
  db: Db,
  input: { companyId: string; executionWorkspaceId: string },
): Promise<{ url: string; runtimeServiceId: string } | null> {
  const row = await db
    .select({
      id: workspaceRuntimeServices.id,
      url: workspaceRuntimeServices.url,
      updatedAt: workspaceRuntimeServices.updatedAt,
    })
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, input.companyId),
        eq(workspaceRuntimeServices.executionWorkspaceId, input.executionWorkspaceId),
        eq(workspaceRuntimeServices.status, "running"),
        eq(workspaceRuntimeServices.healthStatus, "healthy"),
      ),
    )
    .orderBy(desc(workspaceRuntimeServices.updatedAt))
    .then((rows) => rows.find((candidate) => Boolean(candidate.url)) ?? null);
  if (!row?.url) return null;
  return { url: row.url, runtimeServiceId: row.id };
}

export async function issueWorkspaceLoginHandoff(input: {
  db: Db;
  companyId: string;
  executionWorkspace: { id: string; cwd: string | null };
  actor: WorkspaceLoginHandoffActor;
  next?: string | null;
  ttlSeconds?: number;
  now?: Date;
  probe?: typeof probeManagedWorkspaceReadiness;
}): Promise<WorkspaceLoginHandoffResult> {
  const identity = resolveManagedWorkspaceIdentity({
    workspaceCwd: input.executionWorkspace.cwd,
    executionWorkspaceId: input.executionWorkspace.id,
    companyId: input.companyId,
  });
  if (!identity) return { ok: false, failure: { reason: "handoff_not_configured" } };

  const boardIdentity = await resolveWorkspaceHandoffBoardIdentity(input.db, input.actor);
  if (!boardIdentity) return { ok: false, failure: { reason: "no_board_identity" } };

  const live = await resolveLiveWorkspaceRuntimeOrigin(input.db, {
    companyId: input.companyId,
    executionWorkspaceId: input.executionWorkspace.id,
  });
  if (!live) return { ok: false, failure: { reason: "runtime_not_running" } };

  const origin = normalizeWorkspaceHandoffOrigin(live.url);
  if (!origin) {
    return { ok: false, failure: { reason: "runtime_url_unusable", detail: live.url } };
  }

  const probe = input.probe ?? probeManagedWorkspaceReadiness;
  const readinessResult = await probe({
    // Probe the origin the user will actually be sent to, so a stale row or a
    // reassigned port is caught before a ticket exists rather than after.
    healthUrl: new URL("/api/health", origin).toString(),
    identity,
    handoffSubject: boardIdentity,
  });
  if (!readinessResult.ok) {
    return {
      ok: false,
      failure: {
        reason: "workspace_not_ready",
        detail: readinessResult.detail ?? readinessResult.reason,
        readiness: readinessResult.readiness,
      },
    };
  }

  const { ticket, payload } = issueWorkspaceHandoffTicket({
    key: identity.handoffKey,
    userId: boardIdentity.userId,
    email: boardIdentity.email,
    executionWorkspaceId: identity.executionWorkspaceId,
    companyId: identity.companyId,
    instanceId: identity.instanceId,
    origin,
    issuerInstanceId: resolvePaperclipInstanceId(),
    next: sanitizeWorkspaceHandoffRedirectPath(input.next),
    ttlSeconds: input.ttlSeconds ?? WORKSPACE_HANDOFF_TICKET_TTL_SECONDS,
    now: input.now,
  });

  return {
    ok: true,
    issuance: {
      url: buildWorkspaceHandoffExchangeUrl({ origin, ticket }),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      origin,
      nonce: payload.jti,
      userId: boardIdentity.userId,
      instanceId: identity.instanceId,
    },
  };
}

/** HTTP status for a failed issuance. */
export function workspaceLoginHandoffFailureStatus(failure: WorkspaceLoginHandoffFailure): number {
  switch (failure.reason) {
    case "no_board_identity":
      return 403;
    case "handoff_not_configured":
      return 501;
    case "runtime_not_running":
    case "runtime_url_unusable":
    case "workspace_not_ready":
      return 409;
  }
}
