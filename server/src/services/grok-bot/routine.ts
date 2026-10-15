import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, isNotNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { companies, dotAgentBindings as bindings, dotRunnerAssignments as assignments,
  grokBotRoutines as routines, grokBotDispatches as dispatches, mcpOauthGrants, type Db } from "@paperclipai/db";
import { authorizeExternalBotBinding, authorizeExternalBotOperator, externalBotEnabled } from "../external-bot-authority.js";
import { McpOAuthError, type McpPrincipal } from "../public-mcp/oauth.js";
import { secretService } from "../secrets.js";
import { scheduleAgentLifecycle } from "../agent-lifecycle.js";
import { logActivity } from "../activity-log.js";
import { deliverGrokRoutineWake, validateGrokRoutineCredential, type GrokRoutineDelivery, type GrokRoutineWake } from "./webhook.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (message: string) => new McpOAuthError("access_denied", message, 409);
export const grokWakeAcknowledgementSchema = z.object({ correlationId: z.uuid(), bindingId: z.uuid(),
  bindingGeneration: z.number().int().positive(), challenge: z.string().min(20).max(100).optional() }).strict();
type Ack = z.infer<typeof grokWakeAcknowledgementSchema>;
type Delivery = typeof deliverGrokRoutineWake;

/** Serialize work acceptance with the bounded HTTP handoff, without holding
 * binding/assignment row locks that would block Stop or authenticated replies. */
