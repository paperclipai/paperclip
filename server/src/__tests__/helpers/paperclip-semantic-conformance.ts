import express, { type Application } from "express";
import request from "supertest";
import { and, asc, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  CapabilitySemanticDispatcher,
  createCapabilityFixtureState,
  normalizeCapabilitySemanticObservation,
  type CapabilityCommandEnvelope,
  type CapabilityCommandOutcome,
  type CapabilityCommandResult,
  type CapabilityFixtureState,
  type CapabilityRunContext,
  type CapabilitySemanticCommand,
  type SemanticConformanceAdapter,
  type SemanticConformanceObservation,
  type SemanticConformanceVector,
} from "../../vendor/paperclip-runner/testing.js";

import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";

type Db = ReturnType<typeof createDb>;

export interface PaperclipSemanticConformanceIds {
  readonly companyId: string;
  readonly actorId: string;
  readonly foreignCompanyId: string;
  readonly foreignTaskId: string;
  readonly blockerTaskId: string;
  readonly worlds: Readonly<Record<string, { taskId: string; runId: string; capabilities: readonly string[] }>>;
}

interface IdempotencyRecord {
  readonly canonicalCommand: string;
  readonly result: CapabilityCommandResult;
}

interface ProductionWorld {
  readonly port: PaperclipRouteSemanticPort;
  readonly dispatcher: CapabilitySemanticDispatcher;
  readonly taskId: string;
  readonly runId: string;
}

/**
 * Controlled production binding for the shared kit. It delegates writes to
 * issueRoutes, so authorization, service transactions, audit logging, document
 * revisions, interactions, and terminal arbitration remain production-owned.
 */
export class PaperclipProductionSemanticConformanceAdapter implements SemanticConformanceAdapter {
  readonly id = "paperclip-production-services";
  readonly kind = "production_binding" as const;

  private constructor(readonly worlds: ReadonlyMap<string, ProductionWorld>) {}

  static async create(db: Db, ids: PaperclipSemanticConformanceIds): Promise<PaperclipProductionSemanticConformanceAdapter> {
    const app = createProductionAuthorityApp(db, ids);
    const worlds = new Map<string, ProductionWorld>();
    for (const [id, binding] of Object.entries(ids.worlds)) {
      const port = new PaperclipRouteSemanticPort(db, app, ids, binding);
      await port.refresh();
      worlds.set(id, {
        port,
        dispatcher: new CapabilitySemanticDispatcher(port),
        taskId: binding.taskId,
        runId: binding.runId,
      });
    }
    return new PaperclipProductionSemanticConformanceAdapter(worlds);
  }

  async execute(vector: SemanticConformanceVector): Promise<SemanticConformanceObservation> {
    const worldId = vector.worldId ?? "default";
    const world = this.worlds.get(worldId);
    if (world === undefined) throw new Error(`semantic_conformance_world_missing:${worldId}`);
    const before = world.port.snapshot();
    const result = await world.dispatcher.dispatch({
      runId: world.runId,
      callId: vector.id,
      operationId: vector.operationId,
      input: vector.input,
    });
    const after = world.port.snapshot();
    return normalizeCapabilitySemanticObservation({
      result,
      before,
      after,
      taskId: world.taskId,
      semanticInput: vector.input,
    });
  }
}

