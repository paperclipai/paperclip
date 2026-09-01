import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  documentRevisions,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueDocuments,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../../vendor/paperclip-runner/index.js";
import { agentService } from "../agents.js";
import { approvalService } from "../approvals.js";
import { documentService } from "../documents.js";
import { issueService } from "../issues.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { persistActivity, publishActivity } from "../activity-log.js";

const IMPLEMENTED_OPERATIONS = new Set([
  "get_task_context", "get_task_history", "search_tasks", "report_progress",
  "request_human_input",
  "create_task", "set_dependencies",
  "list_documents", "read_document", "list_document_revisions", "write_document",
  "list_agents", "get_agent", "list_approvals", "get_approval", "get_approval_context",
]);

type Binding = {
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  normalizedSessionId?: string;
  workMode?: "standard" | "planning" | "ask";
  enqueueWakeup?: (agentId: string, options: {
    source: "assignment";
    triggerDetail: "system";
    reason: "issue_assigned";
    payload: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType: "agent";
    requestedByActorId: string;
    contextSnapshot: Record<string, unknown>;
  }) => Promise<unknown>;
};

type ToolReceipt = {
  operationId: string;
  input: unknown;
  result: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class PaperclipRunnerToolAuthority {
  constructor(readonly db: Db, readonly binding: Binding) {}

  definitions(): Array<Record<string, unknown>> {
    const workMode = this.binding.workMode ?? "standard";
    return CAPABILITY_SEMANTIC_TOOL_CATALOG
      .filter((descriptor) =>
        IMPLEMENTED_OPERATIONS.has(descriptor.operationId)
        && descriptor.allowedModes.includes(workMode)
      )
      .map((descriptor) => ({
        name: descriptor.operationId,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
      }));
  }

  async execute(call: { tool: string; callId: string; arguments: unknown }): Promise<unknown> {
    if (!IMPLEMENTED_OPERATIONS.has(call.tool)) throw new Error("paperclip_runner_tool_not_advertised");
    const context = await this.#boundContext();
    const descriptor = CAPABILITY_SEMANTIC_TOOL_CATALOG.find((candidate) => candidate.operationId === call.tool);
    if (!descriptor || !descriptor.allowedModes.includes(
      context.issue.workMode as "standard" | "planning" | "ask",
    )) {
      throw new Error("paperclip_runner_tool_mode_denied");
    }
    const input = record(call.arguments);
    switch (call.tool) {
      case "get_task_context": return {
        company: { id: this.binding.companyId },
        actor: redactedActor(context.actor),
        activeTask: redactedTask(context.issue),
        run: {
          id: this.binding.runId,
          status: context.run.status,
          invocationSource: context.run.invocationSource,
        },
        acceptedPlan: await this.#acceptedPlan(context.run.contextSnapshot),
      };
      case "get_task_history": {
        const limit = boundedLimit(input.limit);
        const comments = await this.db.select({
          id: issueComments.id,
          body: issueComments.body,
          authorAgentId: issueComments.authorAgentId,
          authorUserId: issueComments.authorUserId,
          createdAt: issueComments.createdAt,
        }).from(issueComments)
          .where(and(
            eq(issueComments.companyId, this.binding.companyId),
            eq(issueComments.issueId, this.binding.issueId),
            isNull(issueComments.deletedAt),
          ))
          .orderBy(desc(issueComments.createdAt))
          .limit(limit);
        return { comments: comments.reverse() };
      }
      case "search_tasks": {
        const tasks = await issueService(this.db).list(this.binding.companyId);
        const query = typeof input.query === "string" ? input.query.toLowerCase() : "";
        const statuses = Array.isArray(input.statuses) ? new Set(input.statuses.filter((value): value is string => typeof value === "string")) : null;
        return { tasks: tasks.filter((task) =>
          (!query || `${task.identifier} ${task.title} ${task.description ?? ""}`.toLowerCase().includes(query))
          && (!statuses || statuses.size === 0 || statuses.has(task.status))
        ).slice(0, boundedLimit(input.limit)).map(redactedTask) };
      }
      case "list_documents":
        return { documents: await documentService(this.db).listIssueDocuments(this.binding.issueId) };
      case "read_document": {
        const document = await documentService(this.db).getIssueDocumentByKey(this.binding.issueId, requiredString(input.key));
        if (!document) throw new Error("paperclip_runner_document_not_found");
        return { document };
      }
      case "list_document_revisions":
        return { revisions: await documentService(this.db).listIssueDocumentRevisions(this.binding.issueId, requiredString(input.key)) };
      case "write_document": return this.#writeDocument(input);
      case "list_agents":
        return { actors: (await agentService(this.db).list(this.binding.companyId)).map(redactedActor) };
      case "get_agent": {
        const actor = await agentService(this.db).getById(requiredString(input.actorId));
        if (!actor || actor.companyId !== this.binding.companyId) throw new Error("paperclip_runner_agent_not_found");
        return { actor: redactedActor(actor) };
      }
      case "list_approvals":
        return { approvals: await approvalService(this.db).list(this.binding.companyId) };
      case "get_approval": {
        const approval = await this.#approval(requiredString(input.approvalId));
        return { approval };
      }
      case "get_approval_context": {
        const approval = await this.#approval(requiredString(input.approvalId));
        const tasks = await this.db.select({ issue: issues }).from(issueApprovals)
          .innerJoin(issues, eq(issues.id, issueApprovals.issueId))
          .where(and(
            eq(issueApprovals.approvalId, approval.id),
            eq(issueApprovals.companyId, this.binding.companyId),
            eq(issues.companyId, this.binding.companyId),
          ));
        return { approval, tasks: tasks.map((row) => row.issue) };
      }
      case "report_progress": return this.#reportProgress(input);
      case "request_human_input": return this.#requestHumanInput(input);
      case "create_task": return this.#createTask(input);
      case "set_dependencies": return this.#setDependencies(input);
      default: throw new Error("paperclip_runner_tool_not_bound");
    }
  }

  async #approval(id: string) {
    const approval = await approvalService(this.db).getById(id);
    if (!approval || approval.companyId !== this.binding.companyId) throw new Error("paperclip_runner_approval_not_found");
    return approval;
  }

  async #boundContext() {
    const [row] = await this.db.select({ issue: issues, actor: agents, run: heartbeatRuns })
      .from(heartbeatRuns)
      .innerJoin(issues, eq(issues.id, this.binding.issueId))
      .innerJoin(agents, eq(agents.id, this.binding.agentId))
      .where(and(
        eq(heartbeatRuns.id, this.binding.runId),
        eq(heartbeatRuns.companyId, this.binding.companyId),
        eq(heartbeatRuns.agentId, this.binding.agentId),
        eq(heartbeatRuns.nativeIssueId, this.binding.issueId),
        eq(issues.companyId, this.binding.companyId),
        eq(issues.assigneeAgentId, this.binding.agentId),
        eq(issues.executionRunId, this.binding.runId),
        eq(agents.companyId, this.binding.companyId),
      ))
      .limit(1);
    if (
      !row
      || row.run.runtimeMode !== "native"
      || row.run.status !== "running"
      || ["paused", "terminated", "pending_approval", "error"].includes(row.actor.status)
    ) {
      throw new Error("paperclip_runner_tool_binding_not_authorized");
    }
    return row;
  }

  async #reportProgress(input: Record<string, unknown>): Promise<unknown> {
    const body = typeof input.body === "string" ? input.body.trim() : "";
    const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
    if (!body || !idempotencyKey) throw new Error("paperclip_runner_tool_input_invalid");
    let publication: Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    const result = await this.#withMutationReceipt(
      "report_progress",
      idempotencyKey,
      input,
      async (tx, context) => {
        const comment = await issueService(tx).addComment(
          this.binding.issueId,
          body,
          { agentId: this.binding.agentId, runId: this.binding.runId },
          { authorizationReason: "paperclip_runner_protocol" },
          tx,
        );
        const result = { commentId: comment.id, issueId: this.binding.issueId, disposition: "applied" };
        const activity = await persistActivity(tx, {
          companyId: this.binding.companyId,
          actorType: "agent",
          actorId: this.binding.agentId,
          agentId: this.binding.agentId,
          runId: this.binding.runId,
          issueId: this.binding.issueId,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: this.binding.issueId,
          details: {
            commentId: comment.id,
            bodySnippet: comment.body.slice(0, 120),
            identifier: context.issue.identifier,
            issueTitle: context.issue.title,
            authorizationReason: "paperclip_runner_protocol",
            source: "paperclip_runner_protocol",
          },
        });
        publication = activity.publication;
        return result;
      },
    );
    if (publication) publishActivity(publication);
    return result;
  }

  async #writeDocument(input: Record<string, unknown>): Promise<unknown> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    let publication: Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    const result = await this.#withMutationReceipt("write_document", idempotencyKey, input, async (tx) => {
      const write = await documentService(tx).upsertIssueDocument({
        issueId: this.binding.issueId,
        key: requiredString(input.key),
        title: requiredString(input.title),
        format: "markdown",
        body: requiredString(input.body),
        baseRevisionId: nullableProviderId(input.baseRevisionId),
        changeSummary: input.changeSummary === null || input.changeSummary === undefined
          ? null
          : requiredString(input.changeSummary),
        createdByAgentId: this.binding.agentId,
        createdByRunId: this.binding.runId,
      });
      const activity = await persistActivity(tx, {
        companyId: this.binding.companyId,
        actorType: "agent",
        actorId: this.binding.agentId,
        agentId: this.binding.agentId,
        runId: this.binding.runId,
        issueId: this.binding.issueId,
        action: write.created ? "issue.document_created" : "issue.document_updated",
        entityType: "issue",
        entityId: this.binding.issueId,
        details: {
          key: write.document.key,
          documentId: write.document.id,
          title: write.document.title,
          format: write.document.format,
          revisionNumber: write.document.latestRevisionNumber,
          source: "paperclip_runner_protocol",
        },
      });
      publication = activity.publication;
      return {
        disposition: "applied",
        created: write.created,
        document: write.document,
      };
    });
    if (publication) publishActivity(publication);
    return result;
  }

  async #createTask(input: Record<string, unknown>): Promise<unknown> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    const assigneeAgentId = input.assigneeActorId === null || input.assigneeActorId === undefined
      ? this.binding.agentId
      : requiredString(input.assigneeActorId);
    const assignee = await agentService(this.db).getById(assigneeAgentId);
    if (!assignee || assignee.companyId !== this.binding.companyId) {
      throw new Error("paperclip_runner_agent_not_found");
    }
    const priority = input.priority === "critical" || input.priority === "high"
      || input.priority === "medium" || input.priority === "low"
      ? input.priority
      : "medium";
    const blockedByIssueIds = Array.isArray(input.blockedByTaskIds)
      ? input.blockedByTaskIds.map(requiredString)
      : [];
    const durableIdempotencyKey =
      `paperclip-runner:create-task:${this.binding.issueId}:${idempotencyKey}`;
    const inputFingerprint = createHash("sha256")
      .update(canonicalJson(input))
      .digest("hex");
    const result = await this.#withMutationReceipt("create_task", idempotencyKey, input, async (tx) => {
      const existingChild = await tx.select().from(issues).where(and(
        eq(issues.companyId, this.binding.companyId),
        eq(issues.parentId, this.binding.issueId),
        eq(issues.originId, durableIdempotencyKey),
      )).limit(1).then((rows) => rows[0] ?? null);
      if (existingChild) {
        if (existingChild.originFingerprint !== inputFingerprint) {
          throw new Error("paperclip_runner_tool_idempotency_conflict");
        }
        return {
          commandId: `create-task:${existingChild.id}`,
          disposition: "duplicate",
          stateRevision: existingChild.statusVersion,
          entityRefs: [existingChild.id],
          scheduledWakeIds: [],
          task: {
            id: existingChild.id,
            identifier: existingChild.identifier,
            parentId: existingChild.parentId,
            status: existingChild.status,
            assigneeActorId: existingChild.assigneeAgentId,
          },
        };
      }
      let deduplicated = false;
      const created = await issueService(tx).createChild(this.binding.issueId, {
        title: requiredString(input.title),
        description: input.description === null || input.description === undefined
          ? null
          : requiredString(input.description),
        status: blockedByIssueIds.length > 0 ? "blocked" : "todo",
        workMode: "standard",
        priority,
        assigneeAgentId,
        blockedByIssueIds,
        blockParentUntilDone: false,
        createdByAgentId: this.binding.agentId,
        originKind: "manual",
        originId: durableIdempotencyKey,
        originFingerprint: inputFingerprint,
        actorAgentId: this.binding.agentId,
        actorRunId: this.binding.runId,
        idempotencyKey: durableIdempotencyKey,
        onDeduplicated: () => { deduplicated = true; },
      });
      const child = created.issue;
      if (deduplicated && child.originFingerprint !== inputFingerprint) {
        throw new Error("paperclip_runner_tool_idempotency_conflict");
      }
      let childStatus = child.status;
      let childStatusVersion = child.statusVersion;
      if (child.status === "blocked" && blockedByIssueIds.length > 0) {
        const readiness = await issueService(tx).getDependencyReadiness(child.id, tx);
        if (readiness.isDependencyReady) {
          const readyChild = await issueService(tx).update(child.id, {
            status: "todo",
            actorAgentId: this.binding.agentId,
          }, tx);
          if (readyChild) {
            childStatus = readyChild.status;
            childStatusVersion = readyChild.statusVersion;
          }
        }
      }
      const wakeId = `created-child:${child.id}`;
      const shouldWake = !deduplicated && childStatus === "todo" && Boolean(child.assigneeAgentId);
      return {
        commandId: `create-task:${child.id}`,
        disposition: deduplicated ? "duplicate" : "applied",
        stateRevision: childStatusVersion,
        entityRefs: [child.id],
        scheduledWakeIds: shouldWake ? [wakeId] : [],
        task: {
          id: child.id,
          identifier: child.identifier,
          parentId: child.parentId,
          status: childStatus,
          assigneeActorId: child.assigneeAgentId,
        },
      };
    }) as Record<string, unknown>;

    const task = record(result.task);
    const childId = requiredString(task.id);
    const scheduledWakeIds = Array.isArray(result.scheduledWakeIds)
      ? result.scheduledWakeIds.filter((value): value is string => typeof value === "string")
      : [];
    const assignedAgentId = typeof task.assigneeActorId === "string"
      ? task.assigneeActorId
      : null;
    if (this.binding.enqueueWakeup && assignedAgentId && scheduledWakeIds.length > 0) {
      await this.binding.enqueueWakeup(assignedAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: {
          issueId: childId,
          mutation: "create_child",
          parentIssueId: this.binding.issueId,
        },
        idempotencyKey: scheduledWakeIds[0]!,
        requestedByActorType: "agent",
        requestedByActorId: this.binding.agentId,
        contextSnapshot: {
          issueId: childId,
          source: "paperclip_runner.create_task",
          parentIssueId: this.binding.issueId,
        },
      });
    }
    return result;
  }

  async #setDependencies(input: Record<string, unknown>): Promise<unknown> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    if (!Array.isArray(input.blockedByTaskIds)) {
      throw new Error("paperclip_runner_tool_input_invalid");
    }
    const blockedByIssueIds = input.blockedByTaskIds.map(requiredString);
    return this.#withMutationReceipt("set_dependencies", idempotencyKey, input, async (tx) => {
      const updated = await issueService(tx).update(this.binding.issueId, {
        blockedByIssueIds,
        actorAgentId: this.binding.agentId,
      }, tx);
      if (!updated) throw new Error("paperclip_runner_task_not_found");
      return {
        commandId: `set-dependencies:${updated.id}:${updated.statusVersion}`,
        disposition: "applied",
        stateRevision: updated.statusVersion,
        entityRefs: [updated.id, ...blockedByIssueIds],
        scheduledWakeIds: [],
      };
    });
  }

  async #acceptedPlan(contextSnapshot: unknown): Promise<{
    documentId: string;
    revisionId: string;
    revisionNumber: number;
    markdown: string;
  } | null> {
    const acceptedTarget = record(
      record(record(contextSnapshot).planReviewInteraction).acceptedTargetRevision,
    );
    let revisionId = typeof acceptedTarget.revisionId === "string"
      ? acceptedTarget.revisionId
      : null;
    if (!revisionId) revisionId = await this.#latestAcceptedPlanRevisionId();
    if (!revisionId) return null;

    const [revision] = await this.db.select({
      documentId: documentRevisions.documentId,
      revisionId: documentRevisions.id,
      revisionNumber: documentRevisions.revisionNumber,
      markdown: documentRevisions.body,
    })
      .from(documentRevisions)
      .innerJoin(issueDocuments, and(
        eq(issueDocuments.documentId, documentRevisions.documentId),
        eq(issueDocuments.companyId, this.binding.companyId),
        eq(issueDocuments.issueId, this.binding.issueId),
        eq(issueDocuments.key, "plan"),
      ))
      .where(and(
        eq(documentRevisions.id, revisionId),
        eq(documentRevisions.companyId, this.binding.companyId),
      ))
      .limit(1);
    return revision ?? null;
  }

  async #latestAcceptedPlanRevisionId(): Promise<string | null> {
    const rows = await this.db.select({ payload: issueThreadInteractions.payload })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, this.binding.companyId),
        eq(issueThreadInteractions.issueId, this.binding.issueId),
        eq(issueThreadInteractions.kind, "request_confirmation"),
        eq(issueThreadInteractions.status, "accepted"),
      ))
      .orderBy(desc(issueThreadInteractions.resolvedAt), desc(issueThreadInteractions.createdAt));
    for (const row of rows) {
      const target = record(record(row.payload).target);
      if (
        target.type === "issue_document"
        && (target.issueId === undefined || target.issueId === this.binding.issueId)
        && target.key === "plan"
        && typeof target.revisionId === "string"
        && target.revisionId.length > 0
      ) return target.revisionId;
    }
    return null;
  }

  async #withMutationReceipt(
    operationId: string,
    idempotencyKey: string,
    input: Record<string, unknown>,
    effect: (tx: Db, context: {
      run: typeof heartbeatRuns.$inferSelect;
      issue: typeof issues.$inferSelect;
      actor: typeof agents.$inferSelect;
    }) => Promise<unknown>,
  ): Promise<unknown> {
    return this.db.transaction(async (tx) => {
      const context = await this.#lockAuthorizedMutationContext(tx as unknown as Db);
      const resultJson = record(context.run.resultJson);
      const receipts = record(resultJson.semanticToolReceipts);
      const prior = receipts[idempotencyKey] as ToolReceipt | undefined;
      if (prior !== undefined) {
        if (prior.operationId !== operationId || canonicalJson(prior.input) !== canonicalJson(input)) {
          throw new Error("paperclip_runner_tool_idempotency_conflict");
        }
        return prior.result;
      }
      const result = JSON.parse(JSON.stringify(
        await effect(tx as unknown as Db, context),
      )) as unknown;
      receipts[idempotencyKey] = { operationId, input, result } satisfies ToolReceipt;
      await tx.update(heartbeatRuns).set({
        resultJson: { ...resultJson, semanticToolReceipts: receipts },
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, this.binding.runId));
      return result;
    });
  }

  async #lockAuthorizedMutationContext(tx: Db): Promise<{
    run: typeof heartbeatRuns.$inferSelect;
    issue: typeof issues.$inferSelect;
    actor: typeof agents.$inferSelect;
  }> {
    // Authorization for writes is intentionally re-read only after the
    // transaction starts. Locking the run and issue in the same statement
    // closes the gap between the discovery-time check and the mutation: a
    // reassignment, replacement run, or terminal transition must commit either
    // before this check (and be rejected) or after this transaction completes.
    const [context] = await tx
      .select({ run: heartbeatRuns, issue: issues, actor: agents })
      .from(heartbeatRuns)
      .innerJoin(issues, eq(issues.id, this.binding.issueId))
      .innerJoin(agents, eq(agents.id, this.binding.agentId))
      .where(and(
        eq(heartbeatRuns.id, this.binding.runId),
        eq(heartbeatRuns.companyId, this.binding.companyId),
        eq(heartbeatRuns.agentId, this.binding.agentId),
        eq(heartbeatRuns.nativeIssueId, this.binding.issueId),
        eq(issues.companyId, this.binding.companyId),
        eq(issues.assigneeAgentId, this.binding.agentId),
        eq(issues.executionRunId, this.binding.runId),
        eq(agents.companyId, this.binding.companyId),
      ))
      .for("update")
      .limit(1);
    if (
      !context
      || context.run.runtimeMode !== "native"
      || context.run.status !== "running"
      || context.run.companyId !== this.binding.companyId
      || context.run.agentId !== this.binding.agentId
      || context.run.nativeIssueId !== this.binding.issueId
      || context.issue.companyId !== this.binding.companyId
      || context.issue.assigneeAgentId !== this.binding.agentId
      || context.issue.executionRunId !== this.binding.runId
      || context.actor.companyId !== this.binding.companyId
      || ["paused", "terminated", "pending_approval", "error"].includes(context.actor.status)
    ) {
      throw new Error("paperclip_runner_tool_binding_not_authorized");
    }
    return context;
  }

  async #requestHumanInput(input: Record<string, unknown>): Promise<unknown> {
    const interactionKind = requiredString(input.interactionKind);
    const interactionKinds = {
      confirmation: "request_confirmation",
      checkbox: "request_checkbox_confirmation",
      questions: "ask_user_questions",
      suggest_tasks: "suggest_tasks",
      item_verdicts: "request_item_verdicts",
    } as const;
    const kind = interactionKinds[
      interactionKind as keyof typeof interactionKinds
    ];
    if (!kind) throw new Error("paperclip_runner_interaction_kind_invalid");
    const prompt = requiredString(input.prompt);
    const idempotencyKey = requiredString(input.idempotencyKey);
    let publication: Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    const result = await this.#withMutationReceipt(
      "request_human_input",
      idempotencyKey,
      input,
      async (tx, context) => {
        const suppliedPayload = record(input.payload);
        const targetRevisionId = nullableProviderId(input.targetRevisionId);
        const suppliedTarget = record(suppliedPayload.target);
        const inferredPlanningTarget = targetRevisionId !== null
          && suppliedPayload.target === undefined
          && kind === "request_confirmation"
          && context.issue.workMode === "planning"
          ? {
              type: "issue_document",
              issueId: context.issue.id,
              key: "plan",
              revisionId: targetRevisionId,
            }
          : null;
        if (targetRevisionId !== null && suppliedPayload.target === undefined && inferredPlanningTarget === null) {
          throw new Error("paperclip_runner_interaction_target_incomplete");
        }
        const normalizedPayload = inferredPlanningTarget !== null
          ? { ...suppliedPayload, target: inferredPlanningTarget }
          : suppliedTarget.type === "issue_document"
          ? {
              ...suppliedPayload,
              target: {
                ...suppliedTarget,
                issueId: suppliedTarget.issueId ?? context.issue.id,
                revisionId: suppliedTarget.revisionId ?? targetRevisionId,
              },
            }
          : suppliedPayload;
        const interaction = await issueThreadInteractionService(tx).create(context.issue, {
          kind,
          idempotencyKey,
          sourceRunId: this.binding.runId,
          title: requiredString(input.title),
          summary: prompt,
          continuationPolicy: requiredString(input.continuationPolicy),
          payload: {
            ...normalizedPayload,
            version: 1,
            prompt,
            ...(kind === "request_confirmation" ? {
              detailsMarkdown: normalizedPayload.detailsMarkdown ?? "",
              acceptLabel: normalizedPayload.acceptLabel ?? "Confirm",
              rejectLabel: normalizedPayload.rejectLabel ?? "Request changes",
              rejectRequiresReason: normalizedPayload.rejectRequiresReason ?? false,
              supersedeOnUserComment: normalizedPayload.supersedeOnUserComment ?? true,
            } : {}),
          },
        } as never, { agentId: this.binding.agentId, userId: null });
        const activity = await persistActivity(tx, {
          companyId: this.binding.companyId,
          actorType: "agent",
          actorId: this.binding.agentId,
          agentId: this.binding.agentId,
          runId: this.binding.runId,
          issueId: this.binding.issueId,
          action: "issue.thread_interaction_created",
          entityType: "issue",
          entityId: this.binding.issueId,
          details: {
            interactionId: interaction.id,
            interactionKind: interaction.kind,
            interactionStatus: interaction.status,
            continuationPolicy: interaction.continuationPolicy,
            source: "paperclip_runner_protocol",
          },
        });
        publication = activity.publication;
        return { interaction, disposition: "applied" };
      },
    );
    if (publication) publishActivity(publication);
    return result;
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("paperclip_runner_tool_input_invalid");
  return value.trim();
}

