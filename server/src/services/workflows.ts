import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowDeliverables,
  workflowHandoffBridges,
  workflowHandoffs,
  workflowInvocations,
  workflowRunPhases,
  workflowRunTelemetryEvents,
  workflowRunEvents,
  workflowExtensionRequests,
  workflowRuns,
  workflows,
  routines,
  routineRuns,
} from "@paperclipai/db";
import type {
  CreateWorkflow,
  CreateWorkflowHandoff,
  ResolveWorkflowHandoff,
  RunWorkflow,
  UpdateWorkflow,
  WorkflowInvocationTargetSelector,
  Workflow,
  WorkflowDetail,
  WorkflowDeliverableSummary,
  WorkflowHandoff,
  WorkflowListItem,
  WorkflowPhase,
  WorkflowPhaseEvent,
  WorkflowTelemetryEvent,
  WorkflowTelemetryEventInput,
  WorkflowRunInvocationSummary,
  WorkflowRun,
  WorkflowRunConsoleChunk,
  WorkflowRunDetail,
  WorkflowRunUsage,
  WorkflowRunEvent,
  WorkflowRunAsset,
  WorkflowRunFeedback,
  WorkflowExtensionWriteContext,
  ResourceRunOverride,
  WorkflowResourceManifest,
} from "@paperclipai/shared";
import { CITRO_SOCIAL_CMS_EXTENSION, resourceRunOverridesSchema, workflowResourceManifestSchema } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getStorageService } from "../storage/index.js";
import { type StorageService } from "../storage/types.js";
import { createWorkflowRunJwt, verifyWorkflowRunJwt } from "../workflow-run-jwt.js";
import { invokeGoogleAdk } from "@paperclipai/adapter-google-adk/server";
import { runningProcesses } from "../adapters/index.js";
import {
  analyzeWorkflowProject,
  collectWorkflowRuntimeArtifacts,
  prepareInstrumentedWorkflowRuntime,
} from "./workflows-runtime.js";
import { workflowHandoffBridgeService } from "./workflow-handoff-bridge.js";
import { resourceRuntimeService } from "./resource-runtime.js";

type WorkflowRunLaunchContext = {
  invocation?: WorkflowRunInvocationSummary | null;
  invocationInputJson?: Record<string, unknown> | null;
  resourceOverrides?: ResourceRunOverride[];
  resourceManifest?: WorkflowResourceManifest;
};

type SocialCmsFeedbackResult = {
  status: WorkflowRun["status"];
  reviewStage: "content" | "final" | null;
  revision: number;
  duplicate: boolean;
};

async function getSocialCmsRun(db: Db, runId: string) {
  const row = await db.select({
    run: workflowRuns,
    capabilities: workflows.capabilities,
  }).from(workflowRuns)
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(eq(workflowRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  const capabilities = Array.isArray(row.capabilities) ? row.capabilities as string[] : [];
  if (!capabilities.includes(CITRO_SOCIAL_CMS_EXTENSION)) {
    throw forbidden(`Workflow has not enabled ${CITRO_SOCIAL_CMS_EXTENSION}`);
  }
  return row.run;
}

function assertExtensionRevision(run: typeof workflowRuns.$inferSelect, input: WorkflowExtensionWriteContext) {
  if (run.revision !== input.revision) {
    throw conflict(`Workflow revision mismatch: expected ${run.revision}, received ${input.revision}`);
  }
}

function assertExtensionGeneration(run: typeof workflowRuns.$inferSelect, input: WorkflowExtensionWriteContext) {
  const context = (run.contextSnapshot as Record<string, unknown> | null) ?? {};
  const recordedGeneration = typeof context.socialCmsGenerationId === "string" ? context.socialCmsGenerationId : null;
  const recordedRevision = typeof context.socialCmsGenerationRevision === "number" ? context.socialCmsGenerationRevision : null;
  if (recordedGeneration && recordedRevision === input.revision && recordedGeneration !== input.generationId) {
    throw conflict(`Workflow generation mismatch for revision ${input.revision}`);
  }
}

function canonicalizeExtensionRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeExtensionRequest);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeExtensionRequest(item)]),
  );
}

function fingerprintExtensionRequest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalizeExtensionRequest(value))).digest("hex");
}

function toWorkflow(row: typeof workflows.$inferSelect): Workflow {
  const pipelineDefinition = (row.pipelineDefinition as Record<string, unknown> | null) ?? {};
  const phases = Array.isArray(pipelineDefinition.phases) ? (pipelineDefinition.phases as Workflow["pipelineDefinition"]["phases"]) : [];
  const generatedAt =
    typeof pipelineDefinition.generatedAt === "string" &&
    pipelineDefinition.generatedAt.trim().length > 0 &&
    !Number.isNaN(Date.parse(pipelineDefinition.generatedAt))
      ? pipelineDefinition.generatedAt
      : new Date(0).toISOString();
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    description: row.description ?? null,
    status: row.status as Workflow["status"],
    workflowKey: row.workflowKey ?? null,
    capabilities: Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [],
    runnerType: row.runnerType as "google_adk",
    runnerConfig: (row.runnerConfig as Record<string, unknown> | null) ?? {},
    pipelineDefinition: {
      entrypoint: typeof pipelineDefinition.entrypoint === "string" && pipelineDefinition.entrypoint.trim().length > 0
        ? pipelineDefinition.entrypoint
        : "agent.py",
      generatedAt,
      phases,
    },
    pipelineSourceHash: row.pipelineSourceHash ?? null,
    createdByUserId: row.createdByUserId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeWorkflowKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveWorkflowKey(title: string) {
  const slug = normalizeWorkflowKey(title);
  if (slug.length > 0) return slug;
  return "workflow";
}

function isWorkflowKeyUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const candidate = error as { code?: string; constraint?: string; constraint_name?: string };
  const constraint = candidate.constraint ?? candidate.constraint_name;
  return candidate.code === "23505" && constraint === "workflows_company_workflow_key_uq";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toWorkflowInvocationSummary(row: {
  id: string;
  contractVersion: string;
  inputKind: string;
  sourceRoutineId: string;
  sourceRoutineRunId: string;
  sourceRoutineTitle: string | null;
  sourceRoutineRunSource: string | null;
  targetWorkflowId: string;
  targetWorkflowKey: string | null;
  targetCapability: string | null;
}): WorkflowRunInvocationSummary {
  return {
    id: row.id,
    contractVersion: row.contractVersion as WorkflowRunInvocationSummary["contractVersion"],
    inputKind: row.inputKind as WorkflowRunInvocationSummary["inputKind"],
    sourceRoutineId: row.sourceRoutineId,
    sourceRoutineTitle: row.sourceRoutineTitle,
    sourceRoutineRunId: row.sourceRoutineRunId,
    sourceRoutineRunSource: row.sourceRoutineRunSource,
    targetWorkflowId: row.targetWorkflowId,
    targetWorkflowKey: row.targetWorkflowKey,
    targetCapability: row.targetCapability,
  };
}

function readWorkflowRunConsoleEntries(
  contextSnapshot: Record<string, unknown> | null,
): WorkflowRunConsoleChunk[] {
  const rawEntries = contextSnapshot?.consoleEntries;
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const chunk = typeof (entry as { chunk?: unknown }).chunk === "string" ? (entry as { chunk: string }).chunk : "";
    if (!chunk) return [];
    const streamRaw = typeof (entry as { stream?: unknown }).stream === "string" ? (entry as { stream: string }).stream : "stdout";
    const stream = streamRaw === "stderr" || streamRaw === "system" ? streamRaw : "stdout";
    const ts = typeof (entry as { ts?: unknown }).ts === "string"
      ? (entry as { ts: string }).ts
      : new Date(0).toISOString();
    return [{ ts, stream, chunk }];
  });
}