export async function seedPaperclipSemanticConformance(
  db: Db,
  ids: PaperclipSemanticConformanceIds,
): Promise<void> {
  await db.insert(companies).values([
    { id: ids.companyId, name: "Semantic Conformance", issuePrefix: "SCF" },
    { id: ids.foreignCompanyId, name: "Foreign Conformance", issuePrefix: "FRN" },
  ]);
  await db.insert(agents).values({
    id: ids.actorId,
    companyId: ids.companyId,
    name: "Conformance Approver",
    role: "approver",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  let sequence = 0;
  for (const [worldId, world] of Object.entries(ids.worlds)) {
    sequence += 1;
    await db.insert(issues).values({
      id: world.taskId,
      companyId: ids.companyId,
      identifier: `SCF-${sequence}`,
      title: `${worldId} semantic conformance`,
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: ids.actorId,
    });
    await db.insert(heartbeatRuns).values({
      id: world.runId,
      companyId: ids.companyId,
      agentId: ids.actorId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId: world.taskId, capabilities: world.capabilities },
    });
    await db.update(issues).set({
      checkoutRunId: world.runId,
      executionRunId: world.runId,
    }).where(eq(issues.id, world.taskId));
  }
  await db.insert(issues).values({
    id: ids.blockerTaskId,
    companyId: ids.companyId,
    identifier: "SCF-90",
    title: "Unresolved semantic blocker",
    status: "todo",
    workMode: "standard",
    priority: "medium",
  });
  const blockedTerminal = ids.worlds["terminal-blocked"];
  if (blockedTerminal === undefined) throw new Error("semantic_conformance_blocked_terminal_world_missing");
  await db.insert(issueRelations).values({
    companyId: ids.companyId,
    issueId: ids.blockerTaskId,
    relatedIssueId: blockedTerminal.taskId,
    type: "blocks",
  });
  await db.insert(issues).values({
    id: ids.foreignTaskId,
    companyId: ids.foreignCompanyId,
    identifier: "FRN-1",
    title: "Foreign semantic task",
    status: "todo",
    workMode: "standard",
    priority: "medium",
  });
}

class PaperclipRouteSemanticPort {
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  #state: CapabilityFixtureState;

  constructor(
    readonly db: Db,
    readonly app: Application,
    readonly ids: PaperclipSemanticConformanceIds,
    readonly binding: { taskId: string; runId: string; capabilities: readonly string[] },
  ) {
    this.#state = createCapabilityFixtureState();
  }

  context(runId: string): CapabilityRunContext {
    if (runId !== this.binding.runId) throw new Error("semantic_conformance_run_binding_mismatch");
    const task = this.#state.tasks.find((candidate) => candidate.id === this.binding.taskId);
    if (task === undefined) throw new Error("semantic_conformance_task_missing");
    return {
      schema: "paperclip.capability.run-context.v1",
      company: {
        id: this.ids.companyId,
        name: "Semantic Conformance",
        issuePrefix: "SCF",
        status: "active",
      },
      actor: {
        id: this.ids.actorId,
        name: "Conformance Approver",
        role: "approver",
        status: "active",
        capabilityGrants: [...this.binding.capabilities],
      },
      activeTask: structuredClone(task),
      ancestors: [],
      wake: { reason: "manual", payload: {} },
      capabilities: [...this.binding.capabilities],
      budget: { limitCents: 10_000, spentCents: 0, remainingCents: 10_000 },
      interactionResults: [],
    };
  }

  snapshot(): Readonly<CapabilityFixtureState> {
    return structuredClone(this.#state);
  }

  async tryApplyCommand(envelope: CapabilityCommandEnvelope): Promise<CapabilityCommandOutcome> {
    const canonicalCommand = canonicalJson(envelope.command);
    const prior = this.#idempotency.get(envelope.idempotencyKey);
    if (prior !== undefined) {
      if (prior.canonicalCommand !== canonicalCommand) {
        return this.denial(envelope.command, "idempotency_conflict", "Idempotency key was reused with different input");
      }
      return {
        ok: true,
        result: { ...structuredClone(prior.result), disposition: "duplicate" },
      };
    }

    const outcome = await this.applyThroughProductionRoutes(envelope.command);
    await this.refresh();
    if (outcome.ok) {
      this.#idempotency.set(envelope.idempotencyKey, {
        canonicalCommand,
        result: structuredClone(outcome.result),
      });
    }
    return outcome;
  }

  async refresh(): Promise<void> {
    const [issue] = await this.db.select().from(issues).where(eq(issues.id, this.binding.taskId));
    if (issue === undefined) throw new Error("semantic_conformance_task_missing");
    const [run] = await this.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, this.binding.runId));
    if (run === undefined) throw new Error("semantic_conformance_run_missing");
    const comments = await this.db.select().from(issueComments)
      .where(eq(issueComments.issueId, issue.id))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    const linkedDocuments = await this.db.select({ link: issueDocuments, document: documents })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(eq(issueDocuments.issueId, issue.id));
    const revisions = linkedDocuments.length === 0
      ? []
      : await this.db.select().from(documentRevisions)
        .where(eq(documentRevisions.companyId, this.ids.companyId))
        .orderBy(asc(documentRevisions.revisionNumber));
    const interactions = await this.db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issue.id))
      .orderBy(asc(issueThreadInteractions.createdAt), asc(issueThreadInteractions.id));
    const relations = await this.db.select().from(issueRelations)
      .where(and(eq(issueRelations.relatedIssueId, issue.id), eq(issueRelations.type, "blocks")));
    const audit = await this.db.select().from(activityLog)
      .where(and(
        eq(activityLog.companyId, this.ids.companyId),
        eq(activityLog.runId, this.binding.runId),
      ))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));

    const state = createCapabilityFixtureState({
      company: { id: this.ids.companyId, name: "Semantic Conformance", issuePrefix: "SCF" },
      actors: [{
        id: this.ids.actorId,
        companyId: this.ids.companyId,
        name: "Conformance Approver",
        role: "approver",
        status: "active",
        budgetId: "production-binding-budget",
        capabilityGrants: [...this.binding.capabilities],
      }],
      tasks: [{
        id: issue.id,
        companyId: issue.companyId,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status as CapabilityFixtureState["tasks"][number]["status"],
        priority: issue.priority as CapabilityFixtureState["tasks"][number]["priority"],
        workMode: issue.workMode as CapabilityFixtureState["tasks"][number]["workMode"],
        parentId: issue.parentId,
        assigneeActorId: issue.assigneeAgentId,
        checkoutRunId: issue.checkoutRunId,
        executionRunId: issue.executionRunId,
        startedAt: issue.startedAt?.toISOString() ?? null,
        completedAt: issue.completedAt?.toISOString() ?? null,
      }],
      comments: comments.map((comment) => ({
        id: comment.id,
        taskId: comment.issueId,
        authorActorId: comment.authorAgentId,
        body: comment.body,
        createdAt: comment.createdAt.toISOString(),
      })),
      documents: linkedDocuments.map(({ link, document }) => ({
        id: document.id,
        taskId: link.issueId,
        key: link.key,
        title: document.title ?? "",
        format: "markdown" as const,
        latestRevisionId: document.latestRevisionId ?? "",
        revisions: revisions
          .filter((revision) => revision.documentId === document.id)
          .map((revision) => ({
            id: revision.id,
            documentId: revision.documentId,
            revision: revision.revisionNumber,
            body: revision.body,
            changeSummary: revision.changeSummary,
            createdAt: revision.createdAt.toISOString(),
          })),
      })),
      interactions: interactions.map((interaction) => ({
        id: interaction.id,
        taskId: interaction.issueId,
        kind: toFixtureInteractionKind(interaction.kind),
        status: interaction.status as CapabilityFixtureState["interactions"][number]["status"],
        title: interaction.title ?? "",
        prompt: readPrompt(interaction.payload),
        payload: interaction.payload,
        targetRevisionId: readTargetRevisionId(interaction.payload),
        continuationPolicy: interaction.continuationPolicy as CapabilityFixtureState["interactions"][number]["continuationPolicy"],
        result: interaction.result ?? null,
        createdAt: interaction.createdAt.toISOString(),
        resolvedAt: interaction.resolvedAt?.toISOString() ?? null,
      })),
      blockers: relations.map((relation) => ({
        id: relation.id,
        taskId: relation.relatedIssueId,
        blockedByTaskId: relation.issueId,
        createdAt: relation.createdAt.toISOString(),
      })),
    });
    state.lifecycle = "running";
    state.activeRunId = run.id;
    state.runs = [{
      id: run.id,
      companyId: run.companyId,
      actorId: run.agentId,
      taskId: issue.id,
      sessionId: run.sessionIdAfter ?? run.sessionIdBefore ?? run.externalRunId ?? run.id,
      backendKind: "runner",
      sourceInstanceId: "paperclip-production-services",
      status: toFixtureRunStatus(run.status),
      attempt: run.scheduledRetryAttempt + 1,
      openedAt: (run.startedAt ?? run.createdAt).toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      wake: { reason: "manual", payload: {} },
      capabilities: [...this.binding.capabilities],
      events: [],
      result: null,
      sessionCheckpoint: null,
    }];
    state.revision = this.#state.revision + 1;
    state.audit = audit.map((entry) => ({
      id: entry.id,
      at: entry.createdAt.toISOString(),
      runId: entry.runId,
      actorId: entry.agentId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      details: (entry.details ?? {}) as CapabilityFixtureState["audit"][number]["details"],
    }));
    this.#state = state;
  }

  private async applyThroughProductionRoutes(command: CapabilitySemanticCommand): Promise<CapabilityCommandOutcome> {
    const taskId = this.binding.taskId;
    switch (command.kind) {
      case "report_progress": {
        const response = await this.post(`/api/issues/${taskId}/comments`, { body: command.body });
        if (!isSuccess(response.status)) return this.routeDenial(command, response.status, response.body);
        return this.success(command, [`task:${taskId}`, `comment:${String(response.body.id)}`]);
      }
      case "write_document": {
        const response = await this.put(`/api/issues/${taskId}/documents/${encodeURIComponent(command.key)}`, {
          title: command.title,
          format: "markdown",
          body: command.body,
          changeSummary: command.changeSummary ?? null,
          baseRevisionId: command.baseRevisionId,
        });
        if (!isSuccess(response.status)) return this.routeDenial(command, response.status, response.body);
        return this.success(command, [
          `task:${taskId}`,
          `document:${String(response.body.id)}`,
          `revision:${String(response.body.latestRevisionId)}`,
        ]);
      }
      case "request_human_input": {
        if (command.interactionKind !== "confirmation") {
          return this.denial(command, "operation_unavailable", "Only confirmation is bound in this controlled adapter");
        }
        const response = await this.post(`/api/issues/${taskId}/interactions`, {
          kind: "request_confirmation",
          idempotencyKey: `semantic:${command.title}`,
          title: command.title,
          summary: command.prompt,
          continuationPolicy: command.continuationPolicy,
          payload: {
            version: 1,
            prompt: command.prompt,
            detailsMarkdown: "",
            acceptLabel: "Confirm",
            rejectLabel: "Request changes",
            rejectRequiresReason: false,
            supersedeOnUserComment: true,
          },
        });
        if (!isSuccess(response.status)) return this.routeDenial(command, response.status, response.body);
        const transition = await this.patch(`/api/issues/${taskId}`, { status: "in_review" });
        if (!isSuccess(transition.status)) return this.routeDenial(command, transition.status, transition.body);
        return this.success(command, [`task:${taskId}`, `interaction:${String(response.body.id)}`]);
      }
      case "set_dependencies": {
        const response = await this.patch(`/api/issues/${taskId}`, {
          blockedByIssueIds: command.blockedByTaskIds,
        });
        if (!isSuccess(response.status)) return this.routeDenial(command, response.status, response.body);
        return this.success(command, [
          `task:${taskId}`,
          ...command.blockedByTaskIds.map((id) => `blocker:${id}`),
        ]);
      }
      case "finish_task": {
        const response = await this.patch(`/api/issues/${taskId}`, {
          status: "done",
          comment: command.summary,
        });
        if (!isSuccess(response.status)) return this.routeDenial(command, response.status, response.body);
        return this.success(command, [`task:${taskId}`, `comment:${taskId}`]);
      }
      default:
        return this.denial(command, "operation_unavailable", "Operation is not bound in this controlled adapter");
    }
  }

  private success(command: CapabilitySemanticCommand, entityRefs: string[]): CapabilityCommandOutcome {
    return {
      ok: true,
      result: {
        commandId: `production:${this.binding.runId}:${this.#idempotency.size + 1}`,
        commandKind: command.kind,
        disposition: "applied",
        stateRevision: this.#state.revision + 1,
        entityRefs,
        scheduledWakeIds: [],
      },
    };
  }

  private routeDenial(command: CapabilitySemanticCommand, status: number, body: unknown): CapabilityCommandOutcome {
    const message = errorMessage(body);
    if (command.kind === "write_document" && status === 409) {
      return this.denial(command, "document_revision_conflict", message);
    }
    if (command.kind === "set_dependencies" && status === 422) {
      return this.denial(command, "company_scope_violation", message);
    }
    const code = status === 403
      ? "operation_not_authorized"
      : status === 409
        ? "state_conflict"
        : status === 422
          ? "semantic_rule_violation"
          : "production_service_error";
    return this.denial(command, code, message, status >= 500);
  }

  private denial(
    command: CapabilitySemanticCommand,
    code: string,
    message: string,
    retryable = false,
  ): CapabilityCommandOutcome {
    return {
      ok: false,
      commandKind: command.kind,
      stateRevision: this.#state.revision,
      error: { code, message, retryable },
    };
  }

  private post(path: string, body: unknown) {
    return request(this.app).post(path).set("X-Paperclip-Run-Id", this.binding.runId).send(body);
  }

  private put(path: string, body: unknown) {
    return request(this.app).put(path).set("X-Paperclip-Run-Id", this.binding.runId).send(body);
  }

  private patch(path: string, body: unknown) {
    return request(this.app).patch(path).set("X-Paperclip-Run-Id", this.binding.runId).send(body);
  }
}

