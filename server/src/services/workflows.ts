import fs from "node:fs/promises";
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowDeliverables,
  workflowHandoffBridges,
  workflowHandoffs,
  workflowRunPhases,
  workflowRuns,
  workflows,
} from "@paperclipai/db";
import type {
  CreateWorkflow,
  CreateWorkflowHandoff,
  ResolveWorkflowHandoff,
  RunWorkflow,
  UpdateWorkflow,
  Workflow,
  WorkflowDetail,
  WorkflowDeliverableSummary,
  WorkflowHandoff,
  WorkflowListItem,
  WorkflowPhase,
  WorkflowPhaseEvent,
  WorkflowRun,
  WorkflowRunConsoleChunk,
  WorkflowRunDetail,
  WorkflowRunUsage,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getStorageService } from "../storage/index.js";
import { type StorageService } from "../storage/types.js";
import { createWorkflowRunJwt, verifyWorkflowRunJwt } from "../workflow-run-jwt.js";
import { invokeGoogleAdk } from "@paperclipai/adapter-google-adk/server";
import {
  analyzeWorkflowProject,
  collectWorkflowRuntimeArtifacts,
  prepareInstrumentedWorkflowRuntime,
} from "./workflows-runtime.js";

function toWorkflow(row: typeof workflows.$inferSelect): Workflow {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    description: row.description ?? null,
    status: row.status as Workflow["status"],
    runnerType: row.runnerType as "google_adk",
    runnerConfig: (row.runnerConfig as Record<string, unknown> | null) ?? {},
    pipelineDefinition: (row.pipelineDefinition as Workflow["pipelineDefinition"] | null) ?? {
      entrypoint: "agent.py",
      generatedAt: new Date(0).toISOString(),
      phases: [],
    },
    pipelineSourceHash: row.pipelineSourceHash ?? null,
    createdByUserId: row.createdByUserId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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

function toWorkflowRun(row: typeof workflowRuns.$inferSelect): WorkflowRun {
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
    status: row.status,
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
  return map;
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
  ) {
    const runRow = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (!runRow) return;
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

    const prepared = await prepareInstrumentedWorkflowRuntime({
      workflowId: workflow.id,
      runId,
      companyId: workflow.companyId,
      runnerConfig: workflow.runnerConfig,
      analysis,
      runToken,
    });

    const contextSnapshot: Record<string, unknown> = {
      runtimeRoot: prepared.runtimeRoot,
      tempRoot: prepared.tempRoot,
      copiedAgentPath: prepared.copiedAgentPath,
      consoleEntries: [] satisfies WorkflowRunConsoleChunk[],
      stdoutExcerpt: "",
      stderrExcerpt: "",
      resultJson: null,
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

      const phases = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, runId)).orderBy(asc(workflowRunPhases.ordinal));
      if (phases.every((phase) => phase.status === "idle")) {
        const first = phases[0];
        if (first) {
          await db.update(workflowRunPhases).set({
            status: result.errorMessage ? "failed" : "succeeded",
            startedAt: new Date(),
            finishedAt: new Date(),
            updatedAt: new Date(),
          }).where(and(eq(workflowRunPhases.id, first.id), eq(workflowRunPhases.status, "idle")));
        }
      }

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
        notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled"]),
      ));
    } catch (err) {
      contextSnapshot.resultJson = {
        error: err instanceof Error ? err.message : String(err),
      };
      if (err instanceof Error && err.message) {
        await appendConsoleChunk("stderr", `${err.message}\n`);
      } else {
        await persistContextSnapshot();
      }
      await db.update(workflowRuns).set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(workflowRuns.id, runId),
        notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled"]),
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

  return {
    list: async (companyId: string): Promise<WorkflowListItem[]> => {
      const rows = await db.select().from(workflows).where(eq(workflows.companyId, companyId)).orderBy(desc(workflows.updatedAt));
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
      const latestDeliverable = await db
        .select()
        .from(workflowDeliverables)
        .where(eq(workflowDeliverables.workflowId, id))
        .orderBy(desc(workflowDeliverables.createdAt), desc(workflowDeliverables.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return {
        ...workflow,
        latestRun: runs[0] ? toWorkflowRun(runs[0]) : null,
        runs: runs.map(toWorkflowRun),
        latestDeliverable: latestDeliverable ? toWorkflowDeliverableSummary(latestDeliverable) : null,
      };
    },

    create: async (companyId: string, input: CreateWorkflow, actor: { userId: string | null }) => {
      const inserted = await db.insert(workflows).values({
        companyId,
        title: input.title,
        description: input.description ?? null,
        status: input.status ?? "active",
        runnerType: "google_adk",
        runnerConfig: input.runnerConfig,
        pipelineDefinition: {},
        createdByUserId: actor.userId ?? "board",
        updatedByUserId: actor.userId ?? "board",
      }).returning().then((rows) => rows[0] ?? null);
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
      const updated = await db.update(workflows).set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.runnerConfig !== undefined ? { runnerConfig: patch.runnerConfig } : {}),
        updatedByUserId: actor.userId ?? "board",
        updatedAt: new Date(),
      }).where(eq(workflows.id, id)).returning().then((rows) => rows[0] ?? null);
      if (!updated) return null;
      const shouldRefresh = patch.runnerConfig !== undefined;
      if (!shouldRefresh) return toWorkflow(updated);
      const refreshed = await refreshWorkflowAnalysis(updated);
      return refreshed.workflow;
    },

    runManual: async (workflowId: string, input: RunWorkflow) => {
      const workflowRow = await db.select().from(workflows).where(eq(workflows.id, workflowId)).then((rows) => rows[0] ?? null);
      if (!workflowRow) {
        throw unprocessable("Workflow not found");
      }
      assertWorkflowRuntimeJwtConfigured();
      const refreshed = await refreshWorkflowAnalysis(workflowRow);
      const runRow = await db.insert(workflowRuns).values({
        companyId: workflowRow.companyId,
        workflowId,
        status: "queued",
        inputMarkdown: input.inputMarkdown,
      }).returning().then((rows) => rows[0] ?? null);
      if (!runRow) throw unprocessable("Failed to create workflow run");
      const phases = refreshed.analysis.pipelineDefinition.phases;
      if (phases.length > 0) {
        try {
          await db.insert(workflowRunPhases).values(
            phases.map((phase: typeof phases[number]) => ({
              companyId: workflowRow.companyId,
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
              },
            })),
          );
        } catch (err) {
          await db.delete(workflowRuns).where(eq(workflowRuns.id, runRow.id)).catch(() => {});
          throw err;
        }
      }
      void executeRun(runRow.id, {
        workflow: refreshed.workflow,
        analysis: refreshed.analysis,
      }).catch((err) => {
        void db.update(workflowRuns).set({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          finishedAt: new Date(),
          updatedAt: new Date(),
        }).where(and(eq(workflowRuns.id, runRow.id), notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled"])));
        logger.error({ err, runId: runRow.id, workflowId }, "workflow execution failed");
      });
      return toWorkflowRun(runRow);
    },

    getRunDetail: async (runId: string): Promise<WorkflowRunDetail | null> => {
      const runRow = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0] ?? null);
      if (!runRow) return null;
      const workflowRow = await db.select().from(workflows).where(eq(workflows.id, runRow.workflowId)).then((rows) => rows[0] ?? null);
      if (!workflowRow) return null;
      const phases = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, runId)).orderBy(asc(workflowRunPhases.ordinal));
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
        ...toWorkflowRun(runRow),
        workflow: {
          id: workflowRow.id,
          title: workflowRow.title,
          status: workflowRow.status,
          runnerType: workflowRow.runnerType as "google_adk",
        },
        phases: phases.map(toWorkflowPhase),
        handoffs: handoffs.map((h) => toWorkflowHandoff(h, bridgeStatusByHandoffId.get(h.id) ?? null)),
        deliverables: deliverables.map(toWorkflowDeliverableSummary),
      };
    },

    listRunDeliverables: async (runId: string) => {
      const rows = await db.select().from(workflowDeliverables).where(eq(workflowDeliverables.workflowRunId, runId)).orderBy(desc(workflowDeliverables.createdAt));
      return rows.map(toWorkflowDeliverableSummary);
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

    applyPhaseEvent: async (runId: string, event: WorkflowPhaseEvent) => {
      const existing = await db.select().from(workflowRunPhases).where(
        and(eq(workflowRunPhases.workflowRunId, runId), eq(workflowRunPhases.phaseKey, event.phaseKey)),
      ).then((rows) => rows[0] ?? null);
      const now = new Date();
      if (!existing) return null;
      const updated = await db.update(workflowRunPhases).set({
        status: event.status,
        label: event.label ?? existing.label,
        metadata: event.metadata ?? existing.metadata,
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
          notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled"]),
        ));
      }
      if (event.status === "awaiting_human") {
        await db.update(workflowRuns).set({ status: "awaiting_human", updatedAt: now }).where(and(
          eq(workflowRuns.id, runId),
          notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled"]),
        ));
      }
      return updated ? toWorkflowPhase(updated) : null;
    },

    createRuntimeHandoff: async (runId: string, input: CreateWorkflowHandoff) => {
      const runRow = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0] ?? null);
      if (!runRow) throw unprocessable("Workflow run not found");
      const now = new Date();
      await db.update(workflowRunPhases).set({
        status: "awaiting_human",
        updatedAt: now,
      }).where(and(
        eq(workflowRunPhases.workflowRunId, runId),
        eq(workflowRunPhases.phaseKey, input.phaseKey),
        notInArray(workflowRunPhases.status, ["succeeded", "failed", "cancelled"]),
      ));
      await db.update(workflowRuns).set({ status: "awaiting_human", updatedAt: now }).where(and(
        eq(workflowRuns.id, runId),
        notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled"]),
      ));
      const inserted = await db.insert(workflowHandoffs).values({
        companyId: runRow.companyId,
        workflowRunId: runId,
        phaseKey: input.phaseKey,
        kind: input.kind,
        status: "pending",
        promptMarkdown: input.promptMarkdown,
      }).returning().then((rows) => rows[0] ?? null);
      if (!inserted) throw unprocessable("Failed to create workflow handoff");
      return toWorkflowHandoff(inserted);
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
        notInArray(workflowRuns.status, ["succeeded", "failed", "cancelled"]),
      ));
      return updated ? toWorkflowHandoff(updated) : null;
    },
  };
}
