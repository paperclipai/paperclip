import { createHash } from "node:crypto";

import { and, desc, eq, isNull } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import {
  agents,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  nativeSemanticReceipts,
} from "@paperclipai/db";
import {
  PaperclipSemanticDispatcher,
  digestPaperclipSemanticContent,
  type PaperclipJsonValue,
  type PaperclipSemanticActionBinding,
  type PaperclipSemanticActionId,
  type PaperclipSemanticAuthorizationRecord,
  type PaperclipSemanticIdempotencyStore,
  type PaperclipSemanticRunContext,
  type PaperclipSemanticStoredOutcome,
  type PaperclipSemanticToolCall,
  type PaperclipSemanticToolDefinition,
  type PaperclipSemanticToolResult,
} from "../../vendor/paperclip-runner/index.js";

export interface PaperclipRunnerSemanticBinding {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly agentId: string;
}

const READ_OPERATION_IDS = [
  "get_task_context",
  "get_task_history",
  "list_documents",
  "read_document",
  "list_document_revisions",
] as const satisfies readonly PaperclipSemanticActionId[];

const WRITE_OPERATION_IDS = [
  "report_progress",
] as const satisfies readonly PaperclipSemanticActionId[];

type BoundContext = {
  readonly run: typeof heartbeatRuns.$inferSelect;
  readonly issue: typeof issues.$inferSelect;
  readonly agent: typeof agents.$inferSelect;
};

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(1, Math.min(value, 200))
    : 50;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) {
    throw new Error("paperclip_runner_semantic_input_invalid");
  }
  return value;
}

function requiredBody(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 20_000) {
    throw new Error("paperclip_runner_semantic_input_invalid");
  }
  return value;
}