/**
 * Some native tool transports cannot faithfully express a nullable string in
 * their provider-facing schema and send the JSON null sentinel as a string.
 * Normalize only the well-known empty/null sentinels at the control-plane
 * boundary; real revision ids remain untouched and optimistic concurrency is
 * still enforced by the document service.
 */
function nullableProviderId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = requiredString(value);
  return normalized === "null" || normalized === "undefined" ? null : normalized;
}

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(1, Math.min(value, 100))
    : 50;
}

function redactedActor(actor: {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title?: string | null;
  status: string;
  reportsTo?: string | null;
  capabilities?: string | null;
}) {
  return {
    id: actor.id,
    companyId: actor.companyId,
    name: actor.name,
    role: actor.role,
    title: actor.title ?? null,
    status: actor.status,
    reportsTo: actor.reportsTo ?? null,
    capabilities: actor.capabilities ?? null,
  };
}

function redactedTask(task: typeof issues.$inferSelect) {
  return {
    id: task.id,
    companyId: task.companyId,
    identifier: task.identifier,
    title: task.title,
    description: task.description,
    status: task.status,
    statusVersion: task.statusVersion,
    priority: task.priority,
    workMode: task.workMode,
    assigneeAgentId: task.assigneeAgentId,
    executionRunId: task.executionRunId,
    parentId: task.parentId,
    projectId: task.projectId,
    goalId: task.goalId,
  };
}
