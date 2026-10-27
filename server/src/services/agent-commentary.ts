import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentCommentary, agents, heartbeatRuns, issues, nativeRunResults, type Db } from "@paperclipai/db";
import { isUuidLike, submitAgentCommentarySchema, type AgentCommentaryAcknowledgement } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, HttpError } from "../errors.js";
import { redactSensitiveText } from "../redaction.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";
import { agentRunWritesRevoked } from "../agent-run-cancellation.js";

type CommentaryActor = { companyId: string; agentId: string; runId: string; agentApiKeyId?: string | null };

function boundIssue(run: typeof heartbeatRuns.$inferSelect): string | null {
  const snapshot = run.contextSnapshot ?? {};
  const id = run.nativeIssueId ?? snapshot.issueId ?? snapshot.taskId;
  if (id == null) return null;
  if (typeof id !== "string" || !isUuidLike(id)) throw forbidden("Feedback requires a valid run task binding");
  return id;
}

/** Both transports share authorization, persistence and replay; no task state is changed. */
export async function submitAgentCommentary(
  db: Db,
  actor: CommentaryActor,
  value: unknown,
  authorizeNative?: (tx: Db) => Promise<unknown>,
): Promise<AgentCommentaryAcknowledgement> {
  const parsed = submitAgentCommentarySchema.safeParse(value);
  if (!parsed.success) throw badRequest("Feedback requires a kind, nonempty body of at most 524288 characters, and a retry key of at most 240 characters; no other fields are accepted");
  if (![actor.companyId, actor.agentId, actor.runId].every(isUuidLike)) {
    throw forbidden("Feedback requires an authenticated agent run");
  }
  const input = parsed.data;
  const payloadHash = createHash("sha256").update(JSON.stringify([input.kind, input.body])).digest("hex");
  try {
    const { result, publication } = await db.transaction(async (tx) => {
      const scopedDb = tx as unknown as Db;
      // Native authority locks issue before run. Legacy follows the same lock order.
      if (authorizeNative) await authorizeNative(scopedDb);
      const predicate = and(eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, actor.companyId), eq(heartbeatRuns.agentId, actor.agentId));
      const [initialRun] = await tx.select().from(heartbeatRuns).where(predicate);
      if (!initialRun) throw forbidden("Feedback requires an authenticated agent run");
      const issueId = boundIssue(initialRun);
      const [issue] = issueId ? await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, actor.companyId))).for("update") : [];
      const [context] = await tx.select({ run: heartbeatRuns, agent: agents }).from(heartbeatRuns)
        .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
        .where(predicate).for("update");
      if (!context || context.run.status !== "running"
        || agentRunWritesRevoked(context.run)
        || ["paused", "terminated", "pending_approval", "error"].includes(context.agent.status)
        || boundIssue(context.run) !== issueId
        || (issueId && !issue)
        || (issue?.executionRunId && issue.executionRunId !== actor.runId)
        || (issue?.conversationAgentId && Number(context.run.contextSnapshot?.conversationSessionGeneration ?? 0) !== issue.conversationSessionGeneration)) {
        throw forbidden("The agent run is no longer authorized to submit feedback");
      }
      if (context.run.runtimeMode === "native") {
        if (!authorizeNative) throw forbidden("Native runs submit feedback through their bound tools");
        const [finished] = await tx.select({ id: nativeRunResults.id }).from(nativeRunResults)
          .where(and(eq(nativeRunResults.companyId, actor.companyId), eq(nativeRunResults.runId, actor.runId), eq(nativeRunResults.schemaStatus, "accepted"))).limit(1);
        if (finished) throw forbidden("Feedback must be submitted before finishing the run");
      }
      const [prior] = await tx.select().from(agentCommentary).where(and(
        eq(agentCommentary.companyId, actor.companyId), eq(agentCommentary.runId, actor.runId), eq(agentCommentary.idempotencyKey, input.idempotencyKey),
      ));
      if (prior) {
        if (prior.payloadHash !== payloadHash) throw conflict("Feedback retry key was already used with different content");
        return { result: { id: prior.id, kind: prior.kind, createdAt: prior.createdAt.toISOString(), replayed: true }, publication: null };
      }
      const body = redactSensitiveText(await createRunSecretRedactionRegistry(scopedDb).redactForRun(actor.companyId, actor.runId, input.body));
      const [row] = await tx.insert(agentCommentary).values({
        companyId: actor.companyId, agentId: actor.agentId, runId: actor.runId,
        issueId, kind: input.kind, body, idempotencyKey: input.idempotencyKey, payloadHash,
      }).returning({ id: agentCommentary.id, kind: agentCommentary.kind, createdAt: agentCommentary.createdAt });
      const { publication } = await persistActivity(scopedDb, {
        companyId: actor.companyId, actorType: "agent", actorId: actor.agentId, agentId: actor.agentId,
        runId: actor.runId, agentApiKeyId: actor.agentApiKeyId, issueId,
        action: "agent.commentary_submitted", entityType: "agent_commentary", entityId: row.id,
        details: { kind: row.kind },
      });
      return { result: { id: row.id, kind: row.kind, createdAt: row.createdAt.toISOString(), replayed: false }, publication };
    });
    if (publication) publishActivity(publication);
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Driver errors can include SQL parameters containing the entire feedback body.
    throw new HttpError(503, "Feedback could not be stored. Continue the primary task without retrying.");
  }
}
