import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { chatConversations, chatEndpoints, chatMessageLinks, heartbeatRuns, issueComments, runIdentityContexts, type Db } from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import { forbidden, HttpError } from "../../errors.js";
import { boundRunIssueId, boundRunIssueIdSql } from "../run-task-binding.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "responsibleUserId" | "activeIdentityContextId" | "nativeIssueId" | "issueId" | "contextSnapshot">;
type Context = typeof runIdentityContexts.$inferSelect;
type Options = { allowLegacyWakeComment?: boolean; provider?: ChatProvider };

/** A value of one provenance read: a literal of the run in a single read, or a
 * column of the request row in a batch read. */
type Value = string | SQL;

const contextColumns = {
  id: runIdentityContexts.id, runId: runIdentityContexts.runId, companyId: runIdentityContexts.companyId,
  status: runIdentityContexts.status, responsibleUserId: runIdentityContexts.responsibleUserId,
  messageId: runIdentityContexts.messageId, parentContextId: runIdentityContexts.parentContextId,
};
const readColumns = {
  context: contextColumns,
  link: { issueId: chatConversations.issueId, provider: chatEndpoints.provider },
  boardMessage: { authorUserId: issueComments.authorUserId },
  parent: contextColumns,
  sourceRun: {
    issueId: boundRunIssueIdSql().as("bound_issue_id"),
    responsibleUserId: heartbeatRuns.responsibleUserId,
    wakeCommentId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'wakeCommentId'`.as("wake_comment_id"),
  },
};

/** The reads of the provenance check. Each read returns its first row, if
 * any. The single check and the batch check build every read here, so both
 * apply the same joins, company scope and filters. */
const provenanceReads = {
  /** The active identity context of the run. */
  context: (db: Db, of: Record<"contextId" | "runId" | "companyId", Value>) => db.select(readColumns.context)
    .from(runIdentityContexts).where(and(
      eq(runIdentityContexts.id, of.contextId),
      eq(runIdentityContexts.runId, of.runId),
      eq(runIdentityContexts.companyId, of.companyId),
      eq(runIdentityContexts.status, "accepted"),
    )).limit(1),
  /** The channel conversation that received the accepted message. */
  link: (db: Db, of: Record<"messageId" | "companyId", Value>) => db.select(readColumns.link).from(chatMessageLinks)
    .innerJoin(chatConversations, and(eq(chatConversations.id, chatMessageLinks.conversationId), eq(chatConversations.companyId, of.companyId)))
    .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatConversations.endpointId), eq(chatEndpoints.companyId, of.companyId)))
    .where(and(eq(chatMessageLinks.companyId, of.companyId), eq(chatMessageLinks.commentId, of.messageId),
      eq(chatMessageLinks.direction, "inbound"))).limit(1),
  /** The accepted message as a board message of the task of the run. */
  boardMessage: (db: Db, of: Record<"messageId" | "companyId" | "issueId", Value>) => db.select(readColumns.boardMessage)
    .from(issueComments).where(and(
      eq(issueComments.id, of.messageId), eq(issueComments.companyId, of.companyId),
      eq(issueComments.issueId, of.issueId),
      or(eq(issueComments.authorType, "user"), and(isNull(issueComments.authorType), isNull(issueComments.authorAgentId))),
      isNull(issueComments.deletedAt),
    )).limit(1),
  /** The identity context that the current context continues. */
  parent: (db: Db, of: Record<"contextId" | "companyId", Value>) => db.select(readColumns.parent)
    .from(runIdentityContexts).where(and(
      eq(runIdentityContexts.id, of.contextId),
      eq(runIdentityContexts.companyId, of.companyId),
      eq(runIdentityContexts.status, "accepted"),
    )).limit(1),
  /** The run of the parent context, for the same agent. */
  sourceRun: (db: Db, of: Record<"runId" | "companyId" | "agentId", Value>) => db.select(readColumns.sourceRun)
    .from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, of.runId),
      eq(heartbeatRuns.companyId, of.companyId),
      eq(heartbeatRuns.agentId, of.agentId),
    )).limit(1),
};

type Kind = keyof typeof provenanceReads;
type Row<K extends Kind> = Awaited<ReturnType<typeof provenanceReads[K]>>[number];
type Values<K extends Kind> = Record<keyof Parameters<typeof provenanceReads[K]>[1], string>;
type Read = { [K in Kind]: { kind: K; values: Values<K> } }[Kind];
type ReadOf = (db: Db, of: Record<string, Value>) => ReturnType<typeof provenanceReads[Kind]>;
type Walk = Generator<Read, string | null, unknown>;

/** Every value of a read is a UUID. A run without a task binding matches no board message. */
const NO_TASK = "00000000-0000-0000-0000-000000000000";

function* read<K extends Kind>(kind: K, values: Values<K>): Generator<Read, Row<K> | undefined, unknown> {
  return (yield { kind, values } as Read) as Row<K> | undefined;
}

/** The provenance decision for one run. The walk asks for one read at a time
 * and decides on the returned rows only, so the single check and the batch
 * check make the same decision from the same rows. */
function* sourceMessageWalk(run: Run, options: Options & { context?: Row<"context"> | null }): Walk {
  let legacyMessageId = options.allowLegacyWakeComment && typeof run.contextSnapshot?.wakeCommentId === "string"
    ? run.contextSnapshot.wakeCommentId : null;
  if (!run.activeIdentityContextId) {
    return legacyMessageId;
  }
  const active = options.context ?? (yield* read("context", {
    contextId: run.activeIdentityContextId, runId: run.id, companyId: run.companyId,
  }));
  if (!active || active.id !== run.activeIdentityContextId || active.runId !== run.id ||
      active.companyId !== run.companyId || active.status !== "accepted" ||
      active.responsibleUserId !== run.responsibleUserId) {
    throw forbidden("Chat requester provenance changed");
  }
  let origin: Row<"context"> = active;
  const seen = new Set<string>();
  let acceptedMessageSeen = false;
  while (true) {
    if (origin.messageId) {
      acceptedMessageSeen = true;
      if (!options.provider) return origin.messageId;
      const link = yield* read("link", { messageId: origin.messageId, companyId: run.companyId });
      if (link) {
        if (link.issueId !== boundRunIssueId(run)) throw forbidden("Chat request belongs to another task");
        if (link.provider !== options.provider) return null;
        return origin.messageId;
      }
      const message = yield* read("boardMessage", {
        messageId: origin.messageId, companyId: run.companyId, issueId: boundRunIssueId(run) ?? NO_TASK,
      });
      if (!run.responsibleUserId || message?.authorUserId !== run.responsibleUserId) throw forbidden("Chat requester provenance changed");
      // This verified board message may continue its same-user channel history,
      // but its own wake metadata is not the earlier channel request.
      legacyMessageId = null;
    }
    if (!origin.parentContextId) return legacyMessageId;
    if (seen.has(origin.id)) throw forbidden("Chat source provenance could not be verified");
    seen.add(origin.id);
    const parent: Row<"parent"> | undefined = yield* read("parent", { contextId: origin.parentContextId, companyId: run.companyId });
    if (!parent) throw forbidden("Chat requester provenance changed");
    if (parent.responsibleUserId !== run.responsibleUserId) {
      if (acceptedMessageSeen) return null;
      throw forbidden("Chat requester provenance changed");
    }
    const sourceRun = yield* read("sourceRun", { runId: parent.runId, companyId: run.companyId, agentId: run.agentId });
    if (!sourceRun || !boundRunIssueId(run) || sourceRun.issueId !== boundRunIssueId(run)) {
      throw forbidden("Chat tools cannot be inherited by another task");
    }
    if (options.allowLegacyWakeComment && sourceRun.responsibleUserId === run.responsibleUserId &&
        typeof sourceRun.wakeCommentId === "string") legacyMessageId ??= sourceRun.wakeCommentId;
    origin = parent;
  }
}

export async function chatRunSourceMessageId(db: Db, run: Run, options: Options & { context?: Context | null } = {}): Promise<string | null> {
  const walk = sourceMessageWalk(run, options);
  let step = walk.next();
  while (!step.done) {
    const [row] = await (provenanceReads[step.value.kind] as ReadOf)(db, step.value.values);
    step = walk.next(row);
  }
  return step.value;
}

const request = sql.identifier("chat_run_source_request");
const ORDINAL = "chatRunSourceRequestOrdinal";

/** The reads of one kind for many runs, in one statement. For each request
 * row, the lateral subquery is the single read with the request columns in
 * place of the literals, so each request gets the row of its single read. */
async function readRows(db: Db, kind: Kind, requests: Array<Record<string, string>>): Promise<unknown[]> {
  const names = Object.keys(requests[0]!);
  const column = (name: string) => sql`${request}.${sql.identifier(name)}`;
  const found = (provenanceReads[kind] as ReadOf)(db, Object.fromEntries(names.map(name => [name, column(name)])))
    .as("chat_run_source_row");
  const columns = found as unknown as Record<string, SQL>;
  const rows = await db.select({
    [ORDINAL]: sql<number>`${column("ordinal")}`.mapWith(Number),
    ...Object.fromEntries(Object.keys(readColumns[kind]).map(name => [name, columns[name]!])),
  }).from(sql`unnest(${sql.join(names.map(name => sql`${sql.param(requests.map(values => values[name]))}::uuid[]`), sql`, `)})
    with ordinality as ${request}(${sql.join([...names, "ordinal"].map(name => sql.identifier(name)), sql`, `)})`)
    .crossJoinLateral(found);
  const result: unknown[] = new Array(requests.length).fill(undefined);
  for (const { [ORDINAL]: ordinal, ...row } of rows) result[(ordinal as number) - 1] = row;
  return result;
}

/** The result of `chatRunSourceMessageId` for one run of a batch: the message
 * that the single check returns, or the 403 that it throws. */
export type ChatRunSourceMessage = { messageId: string | null } | { forbidden: HttpError };

/** `chatRunSourceMessageId` for many runs. Each run gets the decision of a
 * separate call, from the same walk and the same reads. The runs that wait for
 * the same kind of read share one statement, so the number of statements
 * follows the longest requester lineage, not the number of runs. A database
 * error rejects the whole batch. */
export async function chatRunSourceMessageIds(db: Db, runs: Run[], options: Options = {}): Promise<ChatRunSourceMessage[]> {
  const results = new Array<ChatRunSourceMessage>(runs.length);
  let waiting: Array<{ index: number; walk: Walk; read: Read }> = [];
  const advance = (index: number, walk: Walk, row?: unknown) => {
    try {
      const step = walk.next(row);
      if (step.done) results[index] = { messageId: step.value };
      else waiting.push({ index, walk, read: step.value });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 403) throw error;
      results[index] = { forbidden: error };
    }
  };
  runs.forEach((run, index) => advance(index, sourceMessageWalk(run, options)));
  while (waiting.length) {
    const round = waiting;
    waiting = [];
    for (const kind of new Set(round.map(entry => entry.read.kind))) {
      const entries = round.filter(entry => entry.read.kind === kind);
      const rows = await readRows(db, kind, entries.map(entry => entry.read.values));
      entries.forEach((entry, position) => advance(entry.index, entry.walk, rows[position]));
    }
  }
  return results;
}