function readWorkflowRunExcerpt(
  contextSnapshot: Record<string, unknown> | null,
  key: "stdoutExcerpt" | "stderrExcerpt",
) {
  const value = contextSnapshot?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readWorkflowRunResultJson(contextSnapshot: Record<string, unknown> | null) {
  const value = contextSnapshot?.resultJson;
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

// Server-side filesystem paths stored in contextSnapshot must not be exposed to clients.
const CONTEXT_SNAPSHOT_SERVER_KEYS = ["tempRoot", "copiedAgentPath", "runtimeRoot"] as const;

function toWorkflowRun(row: typeof workflowRuns.$inferSelect, invocation: WorkflowRunInvocationSummary | null = null): WorkflowRun {
  const contextSnapshot = (row.contextSnapshot as Record<string, unknown> | null) ?? null;
  let clientContextSnapshot: Record<string, unknown> | null = null;
  if (contextSnapshot !== null) {
    clientContextSnapshot = { ...contextSnapshot };
    for (const key of CONTEXT_SNAPSHOT_SERVER_KEYS) {
      delete clientContextSnapshot[key];
    }
  }
  return {
    id: row.id,
    companyId: row.companyId,
    workflowId: row.workflowId,
    // Existing consumers use `awaiting_human`; the durable checkpoint is exposed
    // separately through reviewStage so they remain compatible with staged review.
    status: ["awaiting_content_review", "awaiting_final_review"].includes(row.status)
      ? "awaiting_human"
      : row.status,
    reviewStage: row.reviewStage === "content" || row.reviewStage === "final" ? row.reviewStage : null,
    revision: row.revision,
    inputMarkdown: row.inputMarkdown,
    error: row.error ?? null,
    summary: row.summary ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    usage: (row.usage as WorkflowRunUsage | null) ?? null,
    resultJson: readWorkflowRunResultJson(contextSnapshot),
    stdoutExcerpt: readWorkflowRunExcerpt(contextSnapshot, "stdoutExcerpt"),
    stderrExcerpt: readWorkflowRunExcerpt(contextSnapshot, "stderrExcerpt"),
    consoleEntries: readWorkflowRunConsoleEntries(contextSnapshot),
    contextSnapshot: clientContextSnapshot,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    invocation,
  };
}

function toWorkflowPhase(row: typeof workflowRunPhases.$inferSelect): WorkflowPhase {
  return {
    id: row.id,
    companyId: row.companyId,
    workflowRunId: row.workflowRunId,
    phaseKey: row.phaseKey,
    label: row.label,
    kind: row.kind as WorkflowPhase["kind"],
    ordinal: row.ordinal,
    status: row.status,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWorkflowTelemetryEvent(
  row: typeof workflowRunTelemetryEvents.$inferSelect,
): WorkflowTelemetryEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    workflowRunId: row.workflowRunId,
    schema: row.schemaVersion as "bizbox.telemetry/v1",
    event: row.eventType as WorkflowTelemetryEvent["event"],
    eventId: row.eventId,
    spanId: row.spanId,
    parentSpanId: row.parentSpanId ?? null,
    sequence: row.sequence,
    timestamp: row.timestamp.toISOString(),
    actor: {
      kind: row.actorKind as WorkflowTelemetryEvent["actor"]["kind"],
      name: row.actorName ?? null,
    },
    operation: {
      kind: row.operationKind as WorkflowTelemetryEvent["operation"]["kind"],
      name: row.operationName,
    },
    status: (row.status as WorkflowTelemetryEvent["status"]) ?? null,
    ...(row.input !== null ? { input: row.input } : {}),
    ...(row.output !== null ? { output: row.output } : {}),
    attributes: (row.attributes as Record<string, unknown> | null) ?? {},
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toWorkflowHandoff(
  row: typeof workflowHandoffs.$inferSelect,
  bridgeStatus: "waiting_for_human" | "closed" | null = null,
): WorkflowHandoff {
  return {
    id: row.id,
    companyId: row.companyId,
    workflowRunId: row.workflowRunId,
    phaseKey: row.phaseKey,
    kind: row.kind as WorkflowHandoff["kind"],
    status: row.status,
    promptMarkdown: row.promptMarkdown,
    reviewStage: row.reviewStage === "content" || row.reviewStage === "final" ? row.reviewStage : null,
    revision: row.revision,
    idempotencyKey: row.idempotencyKey ?? null,
    responseMarkdown: row.responseMarkdown ?? null,
    decidedByUserId: row.decidedByUserId ?? null,
    decidedAt: row.decidedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    bridgeStatus,
  };
}

function toWorkflowDeliverableSummary(row: typeof workflowDeliverables.$inferSelect): WorkflowDeliverableSummary {
  return {
    id: row.id,
    title: row.title,
    audience: row.audience,
    contentType: row.contentType,
    contentPath: row.contentPath ?? null,
    byteSize: row.byteSize,
    originalFilename: row.originalFilename ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toWorkflowRunEvent(row: typeof workflowRunEvents.$inferSelect): WorkflowRunEvent {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
    actor: row.actor === "human" ? "human" : "bizbox",
    phase: ["grounding", "planning", "assets", "review", "revision"].includes(row.phase)
      ? row.phase as WorkflowRunEvent["phase"]
      : "review",
    kind: ["source_summary", "screen_plan", "asset_generated", "review_requested", "review_response", "revision_applied"].includes(row.kind)
      ? row.kind as WorkflowRunEvent["kind"]
      : "review_requested",
    summary: row.summary,
    details: (row.details as Record<string, unknown> | null) ?? {},
    revision: row.revision,
  };
}

function reviewEventPhase(input: CreateWorkflowHandoff): "grounding" | "planning" | "assets" | "review" {
  if (input.eventPhase) return input.eventPhase;
  const phaseKey = input.phaseKey.toLowerCase();
  if (/(ground|synthesis|source)/.test(phaseKey)) return "grounding";
  if (/(plan|screen)/.test(phaseKey)) return "planning";
  if (/(asset|render|image)/.test(phaseKey)) return "assets";
  return "review";
}

function reviewEventKind(phase: ReturnType<typeof reviewEventPhase>): WorkflowRunEvent["kind"] {
  if (phase === "grounding") return "source_summary";
  if (phase === "planning") return "screen_plan";
  if (phase === "assets") return "asset_generated";
  return "review_requested";
}

const SOCIAL_CMS_ASSET_MAX_BYTES = 5 * 1024 * 1024;

function decodeSocialCmsAsset(contentBase64: string, contentType: string) {
  const normalized = contentBase64.replace(/\s/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw unprocessable("Social CMS asset content must be valid base64");
  }
  const body = Buffer.from(normalized, "base64");
  if (body.length === 0 || body.length > SOCIAL_CMS_ASSET_MAX_BYTES) {
    throw unprocessable(`Social CMS assets must be between 1 byte and ${SOCIAL_CMS_ASSET_MAX_BYTES} bytes`);
  }
  const isPng = body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  const isWebp = body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP";
  const matchesType = contentType === "image/png" ? isPng : contentType === "image/jpeg" ? isJpeg : contentType === "image/webp" ? isWebp : false;
  if (!matchesType) throw unprocessable(`Social CMS asset bytes do not match ${contentType}`);
  return body;
}

async function selectLatestRunMap(db: Db, workflowIds: string[]) {
  const runs = workflowIds.length > 0
    ? await db
        .selectDistinctOn([workflowRuns.workflowId])
        .from(workflowRuns)
        .where(inArray(workflowRuns.workflowId, workflowIds))
        .orderBy(workflowRuns.workflowId, desc(workflowRuns.createdAt), desc(workflowRuns.id))
    : [];
  const map = new Map<string, WorkflowRun>();
  for (const row of runs) {
    map.set(row.workflowId, toWorkflowRun(row));
  }
  const invocationMap = await selectRunInvocationMap(db, runs.map((row) => row.id));
  for (const [workflowId, run] of map.entries()) {
    const invocation = invocationMap.get(run.id) ?? null;
    if (invocation) {
      run.invocation = invocation;
    }
  }
  return map;
}

async function selectRunInvocationMap(db: Db, runIds: string[]) {
  if (runIds.length === 0) return new Map<string, WorkflowRunInvocationSummary>();
  const rows = await db
    .select({
      id: workflowInvocations.id,
      contractVersion: workflowInvocations.contractVersion,
      inputKind: workflowInvocations.inputKind,
      sourceRoutineId: workflowInvocations.sourceRoutineId,
      sourceRoutineRunId: workflowInvocations.sourceRoutineRunId,
      sourceRoutineTitle: routines.title,
      sourceRoutineRunSource: routineRuns.source,
      targetWorkflowId: workflowInvocations.targetWorkflowId,
      targetWorkflowKey: workflowInvocations.targetWorkflowKey,
      targetCapability: workflowInvocations.targetCapability,
      workflowRunId: workflowInvocations.workflowRunId,
    })
    .from(workflowInvocations)
    .leftJoin(routines, eq(workflowInvocations.sourceRoutineId, routines.id))
    .leftJoin(routineRuns, eq(workflowInvocations.sourceRoutineRunId, routineRuns.id))
    .where(inArray(workflowInvocations.workflowRunId, runIds));
  const map = new Map<string, WorkflowRunInvocationSummary>();
  for (const row of rows) {
    if (!row.workflowRunId) continue;
    map.set(row.workflowRunId, toWorkflowInvocationSummary(row));
  }
  return map;
}

async function ensureUniqueWorkflowKey(
  db: Db,
  companyId: string,
  desiredKey: string,
  excludeWorkflowId?: string | null,
) {
  const baseKey = normalizeWorkflowKey(desiredKey) || "workflow";
  const rows = await db
    .select({ workflowKey: workflows.workflowKey })
    .from(workflows)
    .where(and(
      eq(workflows.companyId, companyId),
      excludeWorkflowId ? notInArray(workflows.id, [excludeWorkflowId]) : sql`true`,
      isNotNull(workflows.workflowKey),
    ));
  const taken = new Set(rows.map((row) => row.workflowKey).filter((value): value is string => typeof value === "string" && value.length > 0));
  if (!taken.has(baseKey)) return baseKey;
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${baseKey}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw unprocessable("Unable to allocate a unique workflow key");
}

function formatWorkflowSelectorAttempt(target: WorkflowInvocationTargetSelector): string {
  const parts: string[] = [];
  const workflowId = target.workflowId?.trim();
  const workflowKey = target.workflowKey?.trim();
  const capability = target.capability?.trim();

  if (workflowId) parts.push(`workflowId=${workflowId}`);
  if (workflowKey) parts.push(`workflowKey=${workflowKey}`);
  if (capability) parts.push(`capability=${capability}`);

  return parts.length > 0 ? parts.join(", ") : "no workflow selector";
}

function assertWorkflowRunnable(workflow: Pick<typeof workflows.$inferSelect, "status" | "title">) {
  if (workflow.status === "archived") {
    throw conflict(`Workflow "${workflow.title}" is archived. Restore it before running.`);
  }
}

export async function resolveWorkflowByInvocationTarget(
  db: Db,
  companyId: string,
  target: WorkflowInvocationTargetSelector,
) {
  if (target.workflowId) {
    const row = await db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, target.workflowId), eq(workflows.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) {
      throw unprocessable(
        `Workflow id not found for this company (attempted ${formatWorkflowSelectorAttempt(target)})`,
      );
    }
    assertWorkflowRunnable(row);
    return row;
  }

  const workflowKey = target.workflowKey?.trim() || null;
  if (workflowKey) {
    const row = await db
      .select()
      .from(workflows)
      .where(and(eq(workflows.companyId, companyId), eq(workflows.workflowKey, workflowKey)))
      .then((rows) => rows[0] ?? null);
    if (!row) {
      throw unprocessable(
        `Workflow key not found for this company (attempted ${formatWorkflowSelectorAttempt(target)})`,
      );
    }
    assertWorkflowRunnable(row);
    return row;
  }

  const capability = target.capability?.trim() || null;
  if (capability) {
    const rows = await db
      .select()
      .from(workflows)
      .where(and(
        eq(workflows.companyId, companyId),
        sql`${workflows.capabilities} @> ${JSON.stringify([capability])}::jsonb`,
      ));
    if (rows.length === 0) {
      throw unprocessable(
        `No workflow matches the requested capability (attempted ${formatWorkflowSelectorAttempt(target)})`,
      );
    }
    const runnableRows = rows.filter((row) => row.status !== "archived");
    if (runnableRows.length === 0) {
      assertWorkflowRunnable(rows[0]);
    }
    if (runnableRows.length > 1) {
      throw unprocessable(
        `Capability selector is ambiguous; provide a workflow key or workflow id (attempted ${formatWorkflowSelectorAttempt(target)})`,
      );
    }
    return runnableRows[0] ?? null;
  }

  throw unprocessable(`Missing workflow selector (attempted ${formatWorkflowSelectorAttempt(target)})`);
}

async function selectCurrentPhaseMap(db: Db, runIds: string[]) {
  const phases = runIds.length > 0
    ? await db
        .select()
        .from(workflowRunPhases)
        .where(inArray(workflowRunPhases.workflowRunId, runIds))
        .orderBy(asc(workflowRunPhases.ordinal))
    : [];
  const map = new Map<string, WorkflowPhase>();
  for (const row of phases) {
    const candidate = toWorkflowPhase(row);
    if (candidate.status === "running" || candidate.status === "awaiting_human") {
      map.set(candidate.workflowRunId, candidate);
      continue;
    }
    if (!map.has(candidate.workflowRunId)) {
      map.set(candidate.workflowRunId, candidate);
    }
  }
  return map;
}

async function selectLatestDeliverableMap(db: Db, workflowIds: string[]) {
  const rows = workflowIds.length > 0
    ? await db
        .selectDistinctOn([workflowDeliverables.workflowId])
        .from(workflowDeliverables)
        .where(inArray(workflowDeliverables.workflowId, workflowIds))
        .orderBy(workflowDeliverables.workflowId, desc(workflowDeliverables.createdAt), desc(workflowDeliverables.id))
    : [];
  const map = new Map<string, WorkflowDeliverableSummary>();
  for (const row of rows) {
    map.set(row.workflowId, toWorkflowDeliverableSummary(row));
  }
  return map;
}

const WORKFLOW_DETAIL_RUN_LIMIT = 20;
const WORKFLOW_RUN_CONSOLE_ENTRY_LIMIT = 600;
const WORKFLOW_RUN_EXCERPT_CHAR_LIMIT = 16_000;
const WORKFLOW_ADK_TIMEOUT_SEC = 24 * 60 * 60;
const WORKFLOW_INTERRUPTED_ERROR = "Workflow process was interrupted before completion.";
const WORKFLOW_CANCELLED_ERROR = "Workflow run was cancelled by the board.";

function appendWorkflowRunExcerpt(existing: string, chunk: string) {
  const next = `${existing}${chunk}`;
  if (next.length <= WORKFLOW_RUN_EXCERPT_CHAR_LIMIT) return next;
  return next.slice(next.length - WORKFLOW_RUN_EXCERPT_CHAR_LIMIT);
}

function normalizeWorkflowConsoleChunk(stream: "stdout" | "stderr" | "system", chunk: string): WorkflowRunConsoleChunk {
  const normalized = chunk.length > 8_000 ? chunk.slice(chunk.length - 8_000) : chunk;
  return {
    ts: new Date().toISOString(),
    stream,
    chunk: normalized,
  };
}

function signalWorkflowProcess(runId: string) {
  const running = runningProcesses.get(runId);
  if (!running) return false;
  if (process.platform !== "win32" && running.processGroupId && running.processGroupId > 0) {
    try {
      process.kill(-running.processGroupId, "SIGTERM");
      return true;
    } catch {
      // Fall through to child.kill below.
    }
  }
  try {
    running.child.kill("SIGTERM");
    return true;
  } catch {
    return false;
  }
}

async function createWorkflowSummaryDeliverable(db: Db, input: {
  companyId: string;
  workflowId: string;
  runId: string;
  title: string;
  summary: string | null;
}) {
  const body = (input.summary ?? "").trim();
  if (!body) return null;
  const row = await db.insert(workflowDeliverables).values({
    companyId: input.companyId,
    workflowId: input.workflowId,
    workflowRunId: input.runId,
    title: input.title,
    summary: input.summary,
    audience: "human",
    contentType: "text/markdown; charset=utf-8",
    contentBody: body,
    byteSize: Buffer.byteLength(body, "utf8"),
    originalFilename: `${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "workflow-output"}.md`,
  }).returning().then((rows) => rows[0] ?? null);
  return row ? toWorkflowDeliverableSummary(row) : null;
}

async function createWorkflowArtifactDeliverables(
  db: Db,
  storage: StorageService,
  input: {
    companyId: string;
    workflowId: string;
    runId: string;
    artifacts: Awaited<ReturnType<typeof collectWorkflowRuntimeArtifacts>>;
  },
) {
  for (const artifact of input.artifacts) {
    const stored = await storage.putFile({
      companyId: input.companyId,
      namespace: "workflow-deliverables",
      originalFilename: artifact.originalFilename,
      contentType: artifact.contentType,
      body: artifact.body,
    });
    await db.insert(workflowDeliverables).values({
      companyId: input.companyId,
      workflowId: input.workflowId,
      workflowRunId: input.runId,
      title: artifact.relativePath,
      summary: null,
      audience: "human",
      contentType: stored.contentType,
      contentPath: stored.objectKey,
      byteSize: stored.byteSize,
      originalFilename: stored.originalFilename,
    });
  }
}

export function workflowService(db: Db) {
  const storage = getStorageService();

  function assertWorkflowRuntimeJwtConfigured() {
    if (createWorkflowRunJwt("workflow-preflight", "company-preflight", "run-preflight")) return;
    throw unprocessable(
      "Workflow runtime JWT secret is not configured. Set BIZBOX_WORKFLOW_JWT_SECRET, BIZBOX_AGENT_JWT_SECRET, or BETTER_AUTH_SECRET on the server.",
    );
  }

  async function refreshWorkflowAnalysis(row: typeof workflows.$inferSelect) {
    const runnerConfig = (row.runnerConfig as Record<string, unknown> | null) ?? {};
    const agentPath = typeof runnerConfig.agentPath === "string" ? runnerConfig.agentPath.trim() : "";
    if (!agentPath) {
      throw unprocessable("Workflow runnerConfig.agentPath is required");
    }
    const analysis = await analyzeWorkflowProject(agentPath);
    const updated = await db.update(workflows).set({
      pipelineDefinition: analysis.pipelineDefinition,
      pipelineSourceHash: analysis.sourceHash,
      updatedAt: new Date(),
    }).where(eq(workflows.id, row.id)).returning().then((rows) => rows[0] ?? null);
    if (!updated) {
      throw unprocessable("Failed to refresh workflow analysis");
    }
    return { workflow: toWorkflow(updated), analysis };
  }

  async function getById(id: string) {
    const row = await db.select().from(workflows).where(eq(workflows.id, id)).then((rows) => rows[0] ?? null);
    return row ? toWorkflow(row) : null;
  }

  async function executeRun(
    runId: string,
    preparedRun?: {
      workflow: Workflow;
      analysis: Awaited<ReturnType<typeof analyzeWorkflowProject>>;
    },
    launchContext?: WorkflowRunLaunchContext,
  ) {
    const runRow = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (!runRow) return;
    if (["succeeded", "failed", "cancelled", "rejected"].includes(runRow.status)) return;
    const workflowRow = preparedRun
      ? null
      : await db.select().from(workflows).where(eq(workflows.id, runRow.workflowId)).then((rows) => rows[0] ?? null);
    if (!preparedRun && !workflowRow) return;
    const workflow = preparedRun?.workflow ?? toWorkflow(workflowRow!);
    const analysis = preparedRun?.analysis ?? (await refreshWorkflowAnalysis(workflowRow!)).analysis;
    const runToken = createWorkflowRunJwt(workflow.id, workflow.companyId, runId);
    if (!runToken) {
      throw new Error("Missing workflow JWT secret");
    }

    const resourceManifest = launchContext?.resourceManifest;
    const runnerConfigWithoutResourceManifest = { ...workflow.runnerConfig };
    delete runnerConfigWithoutResourceManifest.resourceManifest;
    const prepared = await prepareInstrumentedWorkflowRuntime({
      workflowId: workflow.id,
      runId,
      companyId: workflow.companyId,
      runnerConfig: {
        ...runnerConfigWithoutResourceManifest,
        timeoutSec: WORKFLOW_ADK_TIMEOUT_SEC,
      },
      analysis,
      runToken,
    });

    let preparedResources;
    try {
      preparedResources = await resourceRuntimeService(db).prepare({
        companyId: workflow.companyId,
        runId,
        // The workflow run owns one temp root. The ADK project and Resource
        // mounts are separate directories inside that same run workspace.
        workspaceRoot: prepared.tempRoot,
        manifest: resourceManifest,
        overrides: launchContext?.resourceOverrides,
      });
    } catch (error) {
      await Promise.all([
        fs.rm(prepared.tempRoot, { recursive: true, force: true }).catch(() => {}),
        fs.rm(prepared.runtimeRoot, { recursive: true, force: true }).catch(() => {}),
      ]);
      throw error;
    }
    if (preparedResources) {
      prepared.patchedRunnerConfig = {
        ...prepared.patchedRunnerConfig,
        env: {
          ...(prepared.patchedRunnerConfig.env as Record<string, string> | undefined),
          ...preparedResources.environment,
        },
      };
    }

    const contextSnapshot: Record<string, unknown> = {
      runtimeRoot: prepared.runtimeRoot,
      tempRoot: prepared.tempRoot,
      copiedAgentPath: prepared.copiedAgentPath,
      consoleEntries: [] satisfies WorkflowRunConsoleChunk[],
      stdoutExcerpt: "",
      stderrExcerpt: "",
      resultJson: null,
      resourceVersions: preparedResources?.inputVersions ?? [],
      resourceOutputs: [],
      ...(launchContext?.invocation
        ? {
            invocation: {
              ...launchContext.invocation,
              inputMarkdown: runRow.inputMarkdown,
              inputJson: launchContext.invocationInputJson ?? null,
              contractVersion: launchContext.invocation.contractVersion,
            },
          }
        : {}),
    };

    // try/finally starts here — before the DB update — so that temp directories
    // created by prepareInstrumentedWorkflowRuntime are always cleaned up even
    // if the status update throws.
    const persistContextSnapshot = async () => {
      await db.update(workflowRuns).set({
        contextSnapshot,
        updatedAt: new Date(),
      }).where(eq(workflowRuns.id, runId));
    };

    const appendConsoleChunk = async (stream: "stdout" | "stderr" | "system", chunk: string) => {
      const normalized = normalizeWorkflowConsoleChunk(stream, chunk);
      const existing = readWorkflowRunConsoleEntries(contextSnapshot);
      contextSnapshot.consoleEntries = [...existing, normalized].slice(-WORKFLOW_RUN_CONSOLE_ENTRY_LIMIT);
      if (stream === "stdout") {
        contextSnapshot.stdoutExcerpt = appendWorkflowRunExcerpt(
          readWorkflowRunExcerpt(contextSnapshot, "stdoutExcerpt") ?? "",
          normalized.chunk,
        );
      }
      if (stream === "stderr") {
        contextSnapshot.stderrExcerpt = appendWorkflowRunExcerpt(
          readWorkflowRunExcerpt(contextSnapshot, "stderrExcerpt") ?? "",
          normalized.chunk,
        );
      }
      await persistContextSnapshot();
    };

    const finishOpenPhases = async (status: "succeeded" | "failed") => {
      const phases = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, runId)).orderBy(asc(workflowRunPhases.ordinal));
      if (phases.length === 0) {
        const now = new Date();
        await db.insert(workflowRunPhases).values({
          companyId: workflow.companyId,
          workflowRunId: runId,
          phaseKey: "entrypoint",
          label: "Entrypoint",
          kind: "phase",
          ordinal: 0,
          status,
          startedAt: now,
          finishedAt: now,
        }).catch(() => {});
        return;
      }

      for (const phase of phases) {
        if (phase.status === "idle") continue;
        if (["succeeded", "failed", "cancelled"].includes(phase.status)) continue;
        const now = new Date();
        await db.update(workflowRunPhases).set({
          status,
          startedAt: phase.startedAt ?? now,
          finishedAt: now,
          updatedAt: now,
        }).where(and(
          eq(workflowRunPhases.id, phase.id),
          notInArray(workflowRunPhases.status, ["succeeded", "failed", "cancelled"]),
        ));
      }
    };

    try {
      await db.update(workflowRuns).set({
        status: "running",
        startedAt: new Date(),
        updatedAt: new Date(),
        contextSnapshot,
      }).where(eq(workflowRuns.id, runId));

      const result = await invokeGoogleAdk({
        runId,
        agent: {
          id: workflow.id,
          companyId: workflow.companyId,
          name: workflow.title,
          adapterType: "google_adk",
          adapterConfig: prepared.patchedRunnerConfig,
        },
        config: prepared.patchedRunnerConfig,
        context: {
          workflowId: workflow.id,
          workflowRunId: runId,
        },
        onLog: async (stream, chunk) => {
          await appendConsoleChunk(stream, chunk);
        },
        queryOverride: `Workflow: ${workflow.title}\n\nInput:\n${runRow.inputMarkdown}`,
        runtimeRootOverride: prepared.runtimeRoot,
      });

      contextSnapshot.resultJson = result.resultJson ?? null;
      await persistContextSnapshot();

      if (!result.errorMessage && preparedResources) {
        const outputResults = await preparedResources.publish();
        contextSnapshot.resourceOutputs = outputResults;
        await persistContextSnapshot();
      }

      const artifacts = await collectWorkflowRuntimeArtifacts(prepared.runtimeRoot);
      // Deliverable persistence is best-effort: a transient storage or DB error
      // must not corrupt the run's terminal status. The agent invocation already
      // succeeded, so we log and continue rather than letting the outer catch
      // stamp the run as "failed".
      // Deliverables are only created on success — a failed run must not produce
      // any deliverable output.
      if (!result.errorMessage) {
        try {
          await createWorkflowSummaryDeliverable(db, {
            companyId: workflow.companyId,
            workflowId: workflow.id,
            runId,
            title: `${workflow.title} output`,
            summary: result.summary ?? null,
          });
          await createWorkflowArtifactDeliverables(db, storage, {
            companyId: workflow.companyId,
            workflowId: workflow.id,
            runId,
            artifacts,
          });
        } catch (deliverableErr) {
          console.error(
            `[workflows] deliverable persistence failed for run ${runId} (run will still be marked succeeded):`,
            deliverableErr,
          );
        }
      }

      await finishOpenPhases(result.errorMessage ? "failed" : "succeeded");

      await db.update(workflowRuns).set({
        status: result.errorMessage ? "failed" : "succeeded",
        error: result.errorMessage ?? null,
        summary: result.summary ?? null,
        provider: result.provider ?? null,
        model: result.model ?? null,
        usage: result.usage ?? null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(workflowRuns.id, runId),
        notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled", "rejected"]),
      ));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (err && typeof err === "object" && "resourceOutputs" in err && Array.isArray(err.resourceOutputs)) {
        contextSnapshot.resourceOutputs = err.resourceOutputs;
      }
      if (contextSnapshot.resultJson === null || contextSnapshot.resultJson === undefined) {
        contextSnapshot.resultJson = { error: errorMessage };
      } else {
        contextSnapshot.resourceOutputError = errorMessage;
      }
      if (err instanceof Error && err.message) {
        await appendConsoleChunk("stderr", `${err.message}\n`);
      }
      await persistContextSnapshot();
      await finishOpenPhases("failed");
      await db.update(workflowRuns).set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(workflowRuns.id, runId),
        notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled", "rejected"]),
      ));
      throw err;
    } finally {
      const previousContextSnapshot = (runRow.contextSnapshot as { tempRoot?: string } | null) ?? null;
      const tempRoot = (previousContextSnapshot?.tempRoot && typeof previousContextSnapshot.tempRoot === "string")
        ? previousContextSnapshot.tempRoot
        : prepared.tempRoot;
      await Promise.all([
        fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {}),
        fs.rm(prepared.runtimeRoot, { recursive: true, force: true }).catch(() => {}),
      ]);
    }
  }

  async function launchWorkflowRun(
    workflow: Workflow,
    analysis: Awaited<ReturnType<typeof analyzeWorkflowProject>>,
    inputMarkdown: string,
    launchContext?: WorkflowRunLaunchContext,
  ) {
    const runRow = await db.insert(workflowRuns).values({
      companyId: workflow.companyId,
      workflowId: workflow.id,
      status: "queued",
      inputMarkdown,
    }).returning().then((rows) => rows[0] ?? null);
    if (!runRow) throw unprocessable("Failed to create workflow run");
    const phases = analysis.pipelineDefinition.phases;
    if (phases.length > 0) {
      try {
        await db.insert(workflowRunPhases).values(
          phases.map((phase: typeof phases[number]) => ({
            companyId: workflow.companyId,
            workflowRunId: runRow.id,
            phaseKey: phase.key,
            label: phase.label,
            kind: phase.kind,
            ordinal: phase.ordinal,
            status: "idle",
            metadata: {
              filePath: phase.filePath,
              functionName: phase.functionName,
              parentKey: phase.parentKey ?? null,
              depth: phase.depth ?? 0,
              agentName: phase.agentName ?? null,
              description: phase.description ?? null,
              systemPrompt: phase.systemPrompt ?? null,
              configuredSkills: phase.configuredSkills ?? [],
            },
          })),
        );
      } catch (err) {
        await db.delete(workflowRuns).where(eq(workflowRuns.id, runRow.id)).catch(() => {});
        throw err;
      }
    }
    void executeRun(runRow.id, {
      workflow,
      analysis,
    }, launchContext).catch((err) => {
      void db.update(workflowRuns).set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(workflowRuns.id, runRow.id), notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled", "rejected"])));
      logger.error({ err, runId: runRow.id, workflowId: workflow.id }, "workflow execution failed");
    });
    return toWorkflowRun(runRow, launchContext?.invocation ?? null);
  }

  return {
    failInterruptedActiveRuns: async () => {
      const now = new Date();
      const candidates = await db
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .innerJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
        .where(and(
          eq(workflows.runnerType, "google_adk"),
          inArray(workflowRuns.status, ["queued", "running", "awaiting_human"]),
        ));
      const runIds = candidates.map((row) => row.id);
      if (runIds.length === 0) return { failed: 0, runIds };

      const rows = await db.update(workflowRuns).set({
        status: "failed",
        error: WORKFLOW_INTERRUPTED_ERROR,
        finishedAt: now,
        updatedAt: now,
      }).where(and(
        inArray(workflowRuns.id, runIds),
        inArray(workflowRuns.status, ["queued", "running", "awaiting_human"]),
      )).returning({ id: workflowRuns.id });
      const failedRunIds = rows.map((row) => row.id);
      await db.update(workflowRunPhases).set({
        status: "failed",
        startedAt: sql`COALESCE(${workflowRunPhases.startedAt}, ${now.toISOString()}::timestamptz)`,
        finishedAt: now,
        updatedAt: now,
      }).where(and(
        inArray(workflowRunPhases.workflowRunId, failedRunIds),
        notInArray(workflowRunPhases.status, ["succeeded", "failed", "cancelled"]),
      ));
      return { failed: rows.length, runIds: failedRunIds };
    },

    list: async (companyId: string, options: { includeArchived?: boolean } = {}): Promise<WorkflowListItem[]> => {
      const rows = await db.select().from(workflows).where(and(
        eq(workflows.companyId, companyId),
        options.includeArchived ? sql`true` : ne(workflows.status, "archived"),
      )).orderBy(desc(workflows.updatedAt));
      const items = rows.map(toWorkflow);
      const workflowIds = items.map((item) => item.id);
      const latestRunMap = await selectLatestRunMap(db, workflowIds);
      const latestRuns = [...latestRunMap.values()];
      const currentPhaseMap = await selectCurrentPhaseMap(db, latestRuns.map((run) => run.id));
      const latestDeliverableMap = await selectLatestDeliverableMap(db, workflowIds);
      return items.map((item) => {
        const latestRun = latestRunMap.get(item.id) ?? null;
        const currentPhase = latestRun ? currentPhaseMap.get(latestRun.id) ?? null : null;
        return {
          ...item,
          latestRun,
          currentPhase: currentPhase
            ? {
                phaseKey: currentPhase.phaseKey,
                label: currentPhase.label,
                status: currentPhase.status,
                ordinal: currentPhase.ordinal,
              }
            : null,
          latestDeliverable: latestDeliverableMap.get(item.id) ?? null,
        };
      });
    },

    get: getById,

    getDetail: async (id: string): Promise<WorkflowDetail | null> => {
      const row = await db.select().from(workflows).where(eq(workflows.id, id)).then((rows) => rows[0] ?? null);
      if (!row) return null;
      const workflow = toWorkflow(row);
      const runs = await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.workflowId, id))
        .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
        .limit(WORKFLOW_DETAIL_RUN_LIMIT);
      const invocationMap = await selectRunInvocationMap(db, runs.map((run) => run.id));
      const latestDeliverable = await db
        .select()
        .from(workflowDeliverables)
        .where(eq(workflowDeliverables.workflowId, id))
        .orderBy(desc(workflowDeliverables.createdAt), desc(workflowDeliverables.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return {
        ...workflow,
        latestRun: runs[0] ? toWorkflowRun(runs[0], invocationMap.get(runs[0].id) ?? null) : null,
        runs: runs.map((run) => toWorkflowRun(run, invocationMap.get(run.id) ?? null)),
        latestDeliverable: latestDeliverable ? toWorkflowDeliverableSummary(latestDeliverable) : null,
      };
    },

    create: async (companyId: string, input: CreateWorkflow, actor: { userId: string | null }) => {
      const workflowKey = input.workflowKey === undefined
        ? await ensureUniqueWorkflowKey(db, companyId, deriveWorkflowKey(input.title))
        : input.workflowKey === null
          ? null
          : await ensureUniqueWorkflowKey(db, companyId, input.workflowKey);
      let inserted;
      try {
        inserted = await db.insert(workflows).values({
          companyId,
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? "active",
          workflowKey,
          capabilities: input.capabilities ?? [],
          runnerType: "google_adk",
          runnerConfig: input.runnerConfig,
          pipelineDefinition: {},
          createdByUserId: actor.userId ?? "board",
          updatedByUserId: actor.userId ?? "board",
        }).returning().then((rows) => rows[0] ?? null);
      } catch (error) {
        if (!isWorkflowKeyUniqueViolation(error)) throw error;
        throw unprocessable("Workflow key already exists. Please retry.");
      }
      if (!inserted) throw unprocessable("Failed to create workflow");
      try {
        const refreshed = await refreshWorkflowAnalysis(inserted);
        return refreshed.workflow;
      } catch (err) {
        await db.delete(workflows).where(eq(workflows.id, inserted.id)).catch(() => {});
        throw err;
      }
    },

    update: async (id: string, patch: UpdateWorkflow, actor: { userId: string | null }) => {
      const existing = await db.select().from(workflows).where(eq(workflows.id, id)).then((rows) => rows[0] ?? null);
      if (!existing) return null;
      const existingRunnerConfig = (existing.runnerConfig as Record<string, unknown> | null) ?? {};
      const nextRunnerConfig = patch.runnerConfig === undefined
        ? undefined
        : {
            ...existingRunnerConfig,
            ...patch.runnerConfig,
          };
      let updated;
      try {
        updated = await db.update(workflows).set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.workflowKey !== undefined
            ? { workflowKey: patch.workflowKey === null ? null : await ensureUniqueWorkflowKey(db, existing.companyId, patch.workflowKey, existing.id) }
            : {}),
          ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
          ...(nextRunnerConfig !== undefined ? { runnerConfig: nextRunnerConfig } : {}),
          updatedByUserId: actor.userId ?? "board",
          updatedAt: new Date(),
        }).where(eq(workflows.id, id)).returning().then((rows) => rows[0] ?? null);
      } catch (error) {
        if (!isWorkflowKeyUniqueViolation(error)) throw error;
        throw unprocessable("Workflow key already exists. Please retry.");
      }
      if (!updated) return null;
      const shouldRefresh = patch.runnerConfig !== undefined
        && typeof patch.runnerConfig.agentPath === "string"
        && patch.runnerConfig.agentPath !== (existingRunnerConfig.agentPath as string | undefined);
      if (!shouldRefresh) return toWorkflow(updated);
      const refreshed = await refreshWorkflowAnalysis(updated);
      return refreshed.workflow;
    },

    runManual: async (workflowId: string, input: RunWorkflow) => {
      const workflowRow = await db.select().from(workflows).where(eq(workflows.id, workflowId)).then((rows) => rows[0] ?? null);
      if (!workflowRow) {
        throw unprocessable("Workflow not found");
      }
      assertWorkflowRunnable(workflowRow);
      assertWorkflowRuntimeJwtConfigured();
      const refreshed = await refreshWorkflowAnalysis(workflowRow);
      return launchWorkflowRun(refreshed.workflow, refreshed.analysis, input.inputMarkdown, {
        resourceManifest: input.resourceManifest,
        resourceOverrides: input.resourceOverrides,
      });
    },

    runInvocation: async (
      workflowId: string,
      input: { inputMarkdown: string; invocation: WorkflowRunLaunchContext["invocation"]; invocationInputJson?: Record<string, unknown> | null },
    ) => {
      const workflowRow = await db.select().from(workflows).where(eq(workflows.id, workflowId)).then((rows) => rows[0] ?? null);
      if (!workflowRow) {
        throw unprocessable("Workflow not found");
      }
      assertWorkflowRunnable(workflowRow);
      assertWorkflowRuntimeJwtConfigured();
      const refreshed = await refreshWorkflowAnalysis(workflowRow);
      const resourceManifest = workflowResourceManifestSchema.safeParse(input.invocationInputJson?.resourceManifest);
      if (!resourceManifest.success && input.invocationInputJson?.resourceManifest !== undefined) {
        throw unprocessable("Invalid Resource invocation manifest", resourceManifest.error.flatten());
      }
      const resourceOverrides = resourceRunOverridesSchema.safeParse(input.invocationInputJson?.resourceOverrides ?? []);
      if (!resourceOverrides.success) throw unprocessable("Invalid Resource run overrides", resourceOverrides.error.flatten());
      return launchWorkflowRun(refreshed.workflow, refreshed.analysis, input.inputMarkdown, {
        invocation: input.invocation ?? null,
        invocationInputJson: input.invocationInputJson ?? null,
        resourceManifest: resourceManifest.success ? resourceManifest.data : undefined,
        resourceOverrides: resourceOverrides.data,
      });
    },

    getRunDetail: async (runId: string): Promise<WorkflowRunDetail | null> => {
      const runRow = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0] ?? null);
      if (!runRow) return null;
      const workflowRow = await db.select().from(workflows).where(eq(workflows.id, runRow.workflowId)).then((rows) => rows[0] ?? null);
      if (!workflowRow) return null;
      const invocation = (await selectRunInvocationMap(db, [runId])).get(runId) ?? null;
      const phases = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, runId)).orderBy(asc(workflowRunPhases.ordinal));
      const telemetryEventsDescending = await db.select().from(workflowRunTelemetryEvents)
        .where(eq(workflowRunTelemetryEvents.workflowRunId, runId))
        .orderBy(desc(workflowRunTelemetryEvents.sequence), desc(workflowRunTelemetryEvents.createdAt))
        .limit(1_000);
      const telemetryEvents = telemetryEventsDescending.reverse();
      const handoffs = await db.select().from(workflowHandoffs).where(eq(workflowHandoffs.workflowRunId, runId)).orderBy(asc(workflowHandoffs.createdAt));
      const handoffIds = handoffs.map((h) => h.id);
      const bridges = handoffIds.length > 0
        ? await db.select({
            workflowHandoffId: workflowHandoffBridges.workflowHandoffId,
            status: workflowHandoffBridges.status,
          }).from(workflowHandoffBridges)
            .where(and(
              inArray(workflowHandoffBridges.workflowHandoffId, handoffIds),
              inArray(workflowHandoffBridges.status, ["pending_delivery", "waiting_for_human"]),
            ))
            .orderBy(desc(workflowHandoffBridges.createdAt))
        : [];
      const bridgeStatusByHandoffId = new Map(
        bridges
          .filter((b): b is typeof b & { status: "waiting_for_human" | "closed" } =>
            b.status === "waiting_for_human" || b.status === "closed",
          )
          .map((b) => [b.workflowHandoffId, b.status]),
      );
      const deliverables = await db.select().from(workflowDeliverables).where(eq(workflowDeliverables.workflowRunId, runId)).orderBy(desc(workflowDeliverables.createdAt));
      return {
        ...toWorkflowRun(runRow, invocation),
        workflow: {
          id: workflowRow.id,
          title: workflowRow.title,
          status: workflowRow.status,
          runnerType: workflowRow.runnerType as "google_adk",
        },
        phases: phases.map(toWorkflowPhase),
        telemetryEvents: telemetryEvents.map(toWorkflowTelemetryEvent),
        handoffs: handoffs.map((h) => toWorkflowHandoff(h, bridgeStatusByHandoffId.get(h.id) ?? null)),
        deliverables: deliverables.map(toWorkflowDeliverableSummary),
      };
    },

    listRunDeliverables: async (runId: string) => {
      const rows = await db.select().from(workflowDeliverables).where(eq(workflowDeliverables.workflowRunId, runId)).orderBy(desc(workflowDeliverables.createdAt));
      return rows.map(toWorkflowDeliverableSummary);
    },

    listRunAssets: async (runId: string): Promise<WorkflowRunAsset[]> => {
      const run = await getSocialCmsRun(db, runId);
      if (!run) return [];
      const published = (run.contextSnapshot as { reviewAssets?: Array<WorkflowRunAsset & { objectKey?: string }> } | null)?.reviewAssets;
      if (published?.length) return published.map(({ objectKey: _objectKey, ...asset }) => asset);
      const rows = await db.select().from(workflowDeliverables)
        .where(eq(workflowDeliverables.workflowRunId, runId))
        .orderBy(asc(workflowDeliverables.createdAt));
      return rows.map((row, index) => ({
        id: row.id,
        deliverableId: row.id,
        screenNumber: null,
        templateId: null,
        viewableUrl: `/api/deliverables/${row.id}/content`,
        thumbnailUrl: row.contentType.startsWith("image/") ? `/api/deliverables/${row.id}/content` : null,
        revision: run.revision,
        superseded: false,
      }));
    },

    getRunReview: async (runId: string) => {
      const run = await getSocialCmsRun(db, runId);
      if (!run) return null;
      const review = (run.contextSnapshot as { reviewDeliverables?: unknown } | null)?.reviewDeliverables;
      return { deliverables: Array.isArray(review) ? review : [] };
    },

    publishRunReview: async (runId: string, input: WorkflowExtensionWriteContext & { deliverables: Array<{ id: string; title: string; contentMarkdown: string; screens: Array<{ screenNumber: number; copy: string }> }> }) => {
      const run = await getSocialCmsRun(db, runId);
      if (!run) return null;
      assertExtensionRevision(run, input);
      assertExtensionGeneration(run, input);
      const requestHash = fingerprintExtensionRequest(input);
      return db.transaction(async (tx) => {
        const claimed = await tx.insert(workflowExtensionRequests).values({
          companyId: run.companyId,
          workflowRunId: runId,
          extensionKey: CITRO_SOCIAL_CMS_EXTENSION,
          operation: "publish_review",
          idempotencyKey: input.idempotencyKey,
          requestHash,
          generationId: input.generationId,
          revision: input.revision,
        }).onConflictDoNothing({
          target: [workflowExtensionRequests.workflowRunId, workflowExtensionRequests.extensionKey, workflowExtensionRequests.idempotencyKey],
        }).returning().then((rows) => rows[0] ?? null);
        if (!claimed) {
          const existing = await tx.select().from(workflowExtensionRequests).where(and(
            eq(workflowExtensionRequests.workflowRunId, runId),
            eq(workflowExtensionRequests.extensionKey, CITRO_SOCIAL_CMS_EXTENSION),
            eq(workflowExtensionRequests.idempotencyKey, input.idempotencyKey),
          )).then((rows) => rows[0] ?? null);
          if (!existing || existing.operation !== "publish_review" || existing.requestHash !== requestHash || existing.generationId !== input.generationId || existing.revision !== input.revision) {
            throw conflict("Idempotency key was already used for a different Social CMS request");
          }
          if (existing.response) return existing.response as { deliverables: typeof input.deliverables; generationId: string; revision: number };
          throw conflict("Social CMS review publication is already in progress");
        }
        for (const deliverable of input.deliverables) {
          await tx.insert(workflowDeliverables).values({ companyId: run.companyId, workflowId: run.workflowId, workflowRunId: runId, title: deliverable.title, audience: "human", contentType: "text/markdown; charset=utf-8", contentBody: deliverable.contentMarkdown, byteSize: Buffer.byteLength(deliverable.contentMarkdown), originalFilename: `${deliverable.id}.md` });
        }
        await tx.update(workflowRuns).set({ contextSnapshot: { ...((run.contextSnapshot as Record<string, unknown>) ?? {}), reviewDeliverables: input.deliverables, socialCmsGenerationId: input.generationId, socialCmsGenerationRevision: input.revision }, updatedAt: new Date() }).where(eq(workflowRuns.id, runId));
        const screenCount = input.deliverables.reduce((count, item) => count + item.screens.length, 0);
        await tx.insert(workflowRunEvents).values({ companyId: run.companyId, workflowRunId: runId, idempotencyKey: `${input.idempotencyKey}:screen-plan`, actor: "bizbox", phase: "planning", kind: "screen_plan", summary: `Screen plan ready: ${screenCount} screen${screenCount === 1 ? "" : "s"} across ${input.deliverables.length} reviewable deliverable${input.deliverables.length === 1 ? "" : "s"}.`, details: { generationId: input.generationId }, revision: input.revision });
        const response = { deliverables: input.deliverables, generationId: input.generationId, revision: input.revision };
        await tx.update(workflowExtensionRequests).set({ response, updatedAt: new Date() }).where(eq(workflowExtensionRequests.id, claimed.id));
        return response;
      });
    },

    publishRunAssets: async (runId: string, input: WorkflowExtensionWriteContext & { assets: Array<{ id: string; deliverableId: string; screenNumber: number; postType: string; templateId: string; contentBase64: string; contentType?: string }> }) => {
      const run = await getSocialCmsRun(db, runId);
      if (!run) return null;
      assertExtensionRevision(run, input);
      assertExtensionGeneration(run, input);
      const requestHash = fingerprintExtensionRequest(input);
      const storedObjectKeys: string[] = [];
      try {
        return await db.transaction(async (tx) => {
          const claimed = await tx.insert(workflowExtensionRequests).values({
            companyId: run.companyId,
            workflowRunId: runId,
            extensionKey: CITRO_SOCIAL_CMS_EXTENSION,
            operation: "publish_assets",
            idempotencyKey: input.idempotencyKey,
            requestHash,
            generationId: input.generationId,
            revision: input.revision,
          }).onConflictDoNothing({
            target: [workflowExtensionRequests.workflowRunId, workflowExtensionRequests.extensionKey, workflowExtensionRequests.idempotencyKey],
          }).returning().then((rows) => rows[0] ?? null);
          if (!claimed) {
            const existing = await tx.select().from(workflowExtensionRequests).where(and(
              eq(workflowExtensionRequests.workflowRunId, runId),
              eq(workflowExtensionRequests.extensionKey, CITRO_SOCIAL_CMS_EXTENSION),
              eq(workflowExtensionRequests.idempotencyKey, input.idempotencyKey),
            )).then((rows) => rows[0] ?? null);
            if (!existing || existing.operation !== "publish_assets" || existing.requestHash !== requestHash || existing.generationId !== input.generationId || existing.revision !== input.revision) {
              throw conflict("Idempotency key was already used for a different Social CMS request");
            }
            if (existing.response) return (existing.response as { assets: WorkflowRunAsset[] }).assets;
            throw conflict("Social CMS asset publication is already in progress");
          }
          const assets: WorkflowRunAsset[] = [];
          for (const asset of input.assets) {
            const contentType = asset.contentType ?? "image/png";
            const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "png";
            const body = decodeSocialCmsAsset(asset.contentBase64, contentType);
            const stored = await storage.putFile({ companyId: run.companyId, namespace: "workflow-deliverables", originalFilename: `${asset.deliverableId}-${asset.screenNumber}.${extension}`, contentType, body });
            storedObjectKeys.push(stored.objectKey);
            const row = await tx.insert(workflowDeliverables).values({ companyId: run.companyId, workflowId: run.workflowId, workflowRunId: runId, title: asset.id, audience: "human", contentType: stored.contentType, contentPath: stored.objectKey, byteSize: stored.byteSize, originalFilename: stored.originalFilename }).returning().then((rows) => rows[0]!);
            assets.push({ id: row.id, deliverableId: asset.deliverableId, screenNumber: asset.screenNumber, postType: asset.postType, templateId: asset.templateId, viewableUrl: `/api/deliverables/${row.id}/content`, thumbnailUrl: `/api/deliverables/${row.id}/content`, revision: input.revision, superseded: false });
          }
          await tx.update(workflowRuns).set({ contextSnapshot: { ...((run.contextSnapshot as Record<string, unknown>) ?? {}), reviewAssets: assets, socialCmsGenerationId: input.generationId, socialCmsGenerationRevision: input.revision }, updatedAt: new Date() }).where(eq(workflowRuns.id, runId));
          await tx.insert(workflowRunEvents).values({ companyId: run.companyId, workflowRunId: runId, idempotencyKey: `${input.idempotencyKey}:assets`, actor: "bizbox", phase: "assets", kind: "asset_generated", summary: `Assets ready: ${assets.length} rendered screen${assets.length === 1 ? "" : "s"} ready for review.`, details: { generationId: input.generationId }, revision: input.revision });
          await tx.update(workflowExtensionRequests).set({ response: { assets }, updatedAt: new Date() }).where(eq(workflowExtensionRequests.id, claimed.id));
          return assets;
        });
      } catch (error) {
        await Promise.all(storedObjectKeys.map((objectKey) => storage.deleteObject(run.companyId, objectKey).catch(() => undefined)));
        throw error;
      }
    },

    listRunEvents: async (runId: string, after?: string) => {
      const run = await getSocialCmsRun(db, runId);
      if (!run) return { events: [] };
      const cursor = after
        ? await db.select().from(workflowRunEvents).where(and(eq(workflowRunEvents.workflowRunId, runId), eq(workflowRunEvents.id, after))).then((rows) => rows[0] ?? null)
        : null;
      if (after && !cursor) throw badRequest("Invalid workflow event cursor");
      const where = cursor
        ? and(
            eq(workflowRunEvents.workflowRunId, runId),
            or(
              gt(workflowRunEvents.createdAt, cursor.createdAt),
              and(eq(workflowRunEvents.createdAt, cursor.createdAt), gt(workflowRunEvents.id, cursor.id)),
            ),
          )
        : eq(workflowRunEvents.workflowRunId, runId);
      const rows = await db.select().from(workflowRunEvents).where(where)
        .orderBy(asc(workflowRunEvents.createdAt), asc(workflowRunEvents.id)).limit(101);
      const page = rows.slice(0, 100);
      const events = page.map(toWorkflowRunEvent);
      return { events, ...(rows.length > 100 && events.length > 0 ? { nextCursor: events[events.length - 1]!.id } : {}) };
    },

    submitRunFeedback: async (runId: string, handoffId: string, feedback: WorkflowRunFeedback, actor: { userId: string | null }): Promise<SocialCmsFeedbackResult | null> => {
      const socialRun = await getSocialCmsRun(db, runId);
      if (!socialRun) return null;
      const now = new Date();
      const requestHash = fingerprintExtensionRequest({ handoffId, feedback });
      return db.transaction(async (tx) => {
        const claimed = await tx.insert(workflowExtensionRequests).values({
          companyId: socialRun.companyId,
          workflowRunId: runId,
          extensionKey: CITRO_SOCIAL_CMS_EXTENSION,
          operation: "submit_feedback",
          idempotencyKey: feedback.idempotencyKey,
          requestHash,
          generationId: feedback.generationId,
          revision: feedback.revision,
        }).onConflictDoNothing({
          target: [workflowExtensionRequests.workflowRunId, workflowExtensionRequests.extensionKey, workflowExtensionRequests.idempotencyKey],
        }).returning().then((rows) => rows[0] ?? null);
        if (!claimed) {
          const existing = await tx.select().from(workflowExtensionRequests).where(and(
            eq(workflowExtensionRequests.workflowRunId, runId),
            eq(workflowExtensionRequests.extensionKey, CITRO_SOCIAL_CMS_EXTENSION),
            eq(workflowExtensionRequests.idempotencyKey, feedback.idempotencyKey),
          )).then((rows) => rows[0] ?? null);
          if (!existing || existing.operation !== "submit_feedback" || existing.requestHash !== requestHash || existing.generationId !== feedback.generationId || existing.revision !== feedback.revision) {
            throw conflict("Idempotency key was already used for a different Social CMS request");
          }
          if (existing.response) return { ...(existing.response as Omit<SocialCmsFeedbackResult, "duplicate">), duplicate: true };
          throw conflict("Social CMS feedback is already in progress");
        }
        const run = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0] ?? null);
        if (!run) return null;
        assertExtensionRevision(run, feedback);
        assertExtensionGeneration(run, feedback);
        if (run.status !== "awaiting_human" || run.reviewStage !== feedback.stage) {
          throw conflict(`Workflow run is not awaiting ${feedback.stage} review`);
        }
        const handoff = await tx.select().from(workflowHandoffs)
          .where(and(eq(workflowHandoffs.id, handoffId), eq(workflowHandoffs.workflowRunId, runId)))
          .then((rows) => rows[0] ?? null);
        if (!handoff) throw badRequest("Workflow review handoff not found for this run");
        if (handoff.status !== "pending" || handoff.reviewStage !== feedback.stage || handoff.revision !== feedback.revision) {
          throw conflict("Workflow review handoff is no longer pending at the requested stage and revision");
        }

        const revision = feedback.action === "request_changes" ? run.revision + 1 : run.revision;
        const message = JSON.stringify({ action: feedback.action, stage: feedback.stage, instruction: feedback.instruction ?? "", target: feedback.target, revision });
        const resolution = feedback.action === "approve" ? "approved" : feedback.action === "reject" ? "rejected" : "responded";
        const resolvedHandoff = await tx.update(workflowHandoffs).set({
          status: resolution,
          responseMarkdown: message,
          decidedByUserId: actor.userId ?? "board",
          decidedAt: now,
          updatedAt: now,
        }).where(and(eq(workflowHandoffs.id, handoff.id), eq(workflowHandoffs.status, "pending"))).returning().then((rows) => rows[0] ?? null);
        if (!resolvedHandoff) throw conflict("Workflow review handoff was already resolved");

        const nextStatus = feedback.action === "reject" ? "rejected" : "running";
        const nextRun = await tx.update(workflowRuns).set({
          status: nextStatus,
          reviewStage: feedback.stage,
          revision,
          finishedAt: feedback.action === "reject" ? now : null,
          updatedAt: now,
          contextSnapshot: {
            ...((run.contextSnapshot as Record<string, unknown> | null) ?? {}),
            reviewFeedback: { ...feedback, reviewerId: actor.userId ?? "board", receivedAt: now.toISOString(), revision },
          },
        }).where(eq(workflowRuns.id, runId)).returning().then((rows) => rows[0] ?? null);
        if (!nextRun) throw unprocessable("Failed to persist workflow feedback");
        await tx.insert(workflowRunEvents).values({
          companyId: run.companyId,
          workflowRunId: runId,
          idempotencyKey: `${feedback.idempotencyKey}:response`,
          actor: "human",
          phase: feedback.action === "request_changes" ? "revision" : "review",
          kind: "review_response",
          summary: feedback.action === "request_changes" ? "Changes requested" : feedback.action === "approve" ? "Review approved" : "Review rejected",
          details: { ...feedback, reviewerId: actor.userId ?? "board", timestamp: now.toISOString() },
          revision,
        });
        if (feedback.action === "request_changes") {
          await tx.insert(workflowRunEvents).values({
            companyId: run.companyId,
            workflowRunId: runId,
            idempotencyKey: `${feedback.idempotencyKey}:revision`,
            actor: "bizbox",
            phase: "revision",
            kind: "revision_applied",
            summary: `Revision ${revision} resumed for ${feedback.target.scope}`,
            details: { target: feedback.target, stage: feedback.stage },
            revision,
          });
        }
        const response: Omit<SocialCmsFeedbackResult, "duplicate"> = {
          status: toWorkflowRun(nextRun).status,
          reviewStage: nextRun.reviewStage === "content" || nextRun.reviewStage === "final" ? nextRun.reviewStage : null,
          revision: nextRun.revision,
        };
        await tx.update(workflowExtensionRequests).set({ response, updatedAt: now }).where(eq(workflowExtensionRequests.id, claimed.id));
        return { ...response, duplicate: false };
      });
    },

    getDeliverableById: async (id: string) => {
      const row = await db.select().from(workflowDeliverables).where(eq(workflowDeliverables.id, id)).then((rows) => rows[0] ?? null);
      return row ? toWorkflowDeliverableSummary(row) : null;
    },

    verifyRuntimeToken: async (runId: string, token: string) => {
      const claims = verifyWorkflowRunJwt(token);
      if (!claims || claims.run_id !== runId) return null;
      const runRow = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0] ?? null);
      if (!runRow) return null;
      if (runRow.companyId !== claims.company_id || runRow.workflowId !== claims.workflow_id) return null;
      return runRow;
    },

    applyTelemetryEvents: async (runId: string, events: WorkflowTelemetryEventInput[]) => {
      const run = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0] ?? null);
      if (!run) return null;
      const inserted = await db.insert(workflowRunTelemetryEvents).values(events.map((event) => ({
        companyId: run.companyId,
        workflowRunId: run.id,
        schemaVersion: event.schema,
        eventId: event.eventId,
        eventType: event.event,
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        sequence: event.sequence,
        timestamp: new Date(event.timestamp),
        actorKind: event.actor.kind,
        actorName: event.actor.name,
        operationKind: event.operation.kind,
        operationName: event.operation.name,
        status: event.status,
        input: event.input ?? null,
        output: event.output ?? null,
        attributes: event.attributes ?? {},
        error: event.error ?? null,
      }))).onConflictDoNothing({
        target: [workflowRunTelemetryEvents.workflowRunId, workflowRunTelemetryEvents.eventId],
      }).returning({ eventId: workflowRunTelemetryEvents.eventId });
      return {
        accepted: inserted.length,
        duplicates: events.length - inserted.length,
      };
    },

    cancelRun: async (runId: string, actor: { userId: string | null }) => {
      const existing = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0] ?? null);
      if (!existing) return null;
      if (["succeeded", "failed", "cancelled", "rejected"].includes(existing.status)) {
        return toWorkflowRun(existing);
      }

      signalWorkflowProcess(runId);

      const now = new Date();
      const updated = await db.transaction(async (tx) => {
        const run = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0] ?? null);
        if (!run) return null;
        if (["succeeded", "failed", "cancelled", "rejected"].includes(run.status)) {
          return run;
        }

        const contextSnapshot = (run.contextSnapshot as Record<string, unknown> | null) ?? {};
        const resultJson = contextSnapshot.resultJson && typeof contextSnapshot.resultJson === "object"
          ? contextSnapshot.resultJson as Record<string, unknown>
          : {};
        const nextContextSnapshot = {
          ...contextSnapshot,
          resultJson: {
            ...resultJson,
            stopReason: "cancelled",
            cancelledByUserId: actor.userId ?? "board",
            cancelledAt: now.toISOString(),
          },
        };

        const nextRun = await tx.update(workflowRuns).set({
          status: "cancelled",
          error: WORKFLOW_CANCELLED_ERROR,
          finishedAt: now,
          updatedAt: now,
          contextSnapshot: nextContextSnapshot,
        }).where(and(
          eq(workflowRuns.id, runId),
          notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled", "rejected"]),
        )).returning().then((rows) => rows[0] ?? run);

        await tx.update(workflowRunPhases).set({
          status: "cancelled",
          startedAt: sql`COALESCE(${workflowRunPhases.startedAt}, ${now.toISOString()}::timestamptz)`,
          finishedAt: now,
          updatedAt: now,
        }).where(and(
          eq(workflowRunPhases.workflowRunId, runId),
          notInArray(workflowRunPhases.status, ["succeeded", "failed", "cancelled"]),
        ));

        await tx.update(workflowHandoffs).set({
          status: "cancelled",
          responseMarkdown: null,
          decidedByUserId: actor.userId ?? "board",
          decidedAt: now,
          updatedAt: now,
        }).where(and(
          eq(workflowHandoffs.workflowRunId, runId),
          eq(workflowHandoffs.status, "pending"),
        ));

        return nextRun;
      });

      try {
        await workflowHandoffBridgeService(db).closeTerminalRunHandoffs(runId, "cancelled");
      } catch (error) {
        logger.warn({ err: error, runId }, "workflow handoff bridge: failed to close bridges for cancelled run");
      }

      return updated ? toWorkflowRun(updated) : null;
    },

    applyPhaseEvent: async (runId: string, event: WorkflowPhaseEvent) => {
      const eventMetadata = {
        ...(event.metadata ?? {}),
        runtimeCalled: true,
      };
      const run = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0] ?? null);
      if (!run || ["succeeded", "failed", "cancelled", "rejected"].includes(run.status)) return null;
      let existing = await db.select().from(workflowRunPhases).where(
        and(eq(workflowRunPhases.workflowRunId, runId), eq(workflowRunPhases.phaseKey, event.phaseKey)),
      ).then((rows) => rows[0] ?? null);
      const now = new Date();
      if (!existing) {
        if (event.metadata?.runtimeAgent !== true && event.metadata?.runtimePhase !== true) return null;
        const lastPhase = await db.select({ ordinal: workflowRunPhases.ordinal })
          .from(workflowRunPhases)
          .where(eq(workflowRunPhases.workflowRunId, runId))
          .orderBy(desc(workflowRunPhases.ordinal))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const requestedKind = event.metadata.runtimeKind;
        const runtimeKind = requestedKind === "tool" || requestedKind === "validator" || requestedKind === "loop"
          ? requestedKind
          : "agent";
        existing = await db.insert(workflowRunPhases).values({
          companyId: run.companyId,
          workflowRunId: runId,
          phaseKey: event.phaseKey,
          label: event.label ?? String(event.metadata.agentName ?? "Runtime agent"),
          kind: runtimeKind,
          ordinal: (lastPhase?.ordinal ?? -1) + 1,
          status: "idle",
          metadata: eventMetadata,
        }).returning().then((rows) => rows[0] ?? null);
        if (!existing) return null;
      }
      const updated = await db.update(workflowRunPhases).set({
        status: event.status,
        label: event.label ?? existing.label,
        metadata: event.metadata
          ? {
              ...((existing.metadata as Record<string, unknown> | null) ?? {}),
              ...eventMetadata,
            }
          : {
              ...((existing.metadata as Record<string, unknown> | null) ?? {}),
              runtimeCalled: true,
            },
        startedAt: event.status === "running" && !existing.startedAt ? now : existing.startedAt,
        finishedAt: ["succeeded", "failed", "cancelled"].includes(event.status) ? now : existing.finishedAt,
        updatedAt: now,
      }).where(and(
        eq(workflowRunPhases.id, existing.id),
        notInArray(workflowRunPhases.status, ["succeeded", "failed", "cancelled"]),
      )).returning().then((rows) => rows[0] ?? null);
      if (event.status === "running") {
        await db.update(workflowRuns).set({ status: "running", startedAt: now, updatedAt: now }).where(and(
          eq(workflowRuns.id, runId),
          notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled", "rejected"]),
        ));
      }
      if (event.status === "awaiting_human") {
        await db.update(workflowRuns).set({ status: "awaiting_human", updatedAt: now }).where(and(
          eq(workflowRuns.id, runId),
          notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled", "rejected"]),
        ));
      }
      return updated ? toWorkflowPhase(updated) : null;
    },

    createRuntimeHandoff: async (runId: string, input: CreateWorkflowHandoff) => {
      // The generic run lifecycle remains `awaiting_human`. Review stage is
      // additive metadata for opt-in review surfaces and must not change the
      // status contract used by other workflows, the UI, or handoff bridges.
      const reviewStage = input.stage ?? "content";
      const isSocialCmsReview = input.stage !== undefined
        || input.eventPhase !== undefined
        || input.reviewSummary !== undefined;
      if (isSocialCmsReview && !input.idempotencyKey) {
        throw badRequest("Social CMS review handoffs require an idempotency key");
      }
      const runRow = isSocialCmsReview
        ? await getSocialCmsRun(db, runId)
        : await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0] ?? null);
      if (!runRow) throw unprocessable("Workflow run not found");
      return db.transaction(async (tx) => {
        if (input.idempotencyKey) {
          const existing = await tx.select().from(workflowHandoffs).where(and(
            eq(workflowHandoffs.workflowRunId, runId),
            eq(workflowHandoffs.idempotencyKey, input.idempotencyKey),
          )).then((rows) => rows[0] ?? null);
          if (existing) return toWorkflowHandoff(existing);
        }
        const now = new Date();
        await tx.update(workflowRunPhases).set({
          status: "awaiting_human",
          updatedAt: now,
        }).where(and(
          eq(workflowRunPhases.workflowRunId, runId),
          eq(workflowRunPhases.phaseKey, input.phaseKey),
          notInArray(workflowRunPhases.status, ["succeeded", "failed", "cancelled"]),
        ));
        await tx.update(workflowRuns).set({ status: "awaiting_human", reviewStage: input.stage ?? null, updatedAt: now }).where(and(
          eq(workflowRuns.id, runId),
          notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled", "rejected"]),
        ));
        const inserted = await tx.insert(workflowHandoffs).values({
          companyId: runRow.companyId,
          workflowRunId: runId,
          phaseKey: input.phaseKey,
          kind: input.kind,
          status: "pending",
          promptMarkdown: input.promptMarkdown,
          reviewStage: isSocialCmsReview ? reviewStage : null,
          revision: runRow.revision,
          idempotencyKey: input.idempotencyKey ?? null,
        }).onConflictDoNothing().returning().then((rows) => rows[0] ?? null);
        if (!inserted && input.idempotencyKey) {
          const existing = await tx.select().from(workflowHandoffs).where(and(
            eq(workflowHandoffs.workflowRunId, runId),
            eq(workflowHandoffs.idempotencyKey, input.idempotencyKey),
          )).then((rows) => rows[0] ?? null);
          if (existing) return toWorkflowHandoff(existing);
        }
        if (!inserted) throw unprocessable("Failed to create workflow handoff");
        if (isSocialCmsReview) {
          await tx.insert(workflowRunEvents).values({
            companyId: runRow.companyId,
            workflowRunId: runId,
            idempotencyKey: `${input.idempotencyKey}:review-requested`,
            actor: "bizbox",
            phase: reviewEventPhase(input),
            kind: reviewEventKind(reviewEventPhase(input)),
            summary: input.reviewSummary ?? `Awaiting ${reviewStage} review`,
            details: { handoffId: inserted.id, phaseKey: input.phaseKey, stage: reviewStage },
            revision: runRow.revision,
          });
        }
        return toWorkflowHandoff(inserted);
      });
    },

    getHandoff: async (handoffId: string) => {
      const row = await db.select().from(workflowHandoffs).where(eq(workflowHandoffs.id, handoffId)).then((rows) => rows[0] ?? null);
      if (!row) return null;
      const bridge = await db.select({ status: workflowHandoffBridges.status })
        .from(workflowHandoffBridges)
        .where(and(
          eq(workflowHandoffBridges.workflowHandoffId, handoffId),
          inArray(workflowHandoffBridges.status, ["pending_delivery", "waiting_for_human"]),
        ))
        .orderBy(desc(workflowHandoffBridges.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const bridgeStatus = bridge?.status === "waiting_for_human" || bridge?.status === "pending_delivery"
        ? "waiting_for_human" as const
        : null;
      return toWorkflowHandoff(row, bridgeStatus);
    },

    resolveHandoff: async (
      handoffId: string,
      resolution: "approved" | "rejected" | "responded",
      actor: { userId: string | null },
      input?: ResolveWorkflowHandoff,
    ) => {
      const existing = await db.select().from(workflowHandoffs).where(eq(workflowHandoffs.id, handoffId)).then((rows) => rows[0] ?? null);
      if (!existing) return null;
      if (existing.status !== "pending") return toWorkflowHandoff(existing);
      const now = new Date();
      const updated = await db.update(workflowHandoffs).set({
        status: resolution,
        responseMarkdown: input?.responseMarkdown ?? existing.responseMarkdown,
        decidedByUserId: actor.userId ?? "board",
        decidedAt: now,
        updatedAt: now,
      }).where(and(eq(workflowHandoffs.id, handoffId), eq(workflowHandoffs.status, "pending"))).returning().then((rows) => rows[0] ?? null);
      if (!updated) {
        const current = await db.select().from(workflowHandoffs).where(eq(workflowHandoffs.id, handoffId)).then((rows) => rows[0] ?? null);
        return current ? toWorkflowHandoff(current) : null;
      }
      // A handoff decision is input to the workflow, not a run-level terminal
      // action. The runtime decides whether rejection means stop, revise, or
      // continue along another branch.
      await db.update(workflowRunPhases).set({
        status: "running",
        updatedAt: now,
      }).where(and(
        eq(workflowRunPhases.workflowRunId, existing.workflowRunId),
        eq(workflowRunPhases.phaseKey, existing.phaseKey),
        notInArray(workflowRunPhases.status, ["succeeded", "failed", "cancelled"]),
      ));
      await db.update(workflowRuns).set({
        status: "running",
        updatedAt: now,
      }).where(and(
        eq(workflowRuns.id, existing.workflowRunId),
        notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled", "rejected"]),
      ));
      try {
        await workflowHandoffBridgeService(db).closeResolvedHandoff(updated.id, resolution);
      } catch (error) {
        logger.warn({
          err: error,
          workflowHandoffId: updated.id,
          workflowRunId: existing.workflowRunId,
          resolution,
        }, "workflow handoff bridge: failed to close bridge after direct handoff resolution");
      }
      return updated ? toWorkflowHandoff(updated) : null;
    },
  };
}
