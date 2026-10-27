import type { ActorInfo } from "../types.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueThreadInteractions, toolOauthStates } from "@paperclipai/db";
import { connectionIntentPayloadSchema } from "@paperclipai/shared";
import { badRequest, forbidden } from "../../../errors.js";

import { actorBinding } from "../actor.js";
function oauthActorType(value: string | null): ActorInfo["actorType"] | null {
  return value === "agent" ||
    value === "user" ||
    value === "system" ||
    value === "plugin"
    ? value
    : null;
}

function assertSameOAuthActor(
  stateRow: typeof toolOauthStates.$inferSelect,
  actor: ActorInfo | undefined,
) {
  const expected = {
    actorType: oauthActorType(stateRow.createdByActorType),
    actorId: stateRow.createdByActorId,
    sessionId: stateRow.createdBySessionId,
  };
  const actual = actorBinding(actor);
  if (!expected.actorType || !expected.actorId) {
    throw forbidden(
      "OAuth sign-in state is not bound to an authenticated board session",
    );
  }
  if (
    expected.actorType !== actual.actorType ||
    expected.actorId !== actual.actorId
  ) {
    throw forbidden(
      "OAuth sign-in must be completed by the user who started it",
    );
  }
  if (expected.sessionId && expected.sessionId !== actual.sessionId) {
    throw forbidden(
      "OAuth sign-in must be completed from the same authenticated session",
    );
  }
}

export function createOAuthStateStore(db: Db) {
  async function peekOAuthState(state: string) {
    const [row] = await db
      .select({
        companyId: toolOauthStates.companyId,
        connectionId: toolOauthStates.connectionId,
        subjectUserId: toolOauthStates.subjectUserId,
        subjectAgentId: toolOauthStates.subjectAgentId,
        returnTo: toolOauthStates.returnTo,
        issueId: toolOauthStates.issueId,
        interactionId: toolOauthStates.interactionId,
      })
      .from(toolOauthStates)
      .where(eq(toolOauthStates.state, state))
      .limit(1);
    return row ?? null;
  }

  /** Bind a callback to its initiating actor without consuming retryable state. */
async function validateOAuthState(
    state: string,
    actor: ActorInfo | undefined,
  ) {
    const [stateRow] = await db
      .select()
      .from(toolOauthStates)
      .where(eq(toolOauthStates.state, state))
      .limit(1);
    if (!stateRow)
      throw badRequest("OAuth state was not found or has already been used");
    if (stateRow.expiresAt.getTime() <= Date.now())
      throw badRequest("OAuth state has expired");
    if (stateRow.subjectUserId) {
      if (
        actor?.actorType !== "user" ||
        actor.actorId !== stateRow.subjectUserId
      ) {
        throw forbidden(
          "OAuth callback user does not match the requested subject",
        );
      }
    } else {
      assertSameOAuthActor(stateRow, actor);
    }
    return stateRow;
  }

  /**
   * Answer a terminal authorization callback exactly once. Actor validation
   * happens before the atomic delete, so an unbound callback cannot consume a
   * valid flow and concurrent callbacks cannot both complete it.
   */
async function consumeOAuthState(
    state: string,
    actor: ActorInfo | undefined,
  ) {
    const stateRow = await validateOAuthState(state, actor);
    const [consumed] = await db
      .delete(toolOauthStates)
      .where(eq(toolOauthStates.state, state))
      .returning();
    if (!consumed)
      throw badRequest("OAuth state was not found or has already been used");
    return consumed;
  }

  /**
   * End the board's "Connect your account" prompt when the user declines in the
   * provider's window (PAP-17109). Without this the card stays `pending`, so the
   * board keeps offering an authorization link for a flow the user just refused
   * and the requesting agent never learns the answer.
   *
   * Scoped to a still-`pending` row: a board user who already answered the card
   * directly keeps their own answer.
   */
async function rejectPendingOAuthInteraction(
    stateRow: typeof toolOauthStates.$inferSelect,
    actor: ActorInfo | undefined,
  ) {
    if (!stateRow.interactionId) return;
    const now = new Date();
    const linked = await db
      .select({
        kind: issueThreadInteractions.kind,
        payload: issueThreadInteractions.payload,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.id, stateRow.interactionId),
          eq(issueThreadInteractions.companyId, stateRow.companyId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (linked?.kind === "connection_intent") {
      const connectionIntentPayload = connectionIntentPayloadSchema.parse(
        linked.payload,
      );
      await db
        .update(issueThreadInteractions)
        .set({
          payload: { ...connectionIntentPayload, phase: "needs_retry" },
          updatedAt: now,
        })
        .where(
          and(
            eq(issueThreadInteractions.id, stateRow.interactionId),
            eq(issueThreadInteractions.companyId, stateRow.companyId),
            eq(issueThreadInteractions.status, "pending"),
          ),
        );
      return;
    }
    await db
      .update(issueThreadInteractions)
      .set({
        status: "rejected",
        result: {
          version: 1,
          outcome: "rejected",
          // Paperclip's own words: the provider's explanation is untrusted and
          // this reason is rendered in the thread (PAP-17108).
          reason:
            "Authorization was declined or cancelled in the provider's window",
        },
        resolvedByUserId: actor?.actorType === "user" ? actor.actorId : null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issueThreadInteractions.id, stateRow.interactionId),
          eq(issueThreadInteractions.companyId, stateRow.companyId),
          eq(issueThreadInteractions.status, "pending"),
        ),
      );
  }
  return { peekOAuthState, validateOAuthState, consumeOAuthState, rejectPendingOAuthInteraction };
}
export type OAuthStateStore = ReturnType<typeof createOAuthStateStore>;