function stableUuid(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function semanticScope(input: {
  companyId: string;
  runId: string;
  operationId: PaperclipSemanticActionId;
  idempotencyKey: string;
}): string {
  return digestPaperclipSemanticContent([
    input.companyId,
    input.runId,
    input.operationId,
    input.idempotencyKey,
  ]);
}

function claimToken(scope: string): string {
  return stableUuid(`paperclip-runner-semantic:${scope}`);
}

class RunnerSemanticIdempotencyStore implements PaperclipSemanticIdempotencyStore {
  readonly #db: Db;
  readonly #binding: PaperclipRunnerSemanticBinding;

  constructor(db: Db, binding: PaperclipRunnerSemanticBinding) {
    this.#db = db;
    this.#binding = binding;
  }

  async claim(input: {
    readonly scope: string;
    readonly operationId: PaperclipSemanticActionId;
    readonly inputDigest: string;
  }) {
    const token = claimToken(input.scope);
    const inserted = await this.#db
      .insert(nativeSemanticReceipts)
      .values({
        id: token,
        companyId: this.#binding.companyId,
        issueId: this.#binding.issueId,
        runId: this.#binding.runId,
        operationId: input.operationId,
        scopeDigest: input.scope,
        inputDigest: input.inputDigest,
      })
      .onConflictDoNothing()
      .returning({ id: nativeSemanticReceipts.id });
    if (inserted.length > 0) return { kind: "claimed" as const, token };
    const [existing] = await this.#db
      .select({
        operationId: nativeSemanticReceipts.operationId,
        scopeDigest: nativeSemanticReceipts.scopeDigest,
        inputDigest: nativeSemanticReceipts.inputDigest,
        status: nativeSemanticReceipts.status,
        outcome: nativeSemanticReceipts.outcome,
        updatedAt: nativeSemanticReceipts.updatedAt,
      })
      .from(nativeSemanticReceipts)
      .where(
        and(
          eq(nativeSemanticReceipts.id, token),
          eq(nativeSemanticReceipts.companyId, this.#binding.companyId),
          eq(nativeSemanticReceipts.issueId, this.#binding.issueId),
          eq(nativeSemanticReceipts.runId, this.#binding.runId),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("paperclip_runner_semantic_receipt_missing");
    if (
      existing.operationId !== input.operationId ||
      existing.scopeDigest !== input.scope ||
      existing.inputDigest !== input.inputDigest
    ) {
      return { kind: "conflict" as const };
    }
    if (existing.status === "claimed") {
      if (Date.now() - existing.updatedAt.getTime() < 60_000) {
        return { kind: "in_progress" as const };
      }
      const reclaimed = await this.#db
        .update(nativeSemanticReceipts)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(nativeSemanticReceipts.id, token),
            eq(nativeSemanticReceipts.status, "claimed"),
            eq(nativeSemanticReceipts.updatedAt, existing.updatedAt),
          ),
        )
        .returning({ id: nativeSemanticReceipts.id });
      return reclaimed.length === 1
        ? { kind: "claimed" as const, token }
        : { kind: "in_progress" as const };
    }
    if (existing.status === "completed" && existing.outcome) {
      return {
        kind: "duplicate" as const,
        outcome: existing.outcome as unknown as PaperclipSemanticStoredOutcome,
      };
    }
    return { kind: "conflict" as const };
  }

  async complete(token: string, outcome: PaperclipSemanticStoredOutcome): Promise<void> {
    const updated = await this.#db
      .update(nativeSemanticReceipts)
      .set({
        status: "completed",
        outcome: outcome as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nativeSemanticReceipts.id, token),
          eq(nativeSemanticReceipts.companyId, this.#binding.companyId),
          eq(nativeSemanticReceipts.issueId, this.#binding.issueId),
          eq(nativeSemanticReceipts.runId, this.#binding.runId),
          eq(nativeSemanticReceipts.status, "claimed"),
        ),
      )
      .returning({ id: nativeSemanticReceipts.id });
    if (updated.length !== 1) throw new Error("paperclip_runner_semantic_receipt_missing");
  }

  async recover(token: string, outcome: PaperclipSemanticStoredOutcome): Promise<void> {
    const [existing] = await this.#db
      .select({
        status: nativeSemanticReceipts.status,
        outcome: nativeSemanticReceipts.outcome,
      })
      .from(nativeSemanticReceipts)
      .where(eq(nativeSemanticReceipts.id, token))
      .limit(1);
    if (existing?.status === "completed" && existing.outcome) {
      const stored = existing.outcome as unknown as PaperclipSemanticStoredOutcome;
      if (JSON.stringify(stored) === JSON.stringify(outcome)) return;
      throw new Error("paperclip_runner_semantic_receipt_conflict");
    }
    await this.complete(token, outcome);
  }

  async release(token: string): Promise<void> {
    const released = await this.#db
      .delete(nativeSemanticReceipts)
      .where(
        and(
          eq(nativeSemanticReceipts.id, token),
          eq(nativeSemanticReceipts.companyId, this.#binding.companyId),
          eq(nativeSemanticReceipts.issueId, this.#binding.issueId),
          eq(nativeSemanticReceipts.runId, this.#binding.runId),
          eq(nativeSemanticReceipts.status, "claimed"),
        ),
      )
      .returning({ id: nativeSemanticReceipts.id });
    if (released.length !== 1) {
      throw new Error("paperclip_runner_semantic_receipt_release_failed");
    }
  }
}

function jsonValue(value: unknown): PaperclipJsonValue {
  return JSON.parse(JSON.stringify(value)) as PaperclipJsonValue;
}

function activeAgentStatus(status: string): "active" | "inactive" {
  return ["paused", "terminated", "pending_approval", "error"].includes(status)
    ? "inactive"
    : "active";
}

/**
 * Run-scoped semantic authority for the hidden native coordinator.
 * Catalog entries remain undiscoverable until this authority supplies a
 * run-scoped binding. Mutations additionally require a durable receipt store.
 */
export class PaperclipRunnerSemanticAuthority {
  readonly #db: Db;
  readonly #binding: PaperclipRunnerSemanticBinding;
  readonly #dispatcher: PaperclipSemanticDispatcher;

  constructor(db: Db, binding: PaperclipRunnerSemanticBinding) {
    this.#db = db;
    this.#binding = structuredClone(binding);
    this.#dispatcher = new PaperclipSemanticDispatcher({
      contextProvider: (runId) => this.#context(runId),
      bindings: [
        ...READ_OPERATION_IDS.map((operationId) => this.#readBinding(operationId)),
        ...WRITE_OPERATION_IDS.map((operationId) => this.#writeBinding(operationId)),
      ],
      idempotencyStore: new RunnerSemanticIdempotencyStore(db, binding),
    });
  }

  listAlwaysAvailableTools(): Promise<
    readonly PaperclipSemanticToolDefinition[]
  > {
    return this.#dispatcher.listAlwaysAvailableTools(this.#binding.runId);
  }

  dispatch(
    call: Omit<PaperclipSemanticToolCall, "runId">,
  ): Promise<PaperclipSemanticToolResult> {
    return this.#dispatcher.dispatch({ ...call, runId: this.#binding.runId });
  }

  authorizationRecords(): readonly PaperclipSemanticAuthorizationRecord[] {
    return this.#dispatcher.authorizationRecords();
  }

  #readBinding(
    operationId: (typeof READ_OPERATION_IDS)[number],
  ): PaperclipSemanticActionBinding {
    return {
      operationId,
      execute: async (invocation) => {
        const context = await this.#loadBoundContext();
        this.#assertActiveContext(context, true);
        const input = invocation.input;
        switch (operationId) {
          case "get_task_context":
            return {
              value: jsonValue({
                company: { id: this.#binding.companyId },
                actor: {
                  id: context.agent.id,
                  name: context.agent.name,
                  role: context.agent.role,
                  title: context.agent.title,
                  capabilities: context.agent.capabilities,
                },
                activeTask: {
                  id: context.issue.id,
                  identifier: context.issue.identifier,
                  title: context.issue.title,
                  description: context.issue.description,
                  status: context.issue.status,
                  statusVersion: context.issue.statusVersion,
                  priority: context.issue.priority,
                  workMode: context.issue.workMode,
                  parentId: context.issue.parentId,
                  projectId: context.issue.projectId,
                  goalId: context.issue.goalId,
                },
                run: {
                  id: context.run.id,
                  status: context.run.status,
                  invocationSource: context.run.invocationSource,
                },
              }),
              references: [{ kind: "task", id: context.issue.id }],
            };
          case "get_task_history": {
            const rows = await this.#db
              .select({
                id: issueComments.id,
                body: issueComments.body,
                authorAgentId: issueComments.authorAgentId,
                authorUserId: issueComments.authorUserId,
                createdAt: issueComments.createdAt,
              })
              .from(issueComments)
              .where(
                and(
                  eq(issueComments.companyId, this.#binding.companyId),
                  eq(issueComments.issueId, this.#binding.issueId),
                  isNull(issueComments.deletedAt),
                ),
              )
              .orderBy(desc(issueComments.createdAt))
              .limit(boundedLimit(input.limit));
            return {
              value: jsonValue({ comments: rows.reverse() }),
              references: [{ kind: "task", id: context.issue.id }],
            };
          }
          case "list_documents": {
            const rows = await this.#db
              .select({
                key: issueDocuments.key,
                id: documents.id,
                title: documents.title,
                format: documents.format,
                latestRevisionId: documents.latestRevisionId,
                latestRevisionNumber: documents.latestRevisionNumber,
                lockedAt: documents.lockedAt,
                updatedAt: documents.updatedAt,
              })
              .from(issueDocuments)
              .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
              .where(
                and(
                  eq(issueDocuments.companyId, this.#binding.companyId),
                  eq(issueDocuments.issueId, this.#binding.issueId),
                  eq(documents.companyId, this.#binding.companyId),
                ),
              );
            return {
              value: jsonValue({ documents: rows }),
              references: rows.map((row) => ({
                kind: "document_revision" as const,
                id: row.latestRevisionId ?? row.id,
              })),
            };
          }
          case "read_document": {
            const key = requiredString(input.key);
            const [row] = await this.#db
              .select({
                key: issueDocuments.key,
                id: documents.id,
                title: documents.title,
                format: documents.format,
                body: documents.latestBody,
                latestRevisionId: documents.latestRevisionId,
                latestRevisionNumber: documents.latestRevisionNumber,
                lockedAt: documents.lockedAt,
                updatedAt: documents.updatedAt,
              })
              .from(issueDocuments)
              .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
              .where(
                and(
                  eq(issueDocuments.companyId, this.#binding.companyId),
                  eq(issueDocuments.issueId, this.#binding.issueId),
                  eq(issueDocuments.key, key),
                  eq(documents.companyId, this.#binding.companyId),
                ),
              )
              .limit(1);
            if (!row) throw new Error("paperclip_runner_document_not_found");
            return {
              value: jsonValue({ document: row }),
              references: [
                {
                  kind: "document_revision",
                  id: row.latestRevisionId ?? row.id,
                },
              ],
            };
          }
          case "list_document_revisions": {
            const key = requiredString(input.key);
            const rows = await this.#db
              .select({
                id: documentRevisions.id,
                revisionNumber: documentRevisions.revisionNumber,
                title: documentRevisions.title,
                format: documentRevisions.format,
                body: documentRevisions.body,
                changeSummary: documentRevisions.changeSummary,
                createdByAgentId: documentRevisions.createdByAgentId,
                createdByUserId: documentRevisions.createdByUserId,
                createdAt: documentRevisions.createdAt,
              })
              .from(issueDocuments)
              .innerJoin(
                documentRevisions,
                eq(documentRevisions.documentId, issueDocuments.documentId),
              )
              .where(
                and(
                  eq(issueDocuments.companyId, this.#binding.companyId),
                  eq(issueDocuments.issueId, this.#binding.issueId),
                  eq(issueDocuments.key, key),
                  eq(documentRevisions.companyId, this.#binding.companyId),
                ),
              )
              .orderBy(desc(documentRevisions.revisionNumber))
              .limit(boundedLimit(input.limit));
            return {
              value: jsonValue({ revisions: rows }),
              references: rows.map((row) => ({
                kind: "document_revision" as const,
                id: row.id,
              })),
            };
          }
        }
      },
    };
  }

  #writeBinding(
    operationId: (typeof WRITE_OPERATION_IDS)[number],
  ): PaperclipSemanticActionBinding {
    return {
      operationId,
      execute: async (invocation) => {
        const context = await this.#loadBoundContext();
        this.#assertActiveContext(context, true);
        const idempotencyKey = requiredString(invocation.input.idempotencyKey);
        const body = requiredBody(invocation.input.body);
        const scope = semanticScope({
          companyId: this.#binding.companyId,
          runId: this.#binding.runId,
          operationId,
          idempotencyKey,
        });
        const commentId = claimToken(scope);
        await this.#db
          .insert(issueComments)
          .values({
            id: commentId,
            companyId: this.#binding.companyId,
            issueId: this.#binding.issueId,
            authorAgentId: this.#binding.agentId,
            authorType: "agent",
            createdByRunId: this.#binding.runId,
            body,
          })
          .onConflictDoNothing();
        const [comment] = await this.#db
          .select({
            id: issueComments.id,
            body: issueComments.body,
            authorAgentId: issueComments.authorAgentId,
            createdByRunId: issueComments.createdByRunId,
          })
          .from(issueComments)
          .where(eq(issueComments.id, commentId))
          .limit(1);
        if (
          !comment ||
          comment.body !== body ||
          comment.authorAgentId !== this.#binding.agentId ||
          comment.createdByRunId !== this.#binding.runId
        ) {
          throw new Error("paperclip_runner_semantic_effect_conflict");
        }
        return {
          value: jsonValue({
            commandId: `runner-semantic:${commentId}`,
            disposition: "applied",
            stateRevision: context.issue.statusVersion,
            entityRefs: [commentId],
            scheduledWakeIds: [],
          }),
          stateRevision: context.issue.statusVersion,
          references: [{ kind: "task", id: context.issue.id }],
        };
      },
    };
  }

  async #context(requestedRunId: string): Promise<PaperclipSemanticRunContext> {
    if (requestedRunId !== this.#binding.runId) {
      throw new Error("paperclip_runner_semantic_run_mismatch");
    }
    const context = await this.#loadBoundContext();
    this.#assertActiveContext(context, false);
    return {
      runId: context.run.id,
      companyId: context.run.companyId,
      actor: {
        id: context.agent.id,
        companyId: context.agent.companyId,
        status: activeAgentStatus(context.agent.status),
        role: context.agent.role,
        claims: [],
      },
      activeTask: {
        id: context.issue.id,
        companyId: context.issue.companyId,
        assigneeActorId: context.issue.assigneeAgentId,
        executionRunId: context.issue.executionRunId,
        status: context.issue.status,
        workMode: context.issue
          .workMode as PaperclipSemanticRunContext["activeTask"]["workMode"],
      },
      delegatedClaims: [],
    };
  }

  async #loadBoundContext(): Promise<BoundContext> {
    const [row] = await this.#db
      .select({ run: heartbeatRuns, issue: issues, agent: agents })
      .from(heartbeatRuns)
      .innerJoin(
        issues,
        and(
          eq(issues.id, heartbeatRuns.nativeIssueId),
          eq(issues.companyId, heartbeatRuns.companyId),
        ),
      )
      .innerJoin(
        agents,
        and(
          eq(agents.id, heartbeatRuns.agentId),
          eq(agents.companyId, heartbeatRuns.companyId),
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.id, this.#binding.runId),
          eq(heartbeatRuns.companyId, this.#binding.companyId),
          eq(heartbeatRuns.agentId, this.#binding.agentId),
          eq(heartbeatRuns.nativeIssueId, this.#binding.issueId),
          eq(heartbeatRuns.runtimeMode, "native"),
        ),
      )
      .limit(1);
    if (!row) throw new Error("paperclip_runner_semantic_binding_not_found");
    return row;
  }

  #assertActiveContext(context: BoundContext, requireOwnership: boolean): void {
    if (
      !["queued", "running"].includes(context.run.status) ||
      activeAgentStatus(context.agent.status) !== "active" ||
      (requireOwnership &&
        (context.issue.assigneeAgentId !== this.#binding.agentId ||
          context.issue.executionRunId !== this.#binding.runId))
    ) {
      throw new Error("paperclip_runner_semantic_binding_inactive");
    }
  }
}
