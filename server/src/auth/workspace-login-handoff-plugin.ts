/**
 * Better Auth plugin that exchanges a signed workspace login handoff ticket for
 * an instance-scoped session (PAP-17572).
 *
 * Implemented as a plugin endpoint rather than a hand-rolled Express route so
 * session creation and cookie signing go through Better Auth's own supported
 * path (`internalAdapter.createSession` + `setSessionCookie`) instead of this
 * repository reimplementing cookie signing.
 *
 * The endpoint is only registered when the process was handed a per-workspace
 * verification key, so a normal control-plane instance exposes no extra surface.
 */

import { and, eq } from "drizzle-orm";
import { setSessionCookie } from "better-auth/cookies";
import { createAuthEndpoint } from "better-auth/api";
import type { Session, User } from "better-auth/types";
import type { Db } from "@paperclipai/db";
import { companyMemberships } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  exchangeWorkspaceHandoffTicket,
  isWorkspaceHandoffRepairReason,
  type WorkspaceHandoffExchangeFailureReason,
} from "./workspace-login-handoff-exchange.js";
import {
  WORKSPACE_HANDOFF_EXCHANGE_PATH,
  WORKSPACE_HANDOFF_TICKET_QUERY_PARAM,
  workspaceHandoffKeyFingerprint,
} from "./workspace-login-handoff.js";

/**
 * Identity the guest expects, resolved from persisted configuration.
 *
 * Deliberately a callback: it is re-read per exchange so a hot-restarted guest
 * cannot keep validating against a stale origin, and it keeps request headers
 * out of the comparison entirely.
 */
export type WorkspaceHandoffExpectedIdentity = {
  key: string | null;
  instanceId: string | null;
  executionWorkspaceId: string | null;
  companyId: string | null;
  origin: string | null;
};

/**
 * The slice of Better Auth's endpoint context this exchange uses.
 *
 * Declared structurally rather than importing the library's deeply generic
 * `GenericEndpointContext`, whose inference depends on the plugin's own option
 * types. Narrowing here keeps the handler body fully type-checked; the single
 * cast at the top of the handler is the only unchecked step.
 */
type WorkspaceHandoffEndpointContext = {
  query?: Record<string, unknown>;
  setHeader: (name: string, value: string) => void;
  redirect: (url: string) => unknown;
  error: (status: string, body?: Record<string, unknown>) => unknown;
  context: {
    internalAdapter: {
      findUserById: (userId: string) => Promise<User | null>;
      createSession: (userId: string) => Promise<Session | null>;
      findVerificationValue: (identifier: string) => Promise<{ identifier: string } | null>;
      reserveVerificationValue: (data: {
        identifier: string;
        value: string;
        expiresAt: Date;
      }) => Promise<boolean>;
    };
  };
};

/** Where a rejected ticket lands the browser: the labeled snapshot-local fallback. */
function buildFallbackRedirect(input: {
  baseUrl: string | undefined;
  next: string;
  reason: WorkspaceHandoffExchangeFailureReason;
}): string {
  const target = new URL("/auth", input.baseUrl ?? "http://localhost");
  target.searchParams.set("next", input.next);
  target.searchParams.set("workspaceHandoffError", input.reason);
  return input.baseUrl ? target.toString() : `${target.pathname}${target.search}`;
}