export async function lockGrokRoutineAcceptance(database: Db, bindingId: string) {
  await database.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`grok-routine-acceptance:${bindingId}`}, 0))`);
}

/** Existing shared agent grants and assignments own authority; routines only wake the Bot. */
export function grokRoutineService(db: Db, deliver: Delivery = deliverGrokRoutineWake) {
  async function current(database: Db, companyId: string, agentId: string, bindingId: string, lock = false, allowPaused = false) {
    const query = database.select().from(bindings).where(and(eq(bindings.id, bindingId), eq(bindings.companyId, companyId),
      eq(bindings.agentId, agentId), eq(bindings.providerKind, "grok_bot"), isNull(bindings.revokedAt)));
    const [binding] = lock ? await query.for("update") : await query;
    if (!binding?.grantId || !await externalBotEnabled(database, "grok_bot")) throw fail("Connect the Grok agent before configuring assignments.");
    const [grant] = await database.select().from(mcpOauthGrants).where(and(eq(mcpOauthGrants.id, binding.grantId), isNull(mcpOauthGrants.revokedAt)));
    const [company] = await database.select().from(companies).where(eq(companies.id, companyId));
    if (!grant || company?.status !== "active") throw fail("Agent connection authority is unavailable.");
    await authorizeExternalBotBinding(database, { grant, actor: { type: "agent", companyId, agentId },
      company: { id: company.id, name: company.name, issuePrefix: company.issuePrefix, status: company.status } },
      { provider: "grok_bot", requireReady: false, allowPaused });
    return { binding, grant };
  }

  async function recoveryNeeded(companyId: string, agentId: string) {
    const [held] = await db.select({ id: routines.id }).from(routines).where(and(eq(routines.companyId, companyId), eq(routines.agentId, agentId), isNotNull(routines.recoveryRequiredAt))).limit(1);
    const [uncertain] = await db.select({ id: dispatches.id }).from(dispatches).innerJoin(routines, eq(routines.id, dispatches.routineId))
      .where(and(eq(dispatches.companyId, companyId), eq(routines.agentId, agentId),
        or(eq(dispatches.status, "unknown"), and(eq(dispatches.status, "sending"), lte(dispatches.updatedAt, new Date(Date.now() - 30_000))), and(eq(dispatches.status, "accepted"), lte(dispatches.expiresAt, new Date()))))).limit(1);
    return !!held || !!uncertain;
  }

  async function recover(companyId: string, agentId: string, operatorId: string) {
    await authorizeExternalBotOperator(db, companyId, operatorId);
    await db.transaction(async tx => {
      // All routine writers serialize on the binding before dispatch/routine rows.
      // Include retired bindings so recovery cannot bypass an old activity hold.
      await tx.select({ id: bindings.id }).from(bindings).where(and(eq(bindings.companyId, companyId),
        eq(bindings.agentId, agentId), eq(bindings.providerKind, "grok_bot"))).orderBy(asc(bindings.id)).for("update");
      const rows = await tx.select().from(routines).where(and(eq(routines.companyId, companyId), eq(routines.agentId, agentId))).for("update");
      const [active] = await tx.select({ id: assignments.id }).from(assignments).where(and(eq(assignments.companyId, companyId), eq(assignments.agentId, agentId), inArray(assignments.status, ["offered", "accepted"])));
      if (active) throw fail("Stop or finish the current Paperclip work session before clearing recovery.");
      for (const routine of rows) {
        await tx.update(dispatches).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(dispatches.routineId, routine.id), inArray(dispatches.status, ["prepared", "sending", "accepted", "unknown"])));
        await tx.update(routines).set({ recoveryRequiredAt: null, recoveryReason: null, verifiedAt: null, verifiedGrantId: null, updatedAt: new Date() }).where(eq(routines.id, routine.id));
        await tx.update(bindings).set({ status: "connected", readyAt: null, updatedAt: new Date() }).where(and(eq(bindings.id, routine.bindingId), isNull(bindings.revokedAt)));
      }
      await logActivity(tx as unknown as Db, { companyId, actorType: "user", actorId: operatorId, action: "grok.recovery_inspected",
        entityType: "agent", entityId: agentId, details: { inspectedRemoteWork: true, remoteTerminationConfirmed: false, requiresVerification: true } });
    });
    return { recovered: true, requiresVerification: true, remoteTerminationConfirmed: false };
  }

  async function state(companyId: string, agentId: string, bindingId: string) {
    const [routine] = await db.select().from(routines).where(and(eq(routines.companyId, companyId),
      eq(routines.agentId, agentId), eq(routines.bindingId, bindingId)));
    if (!routine) return null;
    const [last] = await db.select({ id: dispatches.id, kind: dispatches.kind, status: dispatches.status,
      httpStatus: dispatches.httpStatus, sentAt: dispatches.sentAt, acknowledgedAt: dispatches.acknowledgedAt, expiresAt: dispatches.expiresAt })
      .from(dispatches).where(and(eq(dispatches.companyId, companyId), eq(dispatches.routineId, routine.id),
        eq(dispatches.routineRevision, routine.revision))).orderBy(desc(dispatches.createdAt)).limit(1);
    const [binding] = await db.select().from(bindings).where(and(eq(bindings.id, bindingId), eq(bindings.companyId, companyId),
      eq(bindings.agentId, agentId), eq(bindings.generation, routine.bindingGeneration), isNull(bindings.revokedAt)));
    const [grant] = binding?.grantId ? await db.select().from(mcpOauthGrants).where(and(eq(mcpOauthGrants.id, binding.grantId), isNull(mcpOauthGrants.revokedAt))) : [];
    return { bindingId, botName: routine.botName, revision: routine.revision, configured: true,
      verified: !!routine.verifiedAt && !!binding && !!grant && binding.grantId === routine.verifiedGrantId,
      verifiedAt: routine.verifiedAt, lastContactAt: routine.lastContactAt,
      recoveryNeeded: await recoveryNeeded(companyId, agentId), lastExchange: last ?? null };
  }

  async function configure(input: { companyId: string; agentId: string; bindingId: string; operatorId: string;
    expectedRevision: number; botName: string; webhookUrl: string; webhookKey: string }) {
    await authorizeExternalBotOperator(db, input.companyId, input.operatorId);
    if (await recoveryNeeded(input.companyId, input.agentId)) throw fail("Inspect and recover remote work before replacing routine credentials.");
    const secret = validateGrokRoutineCredential(input);
    const botName = z.string().trim().min(1).max(100).parse(input.botName);
    await db.transaction(async tx => {
      const database = tx as unknown as Db;
      const { binding } = await current(database, input.companyId, input.agentId, input.bindingId, true);
      const [active] = await tx.select({ id: assignments.id }).from(assignments).where(and(eq(assignments.bindingId, binding.id), inArray(assignments.status, ["offered", "accepted"])));
      const [old] = await tx.select().from(routines).where(eq(routines.bindingId, binding.id)).for("update");
      const [pending] = old ? await tx.select({ id: dispatches.id }).from(dispatches).where(and(eq(dispatches.routineId, old.id), eq(dispatches.routineRevision, old.revision), inArray(dispatches.status, ["prepared", "sending", "accepted", "unknown"]))) : [];
      if (active || pending || old?.recoveryRequiredAt) throw fail("Inspect and recover existing Paperclip work before replacing routine credentials.");
      if ((old?.revision ?? 0) !== input.expectedRevision) throw fail("Routine configuration changed. Reload before replacing it.");
      const revision = (old?.revision ?? 0) + 1;
      // One fresh immutable secret version prevents partial URL/key replacement.
      const stored = await secretService(database).create(input.companyId, {
        name: `Grok routine ${binding.id} revision ${revision}`, key: `GROK_ROUTINE_${binding.id.replaceAll("-", "_").toUpperCase()}_${revision}`,
        provider: "local_encrypted", value: JSON.stringify(secret), description: "Grok routine sender credential; never provider-visible",
      }, { userId: input.operatorId });
      const values = { companyId: input.companyId, agentId: input.agentId, bindingId: binding.id, bindingGeneration: binding.generation,
        botName, secretId: stored.id, secretVersion: stored.latestVersion, revision,
        verifiedAt: null, verifiedGrantId: null, updatedAt: new Date() };
      if (old) await tx.update(routines).set(values).where(eq(routines.id, old.id));
      else await tx.insert(routines).values(values);
      await tx.update(bindings).set({ status: "connected", readyAt: null, updatedAt: new Date() }).where(eq(bindings.id, binding.id));
      await logActivity(database, { companyId: input.companyId, actorType: "user", actorId: input.operatorId,
        action: "grok.routine_configured", entityType: "agent", entityId: input.agentId,
        details: { bindingId: binding.id, revision } });
    });
    return state(input.companyId, input.agentId, input.bindingId);
  }

  async function reserve(input: { companyId: string; agentId: string; bindingId: string; sourceEventId: string;
    kind: GrokRoutineWake["kind"]; assignmentId?: string; after?: number;
    expectedAuthority?: { grantId: string; generation: number; routineRevision: number } }) {
    if (await recoveryNeeded(input.companyId, input.agentId)) throw fail("Inspect and recover remote work before another delivery.");
    return db.transaction(async tx => {
      const database = tx as unknown as Db;
      const { binding, grant } = await current(database, input.companyId, input.agentId, input.bindingId, true);
      const [routine] = await tx.select().from(routines).where(and(eq(routines.bindingId, binding.id),
        eq(routines.companyId, input.companyId), eq(routines.agentId, input.agentId))).for("update");
      if (!routine || routine.bindingGeneration !== binding.generation || routine.recoveryRequiredAt) throw fail("Configure or recover the Grok routine first.");
      if (input.expectedAuthority && (input.expectedAuthority.grantId !== grant.id
        || input.expectedAuthority.generation !== binding.generation || input.expectedAuthority.routineRevision !== routine.revision)) {
        throw fail("Rejected delivery authority changed.");
      }
      const [old] = await tx.select().from(dispatches).where(and(eq(dispatches.bindingId, binding.id),
        eq(dispatches.bindingGeneration, binding.generation), eq(dispatches.routineRevision, routine.revision), eq(dispatches.sourceEventId, input.sourceEventId)));
      if (old) return old;
      const [active] = input.kind === "verify" ? await tx.select({ id: assignments.id }).from(assignments).where(and(eq(assignments.bindingId, binding.id), inArray(assignments.status, ["offered", "accepted"]))) : [];
      if (active) throw fail("Finish or stop current Paperclip work before verifying the routine again.");
      const [pending] = input.kind === "verify" ? await tx.select({ id: dispatches.id }).from(dispatches).where(and(eq(dispatches.routineId, routine.id), eq(dispatches.routineRevision, routine.revision), eq(dispatches.kind, "verify"), inArray(dispatches.status, ["prepared", "sending", "accepted", "unknown"]))) : [];
      if (pending) throw fail("Verification already has an outstanding delivery. Inspect it before sending another.");
      const correlationId = randomUUID();
      const common = { schema: "paperclip.external_bot_wake.v1" as const, bindingId: binding.id, bindingGeneration: binding.generation, correlationId };
      const challenge = input.kind === "verify" ? randomBytes(24).toString("base64url") : null;
      const wake: GrokRoutineWake = input.kind === "verify" ? { ...common, kind: "verify", challenge: challenge! }
        : input.kind === "authority_revoked" ? { ...common, kind: "authority_revoked", assignmentId: z.uuid().parse(input.assignmentId) }
        : { ...common, kind: "mailbox_updated", after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(input.after ?? 0) };
      if (input.kind === "verify") {
        await tx.update(routines).set({ verifiedAt: null, verifiedGrantId: null, updatedAt: new Date() }).where(eq(routines.id, routine.id));
        await tx.update(bindings).set({ status: "connected", readyAt: null, updatedAt: new Date() }).where(eq(bindings.id, binding.id));
      }
      const [row] = await tx.insert(dispatches).values({ id: correlationId, companyId: input.companyId, routineId: routine.id,
        bindingId: binding.id, bindingGeneration: binding.generation, grantId: grant.id, routineRevision: routine.revision,
        sourceEventId: z.string().min(1).max(240).parse(input.sourceEventId), kind: input.kind,
        assignmentId: input.assignmentId, payload: { ...wake }, challengeHash: challenge ? digest(challenge) : null,
        expiresAt: new Date(Date.now() + 10 * 60_000) }).returning();
      return row!;
    });
  }

  async function send(companyId: string, agentId: string, correlationId: string) {
    const intent = await db.transaction(async tx => {
      const database = tx as unknown as Db;
      const [row] = await tx.select().from(dispatches).where(and(eq(dispatches.id, correlationId), eq(dispatches.companyId, companyId)));
      if (!row) throw fail("Dispatch is unavailable.");
      const { binding } = await current(database, companyId, agentId, row.bindingId, true);
      const [routine] = await tx.select().from(routines).where(eq(routines.id, row.routineId)).for("update");
      if (!routine || routine.agentId !== agentId || row.grantId !== binding.grantId || row.bindingGeneration !== binding.generation
        || row.routineRevision !== routine.revision || routine.recoveryRequiredAt) throw fail("Dispatch authority changed.");
      if (row.status !== "prepared") return null;
      if (row.kind === "mailbox_updated") {
        if (!row.assignmentId) throw fail("Work wake requires an admitted assignment.");
        const { dotRunnerBroker } = await import("../dot-runner-broker.js");
        await dotRunnerBroker(db).assertWakeAuthority(companyId, agentId, row.bindingId, row.assignmentId, { requireOffered: true });
      }
      // Accepted, acknowledged and uncertain work is never sent again after restart.
      if (row.expiresAt <= new Date()) throw fail("Unsent dispatch expired. Inspect before creating a new verification.");
      const [claimed] = await tx.update(dispatches).set({ status: "sending", sentAt: new Date(), updatedAt: new Date() })
        .where(and(eq(dispatches.id, row.id), eq(dispatches.status, "prepared"))).returning();
      return claimed ? { row: claimed, routine } : null;
    });
    if (!intent) {
      const [row] = await db.select().from(dispatches).where(and(eq(dispatches.id, correlationId), eq(dispatches.companyId, companyId)));
      return row ? state(companyId, agentId, row.bindingId) : null;
    }
    let networkAttempted = false;
    let outcome: { delivery: GrokRoutineDelivery["delivery"] | "cancelled"; httpStatus: number | null } = { delivery: "unknown", httpStatus: null };
    try {
      const secret = await secretService(db).resolveSecretValue(companyId, intent.routine.secretId, intent.routine.secretVersion,
        { accessContext: { consumerType: "agent", consumerId: agentId, configPath: "grok.routine", actorType: "system", actorId: "grok-dispatch" } });
      const handoff = async (database: Db) => {
        // Acceptance may have committed while credentials were resolving. An
        // obsolete, unsent wake is cancellation, not a provider rejection.
        if (intent.row.kind === "mailbox_updated") {
          const [assignment] = await database.select({ status: assignments.status }).from(assignments)
            .where(and(eq(assignments.id, intent.row.assignmentId!), eq(assignments.bindingId, intent.row.bindingId)));
          if (assignment && assignment.status !== "offered") return { delivery: "cancelled" as const, httpStatus: null };
        }
        // Recheck after acquiring the acceptance lock and resolving credentials.
        await current(database, companyId, agentId, intent.row.bindingId);
        if (intent.row.kind === "mailbox_updated") {
          const { dotRunnerBroker } = await import("../dot-runner-broker.js");
          await dotRunnerBroker(database).assertWakeAuthority(companyId, agentId, intent.row.bindingId, intent.row.assignmentId!, { requireOffered: true });
        }
        networkAttempted = true;
        return deliver(JSON.parse(secret), intent.row.payload as GrokRoutineWake);
      };
      outcome = intent.row.kind === "mailbox_updated" ? await db.transaction(async tx => {
        const database = tx as unknown as Db;
        await lockGrokRoutineAcceptance(database, intent.row.bindingId);
        return handoff(database);
      }) : await handoff(db);
    } catch { outcome = { delivery: networkAttempted ? "unknown" : "rejected", httpStatus: null }; /* Do not persist exception or response text. */ }
    await db.transaction(async tx => {
      await tx.select({ id: bindings.id }).from(bindings).where(eq(bindings.id, intent.row.bindingId)).for("update");
      const [changed] = await tx.update(dispatches).set({ status: outcome.delivery, httpStatus: outcome.httpStatus, updatedAt: new Date() })
        .where(and(eq(dispatches.id, correlationId), eq(dispatches.status, "sending"))).returning();
      // A matching authenticated reply can win this race and reconcile delivery.
      if (changed?.status === "unknown") await tx.update(routines).set({ recoveryRequiredAt: new Date(), recoveryReason: "dispatch", updatedAt: new Date() })
        .where(and(eq(routines.id, intent.routine.id), eq(routines.revision, intent.routine.revision),
          or(isNull(routines.recoveryReason), eq(routines.recoveryReason, "dispatch"))));
    });
    return state(companyId, agentId, intent.row.bindingId);
  }

  async function retryRejected(companyId: string, agentId: string, operatorId: string, correlationId: string) {
    await authorizeExternalBotOperator(db, companyId, operatorId);
    const [row] = await db.select({ dispatch: dispatches, routine: routines }).from(dispatches)
      .innerJoin(routines, eq(routines.id, dispatches.routineId)).where(and(eq(dispatches.id, correlationId),
        eq(dispatches.companyId, companyId), eq(routines.companyId, companyId), eq(routines.agentId, agentId)));
    if (!row || row.dispatch.status !== "rejected") throw fail("Only a confirmed rejected delivery can be retried.");
    const { binding } = await current(db, companyId, agentId, row.dispatch.bindingId);
    if (row.dispatch.grantId !== binding.grantId || row.dispatch.bindingGeneration !== binding.generation
      || row.dispatch.routineRevision !== row.routine.revision) throw fail("Rejected delivery authority changed.");
    if (row.dispatch.kind === "mailbox_updated") {
      if (!row.dispatch.assignmentId) throw fail("Work wake requires an admitted assignment.");
      const { dotRunnerBroker } = await import("../dot-runner-broker.js");
      await dotRunnerBroker(db).assertWakeAuthority(companyId, agentId, binding.id, row.dispatch.assignmentId, { requireOffered: true });
    }
    // Retain the rejected receipt. Concurrent clicks reserve the same next intent;
    // accepted/unknown work can never enter this path, and is never replayed.
    const intent = await reserve({ companyId, agentId, bindingId: binding.id,
      sourceEventId: `retry:${row.dispatch.id}`, kind: row.dispatch.kind,
      expectedAuthority: { grantId: row.dispatch.grantId, generation: row.dispatch.bindingGeneration, routineRevision: row.dispatch.routineRevision },
      ...(row.dispatch.assignmentId ? { assignmentId: row.dispatch.assignmentId } : {}),
      after: (row.dispatch.payload as GrokRoutineWake & { after?: number }).after });
    await logActivity(db, { companyId, actorType: "user", actorId: operatorId, action: "grok.delivery_retry_requested",
      entityType: "agent", entityId: agentId, details: { rejectedCorrelationId: row.dispatch.id, correlationId: intent.id } });
    return send(companyId, agentId, intent.id);
  }

  /** Called in the authoritative successful-finish transaction, with the binding lock held. */
  async function settleWorkNotifications(companyId: string, bindingId: string, assignmentId: string) {
    const [assignment] = await db.select({ id: assignments.id }).from(assignments).where(and(eq(assignments.id, assignmentId),
      eq(assignments.companyId, companyId), eq(assignments.bindingId, bindingId), eq(assignments.status, "settled")));
    if (!assignment) throw fail("Only settled work can close its notification obligation.");
    await db.update(dispatches).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(dispatches.companyId, companyId),
      eq(dispatches.bindingId, bindingId), eq(dispatches.assignmentId, assignmentId), eq(dispatches.kind, "mailbox_updated"),
      inArray(dispatches.status, ["prepared", "sending", "accepted", "unknown"])));
    const [uncertain] = await db.select({ id: dispatches.id }).from(dispatches).where(and(eq(dispatches.companyId, companyId),
      eq(dispatches.bindingId, bindingId), or(eq(dispatches.status, "unknown"),
        and(eq(dispatches.status, "sending"), lte(dispatches.updatedAt, new Date(Date.now() - 30_000))),
        and(eq(dispatches.status, "accepted"), lte(dispatches.expiresAt, new Date()))))).limit(1);
    // A canonical finish closes this session; it never proves a webhook ACK or
    // restores execution authority. Other uncertain deliveries keep their hold.
    if (!uncertain) await db.update(routines).set({ recoveryRequiredAt: null, recoveryReason: null, updatedAt: new Date() })
      .where(and(eq(routines.companyId, companyId), eq(routines.bindingId, bindingId), eq(routines.recoveryReason, "dispatch")));
  }

  async function acknowledge(principal: McpPrincipal, raw: Ack) {
    const input = grokWakeAcknowledgementSchema.parse(raw);
    const binding = await authorizeExternalBotBinding(db, principal, { provider: "grok_bot", requireReady: false, allowPaused: true });
    if (input.bindingId !== binding.id || input.bindingGeneration !== binding.generation) throw fail("Wake is outside this connection.");
    const result = await db.transaction(async tx => {
      const database = tx as unknown as Db;
      const { binding: currentBinding } = await current(database, binding.companyId, binding.agentId, binding.id, true, true);
      const [row] = await tx.select().from(dispatches).where(and(eq(dispatches.id, input.correlationId),
        eq(dispatches.companyId, binding.companyId), eq(dispatches.bindingId, binding.id), eq(dispatches.bindingGeneration, binding.generation),
        eq(dispatches.grantId, principal.grant.id))).for("update");
      const [routine] = row ? await tx.select().from(routines).where(eq(routines.id, row.routineId)).for("update") : [];
      if (!row || !routine || routine.bindingGeneration !== currentBinding.generation || row.routineRevision !== routine.revision
        || row.expiresAt <= new Date() || !["sending", "accepted", "unknown", "acknowledged", "cancelled"].includes(row.status)) throw fail("Wake expired, was cancelled, or its authority changed.");
      if (row.kind === "verify") {
        if (row.status === "cancelled") throw fail("Verification was cancelled.");
        await authorizeExternalBotBinding(database, principal, { provider: "grok_bot", requireReady: false });
        if (!input.challenge || !row.challengeHash || !timingSafeEqual(Buffer.from(digest(input.challenge)), Buffer.from(row.challengeHash))) throw fail("Verification challenge does not match.");
      } else {
        if (input.challenge) throw fail("This wake is not a verification challenge.");
        const [assignment] = row.assignmentId ? await tx.select().from(assignments).where(and(eq(assignments.id, row.assignmentId),
          eq(assignments.companyId, binding.companyId), eq(assignments.bindingId, binding.id), eq(assignments.bindingGeneration, binding.generation),
          eq(assignments.agentId, binding.agentId))) : [];
        const settledDelivery = row.kind === "mailbox_updated" && assignment?.status === "settled" && !!row.sentAt;
        if (row.status === "cancelled" && !settledDelivery) throw fail("Wake was cancelled.");
        if (row.kind === "mailbox_updated" && row.assignmentId && !settledDelivery) {
          const { dotRunnerBroker } = await import("../dot-runner-broker.js");
          await dotRunnerBroker(db).assertWakeAuthority(binding.companyId, binding.agentId, binding.id, row.assignmentId);
        }
        if (!assignment || (row.kind === "authority_revoked" ? assignment.status !== "fenced"
          : !settledDelivery && (!["offered", "accepted"].includes(assignment.status) || assignment.expiresAt <= new Date()))) throw fail("Work wake authority is no longer current.");
      }
      if (row.status === "acknowledged") return { status: "acknowledged", correlationId: row.id, workSessionClosed: false, remoteTerminationConfirmed: false };
      await tx.update(dispatches).set({ status: "acknowledged", acknowledgedAt: new Date(), updatedAt: new Date() }).where(eq(dispatches.id, row.id));
      await tx.update(routines).set({ lastContactAt: new Date(), updatedAt: new Date(),
        ...(row.kind === "verify" ? { verifiedAt: new Date(), verifiedGrantId: principal.grant.id } : {}) }).where(eq(routines.id, routine.id));
      if (row.kind !== "authority_revoked") {
        const [other] = await tx.select({ id: dispatches.id }).from(dispatches).where(and(eq(dispatches.routineId, routine.id),
          or(eq(dispatches.status, "unknown"), and(eq(dispatches.status, "sending"), lte(dispatches.updatedAt, new Date(Date.now() - 30_000))),
            and(eq(dispatches.status, "accepted"), lte(dispatches.expiresAt, new Date()))))).limit(1);
        if (!other) await tx.update(routines).set({ recoveryRequiredAt: null, recoveryReason: null })
          .where(and(eq(routines.id, routine.id), eq(routines.recoveryReason, "dispatch")));
      }
      if (row.kind === "verify") await tx.update(bindings).set({ status: "ready", readyAt: new Date(), updatedAt: new Date() }).where(eq(bindings.id, binding.id));
      await logActivity(database, { companyId: binding.companyId, actorType: "agent", actorId: binding.agentId,
        action: row.kind === "verify" ? "grok.wake_verified" : "grok.wake_acknowledged", entityType: "agent", entityId: binding.agentId,
        details: { bindingId: binding.id, generation: binding.generation, correlationId: row.id, kind: row.kind,
          authorizingPersonId: binding.operatorId, grantId: principal.grant.id, remoteTerminationConfirmed: false } });
      return { status: "acknowledged", correlationId: row.id, workSessionClosed: false, remoteTerminationConfirmed: false };
    });
    if (input.challenge) scheduleAgentLifecycle(db, binding.agentId);
    return result;
  }
  return { state, configure, reserve, send, acknowledge, settleWorkNotifications, recoveryNeeded, recover, retryRejected };
}