function toFixtureRunStatus(status: string): CapabilityFixtureState["runs"][number]["status"] {
  switch (status) {
    case "running":
    case "succeeded":
    case "failed":
    case "cancelled":
      return status;
    default:
      throw new Error(`semantic_conformance_run_status_unmapped:${status}`);
  }
}

function createProductionAuthorityApp(db: Db, ids: PaperclipSemanticConformanceIds): Application {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "agent",
      agentId: ids.actorId,
      companyId: ids.companyId,
      runId: req.header("X-Paperclip-Run-Id") ?? undefined,
      source: "agent_jwt",
    };
    next();
  });
  app.use("/api", issueRoutes(db, {} as never));
  app.use(errorHandler);
  return app;
}

function toFixtureInteractionKind(kind: string): CapabilityFixtureState["interactions"][number]["kind"] {
  switch (kind) {
    case "request_confirmation": return "confirmation";
    case "request_checkbox_confirmation": return "checkbox";
    case "ask_user_questions": return "questions";
    case "suggest_tasks": return "suggest_tasks";
    case "request_item_verdicts": return "item_verdicts";
    default: throw new Error(`semantic_conformance_interaction_kind_unmapped:${kind}`);
  }
}

function readPrompt(payload: unknown): string {
  return typeof payload === "object" && payload !== null && "prompt" in payload
    ? String(payload.prompt)
    : "";
}

function readTargetRevisionId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("target" in payload)) return null;
  const target = payload.target;
  return typeof target === "object" && target !== null && "revisionId" in target
    ? String(target.revisionId)
    : null;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function errorMessage(body: unknown): string {
  return typeof body === "object" && body !== null && "error" in body
    ? String(body.error)
    : "Production service denied the semantic command";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