export function workspaceLoginHandoffPlugin(deps: {
  db: Db;
  resolveExpectedIdentity: () => WorkspaceHandoffExpectedIdentity;
}) {
  return {
    id: "paperclip-workspace-login-handoff",
    endpoints: {
      exchangeWorkspaceLoginHandoff: createAuthEndpoint(
        WORKSPACE_HANDOFF_EXCHANGE_PATH,
        { method: "GET", requireHeaders: true },
        async (endpointContext) => {
          const ctx = endpointContext as unknown as WorkspaceHandoffEndpointContext;
          const expected = deps.resolveExpectedIdentity();
          const rawTicket = ctx.query?.[WORKSPACE_HANDOFF_TICKET_QUERY_PARAM];
          const ticket = typeof rawTicket === "string" ? rawTicket : null;

          // `no-store` keeps the ticket-bearing response out of shared caches and
          // `no-referrer` stops the ticket URL from leaking to the landing page.
          ctx.setHeader("Cache-Control", "no-store");
          ctx.setHeader("Referrer-Policy", "no-referrer");

          const result = await exchangeWorkspaceHandoffTicket({
            ticket,
            key: expected.key,
            expected: {
              instanceId: expected.instanceId,
              executionWorkspaceId: expected.executionWorkspaceId,
              companyId: expected.companyId,
              origin: expected.origin,
            },
            deps: {
              findClonedIdentity: async ({ userId, companyId }) => {
                const user = await ctx.context.internalAdapter.findUserById(userId);
                if (!user) return null;
                // Membership lives in Paperclip's own schema, so it is read
                // through the app's `db` handle rather than the Better Auth
                // adapter. Scoped to the ticket's company: an unscoped check
                // would accept a clone where this user belongs to some *other*
                // company and hand them a session with no access to the board
                // they opened. Existence, not a count.
                const activeMemberships = await deps.db
                  .select({ id: companyMemberships.id })
                  .from(companyMemberships)
                  .where(
                    and(
                      eq(companyMemberships.companyId, companyId),
                      eq(companyMemberships.principalType, "user"),
                      eq(companyMemberships.principalId, userId),
                      eq(companyMemberships.status, "active"),
                    ),
                  )
                  .limit(1)
                  .then((rows) => rows.length);
                return {
                  userId: user.id,
                  email: user.email ?? null,
                  name: user.name ?? null,
                  hasActiveMembership: activeMemberships > 0,
                };
              },
              reserveNonce: async ({ nonce, expiresAt }) => {
                const identifier = `workspace-login-handoff:${nonce}`;
                // Two layers, because each covers a case the other misses. The
                // lookup catches an ordinary sequential replay on any storage
                // backend; the reservation is a primary-key insert, so it is the
                // one that survives two exchanges racing inside the TTL. Relying
                // on the reservation alone would silently depend on the
                // configured adapter enforcing id uniqueness.
                if (await ctx.context.internalAdapter.findVerificationValue(identifier)) return false;
                return await ctx.context.internalAdapter.reserveVerificationValue({
                  identifier,
                  value: "consumed",
                  // Keep the record slightly past the ticket's own expiry so a
                  // replay attempted at the very edge of the window still loses.
                  expiresAt: new Date(expiresAt.getTime() + 60_000),
                });
              },
              createSession: async (userId) => {
                const user = await ctx.context.internalAdapter.findUserById(userId);
                if (!user) throw new Error("cloned user disappeared between verification and session creation");
                const session = await ctx.context.internalAdapter.createSession(userId);
                if (!session) throw new Error("Better Auth did not return a session");
                await setSessionCookie(ctx as never, { session, user });
              },
            },
          });

          if (!result.ok) {
            // Audit with the nonce and reason but never the ticket itself.
            logger.warn(
              {
                reason: result.reason,
                nonce: result.payload?.jti ?? null,
                executionWorkspaceId: expected.executionWorkspaceId,
                instanceId: expected.instanceId,
                keyFingerprint: expected.key ? workspaceHandoffKeyFingerprint(expected.key) : null,
                needsRepair: isWorkspaceHandoffRepairReason(result.reason),
              },
              "workspace login handoff rejected",
            );
            if (result.reason === "not_configured" || result.reason === "session_failed") {
              throw ctx.error(result.reason === "not_configured" ? "SERVICE_UNAVAILABLE" : "INTERNAL_SERVER_ERROR", {
                message: "Workspace login handoff is unavailable",
                code: result.reason,
              });
            }
            throw ctx.redirect(
              buildFallbackRedirect({
                baseUrl: expected.origin ?? undefined,
                next: result.payload?.next ?? "/",
                reason: result.reason,
              }),
            );
          }

          logger.info(
            {
              nonce: result.payload.jti,
              userId: result.payload.sub,
              executionWorkspaceId: expected.executionWorkspaceId,
              instanceId: expected.instanceId,
              issuerInstanceId: result.payload.iss,
            },
            "workspace login handoff accepted",
          );
          // An HTTP redirect (not a client-side navigation) is what keeps the
          // ticket URL out of the browser's session history.
          throw ctx.redirect(
            expected.origin
              ? new URL(result.redirectTo, expected.origin).toString()
              : result.redirectTo,
          );
        },
      ),
    },
  };
}
