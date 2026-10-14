import { and, eq, isNull } from "drizzle-orm";
import {
  agentApiKeys,
  authUsers,
  companyMemberships,
  heartbeatRuns,
  runIdentityContexts,
  type Db,
} from "@paperclipai/db";
import { forbidden } from "../errors.js";
import {
  authorizationService,
  authorizationDeniedDetails,
  type AuthorizationActor,
} from "./authorization.js";
import {
  agentInstructionsChangeTargetKey,
  changeConsentGateService,
} from "./change-consent-gate.js";

type Connection = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Accept ONLY a server-authenticated actor, never request/tool JSON. Rebind run/key provenance on every call. */
export async function resolveInstructionActor(
  db: Connection,
  actor: AuthorizationActor,
): Promise<AuthorizationActor> {
  if (actor.type === "board") {
    if (!actor.userId)
      throw forbidden("Instruction edits require an authenticated user");
    // Discard caller membership caches so revoked access is observed.
    return {
      type: "board",
      userId: actor.userId,
      source: actor.source,
      ignoreInstanceAdmin: actor.ignoreInstanceAdmin,
    };
  }
  if (actor.type !== "agent" || !actor.agentId || !actor.companyId)
    throw forbidden("Instruction identity is missing");
  let responsibleUserId: string | null = null;
  let keyScope = actor.keyScope;
  if (actor.keyId) {
    const [key] = await db
      .select()
      .from(agentApiKeys)
      .where(
        and(
          eq(agentApiKeys.id, actor.keyId),
          eq(agentApiKeys.companyId, actor.companyId),
          eq(agentApiKeys.agentId, actor.agentId),
          isNull(agentApiKeys.revokedAt),
        ),
      );
    if (!key)
      throw forbidden("Instruction API key is missing or revoked", {
        code: "INSTRUCTION_IDENTITY_INVALID",
      });
    responsibleUserId = key.responsibleUserId;
    keyScope = key.scopeConfig ?? undefined;
  }
  if (actor.runId) {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, actor.runId),
          eq(heartbeatRuns.companyId, actor.companyId),
          eq(heartbeatRuns.agentId, actor.agentId),
        ),
      );
    if (!run)
      throw forbidden("Instruction run identity does not match", {
        code: "INSTRUCTION_IDENTITY_INVALID",
      });
    if (actor.keyId && responsibleUserId !== run.responsibleUserId)
      throw forbidden("Key and run responsible identity do not match", {
        code: "INSTRUCTION_IDENTITY_INVALID",
      });
    responsibleUserId = run.responsibleUserId;
    if (run.activeIdentityContextId) {
      const [context] = await db
        .select()
        .from(runIdentityContexts)
        .where(
          and(
            eq(runIdentityContexts.id, run.activeIdentityContextId),
            eq(runIdentityContexts.runId, run.id),
            eq(runIdentityContexts.companyId, run.companyId),
            eq(runIdentityContexts.status, "accepted"),
          ),
        );
      if (!context)
        throw forbidden("Instruction run identity is unavailable", {
          code: "INSTRUCTION_IDENTITY_INVALID",
        });
      responsibleUserId = context.responsibleUserId;
    }
  }
  if (
    !responsibleUserId ||
    (actor.onBehalfOfUserId && actor.onBehalfOfUserId !== responsibleUserId)
  ) {
    throw forbidden("A current server-bound responsible user is required", {
      code: "INSTRUCTION_IDENTITY_INVALID",
    });
  }
  const [membership] = await db
    .select({ userId: authUsers.id })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(
      and(
        eq(companyMemberships.companyId, actor.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, responsibleUserId),
        eq(companyMemberships.status, "active"),
      ),
    );
  if (!membership)
    throw forbidden("The responsible user is unavailable in this company", {
      code: "RESPONSIBLE_USER_UNAVAILABLE",
    });
  return {
    type: "agent",
    agentId: actor.agentId,
    companyId: actor.companyId,
    runId: actor.runId,
    keyId: actor.keyId,
    keyScope,
    source: actor.source,
    onBehalfOfUserId: responsibleUserId,
  };
}

/** Instruction content is narrower than general same-company agent visibility. */
export async function authorizeInstructionRead(
  db: Connection,
  actor: AuthorizationActor,
  target: { companyId: string; id: string },
) {
  const bound = await resolveInstructionActor(db, actor);
  const access = authorizationService(db);
  const resource = { type: "agent" as const, companyId: target.companyId, agentId: target.id };
  const peer = bound.type === "agent" && bound.agentId !== target.id;
  const decision = await access.decide({
    actor: bound,
    action: peer ? "agent_config:read" : "agent:read",
    resource,
    scope: { targetAgentId: target.id },
  });
  if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  return bound;
}

/** Current target edit access + agent containment + protected-change consent, shared by all writers. */
export async function authorizeInstructionCommit(
  db: Connection,
  actor: AuthorizationActor,
  target: { companyId: string; id: string },
) {
  const bound = await resolveInstructionActor(db, actor);
  const access = authorizationService(db);
  const input = {
    actor: bound,
    action: "agent_instructions:update" as const,
    resource: {
      type: "agent" as const,
      companyId: target.companyId,
      agentId: target.id,
    },
    scope: { targetAgentId: target.id, requiresChangeGrant: true },
  };
  let decision = await access.decide(input);
  if (
    !decision.allowed &&
    decision.reason === "deny_missing_consent" &&
    bound.type === "agent"
  ) {
    await changeConsentGateService(db).assertConsented({
      companyId: target.companyId,
      actorAgentId: bound.agentId,
      actorRunId: bound.runId,
      targetKeys: [agentInstructionsChangeTargetKey(target.id)],
    });
    decision = await access.decide({
      ...input,
      scope: { ...input.scope, consentedChange: true },
    });
  }
  if (!decision.allowed)
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  return bound;
}
