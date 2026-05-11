import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import { parsePipeline, validateDAG } from "./dag-parser.js";
import { Dispatcher } from "./dispatcher.js";
import { buildExpressionContext, evaluateCondition } from "./expression-engine.js";
import { buildAdjacencyFromEdges } from "./edge-utils.js";
import { extractOutput, loadSchema, validateOutput } from "./output-parser.js";
import { Router } from "./router.js";
import { StateMachine } from "./state-machine.js";
import { TriggerMatcher } from "./trigger-matcher.js";
import type { PipelineDefinition, PipelineEngineConfig, StageDefinition } from "./types.js";

let pluginCtx: PluginContext;
let stateMachine: StateMachine;
let dispatcher: Dispatcher;
let router: Router;
let triggerMatcher: TriggerMatcher;
let pipelines: PipelineDefinition[] = [];

const PIPELINE_REGISTRY_KEY = { scopeKind: "instance" as const, namespace: "pipeline", stateKey: "registry" };

async function getPipelineRegistry(ctx: PluginContext): Promise<string[]> {
  const raw = await ctx.state.get(PIPELINE_REGISTRY_KEY);
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) return parsed; } catch {}
  }
  return [];
}

async function loadPipelines(ctx: PluginContext): Promise<PipelineDefinition[]> {
  const config = (await ctx.config.get()) as unknown as PipelineEngineConfig;
  const triggerLabels = config.trigger_labels ?? {};
  const loaded: PipelineDefinition[] = [];

  // Collect pipeline names from config AND registry
  const pipelineNames = new Set(Object.values(triggerLabels));
  const registry = await getPipelineRegistry(ctx);
  for (const name of registry) pipelineNames.add(name);

  for (const pipelineName of pipelineNames) {
    const jsonContent = await ctx.state.get({ scopeKind: "instance", namespace: "pipeline", stateKey: `pipeline:${pipelineName}` });
    if (jsonContent) {
      const pipeline = safeParsePipelineJson(jsonContent);
      if (pipeline) {
        const validation = validateDAG(pipeline);
        if (validation.valid) {
          loaded.push(pipeline);
        } else {
          ctx.logger.warn("Invalid pipeline definition", { pipelineName, errors: validation.errors });
        }
      }
    }
  }

  return loaded;
}

async function buildStageContext(
  ctx: PluginContext,
  parentIssueId: string,
  companyId: string,
  stageDef: StageDefinition,
  stageRows: Array<{ stageId: string; status: string; output: Record<string, unknown> | null }>,
  pipeline: PipelineDefinition,
): Promise<string> {
  const sections: string[] = [];

  const parentIssue = await ctx.issues.get(parentIssueId, companyId);
  if (parentIssue) {
    sections.push(`## Original Request\n\n**${parentIssue.title}**\n\n${parentIssue.description ?? ""}`);
  }

  // Use incoming edges to find upstream stages instead of depends_on
  const incomingEdgeSourceIds = (pipeline.edges ?? [])
    .filter((e) => e.to === stageDef.id && e.type !== "error")
    .map((e) => e.from);

  if (incomingEdgeSourceIds.length > 0) {
    const upstreamOutputs: string[] = [];
    for (const sourceId of incomingEdgeSourceIds) {
      const sourceRow = stageRows.find((s) => s.stageId === sourceId);
      if (sourceRow?.output) {
        upstreamOutputs.push(`### ${sourceId} output\n\n\`\`\`json\n${JSON.stringify(sourceRow.output, null, 2)}\n\`\`\``);
      }
    }
    if (upstreamOutputs.length > 0) {
      sections.push(`## Upstream Stage Results\n\n${upstreamOutputs.join("\n\n")}`);
    }
  }

  return sections.join("\n\n---\n\n");
}

async function handleIssueEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue) return;

  const existingRun = await stateMachine.getActiveRunForIssue(issueId, event.companyId);
  if (existingRun) return;

  const issueLabelIds = issue.labelIds;
  if (!issueLabelIds || issueLabelIds.length === 0) return;

  const labelNames = await resolveLabelNames(ctx, issueLabelIds, event.companyId);
  const matchedPipeline = triggerMatcher.match(labelNames);
  if (!matchedPipeline) return;

  await materializePipeline(ctx, matchedPipeline, issueId, event.companyId);
}

async function resolveLabelNames(ctx: PluginContext, labelIds: string[], companyId: string): Promise<string[]> {
  const mapping = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: "label-name-map" });
  if (!mapping || typeof mapping !== "object") {
    ctx.logger.warn("Label name map not found or invalid", { companyId });
    return [];
  }
  const map = mapping as Record<string, string>;
  return labelIds.map((id) => map[id]).filter(Boolean);
}

async function materializePipeline(
  ctx: PluginContext,
  pipeline: PipelineDefinition,
  parentIssueId: string,
  companyId: string,
): Promise<void> {
  const runId = randomUUID();
  const pipelineJson = JSON.stringify(pipeline);

  await stateMachine.createRun({
    id: runId,
    companyId,
    parentIssueId,
    pipelineName: pipeline.name,
    pipelineVersion: 1,
    pipelineYaml: pipelineJson,
  });

  for (const stage of pipeline.stages) {
    await stateMachine.createStage({
      id: randomUUID(),
      pipelineRunId: runId,
      stageId: stage.id,
    });
  }

  ctx.logger.info("Pipeline materialized", { runId, pipelineName: pipeline.name, parentIssueId });

  await advancePipeline(ctx, runId, pipeline, companyId);
}

async function advancePipeline(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  companyId: string,
): Promise<void> {
  const MAX_ITERATIONS = 50;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const run = await stateMachine.getRun(runId);
    if (!run || run.status !== "running") return;

    const locked = await stateMachine.tryAdvisoryLock(runId);
    if (!locked) {
      ctx.logger.debug("Pipeline advancement already in progress", { runId });
      return;
    }

    try {
      const stageRows = await stateMachine.getRunStages(runId);

      const skippedStages = await router.getSkippedStages(pipeline, stageRows, companyId);
      for (const stageDef of skippedStages) {
        const stageRow = stageRows.find((s) => s.stageId === stageDef.id);
        if (!stageRow) continue;
        await stateMachine.updateStageStatus(stageRow.id, "skipped");
        ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "skipped" });
      }

      const currentRows = skippedStages.length > 0
        ? await stateMachine.getRunStages(runId)
        : stageRows;

      const readyStages = await router.getReadyStages(pipeline, currentRows, companyId);
      if (readyStages.length === 0) {
        const allDone = currentRows.every((s) => s.status === "completed" || s.status === "skipped");
        const anyFailed = currentRows.some((s) => s.status === "failed");
        if (allDone && currentRows.length > 0) {
          await stateMachine.updateRunStatus(runId, "completed");
          ctx.streams.emit("run-progress", { runId, stageId: null, status: "completed" });
          ctx.logger.info("Pipeline completed", { runId });
        } else if (anyFailed && !currentRows.some((s) => s.status === "running" || s.status === "pending")) {
          await stateMachine.updateRunStatus(runId, "failed");
          ctx.streams.emit("run-progress", { runId, stageId: null, status: "failed" });
          ctx.logger.info("Pipeline failed — no recoverable stages remain", { runId });
        }
        return;
      }

      let advancedGate = false;

      for (const stageDef of readyStages) {
        const stageRow = currentRows.find((s) => s.stageId === stageDef.id);
        if (!stageRow) continue;

        if (stageDef.type === "gate") {
          await handleGateStage(ctx, runId, pipeline, stageDef, stageRow, companyId);
          advancedGate = true;
          continue;
        }

        if (!router.requiresAgentDispatch(stageDef)) {
          ctx.logger.warn("Stage type not dispatchable", { stageId: stageDef.id, type: stageDef.type });
          await stateMachine.updateStageStatus(stageRow.id, "failed");
          await stateMachine.setStageError(stageRow.id, `Stage type "${stageDef.type}" requires dynamic materialization (not yet supported)`);
          ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "failed" });
          continue;
        }

        const agentRole = "agent_role" in stageDef ? stageDef.agent_role : undefined;
        if (!agentRole) {
          await stateMachine.updateStageStatus(stageRow.id, "failed");
          await stateMachine.setStageError(stageRow.id, `Stage "${stageDef.id}" has no agent_role configured`);
          ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "failed" });
          continue;
        }

        const claimed = await stateMachine.claimStageForDispatch(stageRow.id);
        if (!claimed) continue;

        ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "running" });

        try {
          const context = await buildStageContext(ctx, run.parentIssueId, companyId, stageDef, currentRows, pipeline);
          const result = await dispatcher.dispatch({
            pipelineRunId: runId,
            stage: stageDef,
            companyId,
            parentIssueId: run.parentIssueId,
            context,
          });
          await stateMachine.setStageSubIssueId(stageRow.id, result.issueId);

          if (!result.wakeupQueued) {
            ctx.logger.warn("Agent wakeup not queued — stage may be delayed", { stageId: stageDef.id, issueId: result.issueId });
          }
        } catch (err) {
          ctx.logger.error("Dispatch failed for stage", { stageId: stageDef.id, error: String(err) });
          await stateMachine.updateStageStatus(stageRow.id, "failed");
          await stateMachine.setStageError(stageRow.id, `Dispatch failed: ${String(err)}`);
          ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "failed" });
          await handleStageFailure(ctx, runId, pipeline, stageDef, stageRow.id, companyId);
        }
      }

      if (!advancedGate) return;
    } finally {
      await stateMachine.releaseAdvisoryLock(runId);
    }
  }

  ctx.logger.error("Pipeline advancement hit iteration limit — possible infinite loop", { runId });
}

async function handleGateStage(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  stageDef: StageDefinition,
  stageRow: { id: string },
  companyId: string,
): Promise<void> {
  const stageRows = await stateMachine.getRunStages(runId);

  const context = buildExpressionContext(
    stageRows.map((s) => ({ stageId: s.stageId, status: s.status, output: s.output, retryCount: s.retryCount })),
    pipeline.name,
    1,
    "",
    companyId,
  );

  // Gate condition: evaluate the outgoing edge conditions
  // (Gates pass if any outgoing edge condition is truthy or no condition exists)
  const outgoingEdges = (pipeline.edges ?? []).filter((e) => e.from === stageDef.id && e.type !== "error");
  let conditionMet = outgoingEdges.length === 0; // no edges = pass-through

  for (const edge of outgoingEdges) {
    if (!edge.when) {
      conditionMet = true;
      break;
    }
    try {
      const result = await evaluateCondition(edge.when, context);
      if (result) {
        conditionMet = true;
        break;
      }
    } catch (err) {
      ctx.logger.error("Gate edge condition evaluation failed", { stageId: stageDef.id, edgeId: edge.id, error: String(err) });
    }
  }

  if (conditionMet) {
    await stateMachine.updateStageStatus(stageRow.id, "completed");
    ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "completed" });
  } else {
    await stateMachine.updateStageStatus(stageRow.id, "failed");
    ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "failed" });
    await handleStageFailure(ctx, runId, pipeline, stageDef, stageRow.id, companyId);
  }
}

async function handleCommentEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const issueId = event.entityId;
  const payload = event.payload as { commentId?: string; bodySnippet?: string };
  if (!issueId || !payload.commentId) return;

  const stageRow = await stateMachine.getStageBySubIssueId(issueId);
  if (!stageRow) return;

  const comments = await ctx.issues.listComments(issueId, event.companyId);
  const comment = comments.find((c) => c.id === payload.commentId);
  if (!comment) return;

  const body = comment.body;

  const extraction = extractOutput(body);
  if (!extraction.found) return;

  if (extraction.parseError) {
    ctx.logger.warn("Stage output JSON parse failed", { stageId: stageRow.stageId, error: extraction.parseError });
    await stateMachine.setStageError(stageRow.id, extraction.parseError);
    await stateMachine.updateStageStatus(stageRow.id, "failed");
    ctx.streams.emit("run-progress", { runId: stageRow.pipelineRunId, stageId: stageRow.stageId, status: "failed" });
    const run = await stateMachine.getRun(stageRow.pipelineRunId);
    if (run) {
      const pipeline = safeParsePipelineJson(run.pipelineYaml);
      if (pipeline) {
        const stageDef = pipeline.stages.find((s) => s.id === stageRow.stageId);
        if (stageDef) {
          await handleStageFailure(ctx, stageRow.pipelineRunId, pipeline, stageDef, stageRow.id, run.companyId);
        }
      }
    }
    return;
  }

  const output = extraction.data!;

  const run = await stateMachine.getRun(stageRow.pipelineRunId);
  if (!run) return;

  const pipeline = safeParsePipelineJson(run.pipelineYaml);
  if (!pipeline) {
    ctx.logger.error("Corrupted pipeline JSON in database", { pipelineRunId: stageRow.pipelineRunId });
    await stateMachine.updateRunStatus(stageRow.pipelineRunId, "failed");
    return;
  }

  const stageDef = pipeline.stages.find((s) => s.id === stageRow.stageId);
  if (!stageDef) return;

  const outputSchema = "output_schema" in stageDef ? stageDef.output_schema : undefined;
  if (outputSchema) {
    let schema: object;
    try {
      schema = loadSchema(outputSchema);
    } catch (err) {
      ctx.logger.error("Failed to load schema", { schema: outputSchema, error: String(err) });
      await stateMachine.setStageError(stageRow.id, `Schema load failed: ${String(err)}`);
      await stateMachine.updateStageStatus(stageRow.id, "failed");
      ctx.streams.emit("run-progress", { runId: run.id, stageId: stageRow.stageId, status: "failed" });
      await handleStageFailure(ctx, stageRow.pipelineRunId, pipeline, stageDef, stageRow.id, run.companyId);
      return;
    }

    const validation = validateOutput(output, schema);
    if (!validation.valid) {
      await stateMachine.setStageError(stageRow.id, `malformed output: ${validation.error}`);
      await stateMachine.updateStageStatus(stageRow.id, "failed");
      ctx.streams.emit("run-progress", { runId: run.id, stageId: stageRow.stageId, status: "failed" });
      await handleStageFailure(ctx, stageRow.pipelineRunId, pipeline, stageDef, stageRow.id, run.companyId);
      return;
    }
  }

  await stateMachine.setStageOutput(stageRow.id, output);
  await stateMachine.updateStageStatus(stageRow.id, "completed");
  ctx.streams.emit("run-progress", { runId: run.id, stageId: stageRow.stageId, status: "completed" });

  ctx.logger.info("Stage completed", { stageId: stageRow.stageId, pipelineRunId: stageRow.pipelineRunId });

  if (stageDef.checkpoint) {
    await handleCheckpointCompletion(ctx, stageRow.pipelineRunId, pipeline, stageDef, output, run.companyId);
    return;
  }

  await advancePipeline(ctx, stageRow.pipelineRunId, pipeline, run.companyId);
}

function safeParsePipelineJson(content: unknown): PipelineDefinition | null {
  try {
    if (typeof content === "object" && content !== null) return content as PipelineDefinition;
    if (typeof content === "string") return JSON.parse(content) as PipelineDefinition;
    return null;
  } catch {
    return null;
  }
}

async function handleCheckpointCompletion(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  checkpointStageDef: StageDefinition,
  output: Record<string, unknown>,
  companyId: string,
): Promise<void> {
  ctx.logger.info("Checkpoint stage completed — dynamic downstream planning", {
    runId,
    stageId: checkpointStageDef.id,
    outputKeys: Object.keys(output),
  });

  // Find downstream stages via outgoing edges
  const outgoingEdges = (pipeline.edges ?? []).filter(
    (e) => e.from === checkpointStageDef.id && e.type !== "error",
  );
  const downstreamDefs = pipeline.stages.filter((s) =>
    outgoingEdges.some((e) => e.to === s.id),
  );
  const hasSubPipelines = downstreamDefs.some((s) => s.type === "sub-pipeline");

  if (hasSubPipelines) {
    ctx.logger.warn("Sub-pipeline materialization not yet implemented — pipeline paused", { runId });
    await stateMachine.updateRunStatus(runId, "paused");
    ctx.streams.emit("run-progress", { runId, stageId: checkpointStageDef.id, status: "paused" });
    return;
  }

  await advancePipeline(ctx, runId, pipeline, companyId);
}

async function handleStageFailure(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  stageDef: StageDefinition,
  stageRowId: string,
  companyId: string,
): Promise<void> {
  const stageRows = await stateMachine.getRunStages(runId);
  const stageRow = stageRows.find((s) => s.id === stageRowId);
  if (!stageRow) {
    ctx.logger.error("handleStageFailure: stage row not found", { stageRowId, runId });
    return;
  }

  // Find error edge targets to determine target stage for retry
  const errorEdges = (pipeline.edges ?? []).filter((e) => e.from === stageDef.id && e.type === "error");
  const targetStageId = errorEdges.length > 0 ? errorEdges[0].to : undefined;
  const targetRow = targetStageId
    ? stageRows.find((s) => s.stageId === targetStageId)
    : undefined;

  const failureAction = router.evaluateFailure(pipeline, stageDef.id, stageRow, targetRow ?? undefined);

  if (failureAction.action === "escalate") {
    await stateMachine.updateRunStatus(runId, "escalated");
    const run = await stateMachine.getRun(runId);
    if (run) {
      await ctx.issues.createComment(
        run.parentIssueId,
        `Pipeline escalated: stage "${stageDef.id}" failed after ${(targetRow ?? stageRow).retryCount} retries.`,
        companyId,
        {},
      );
    }
    ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "escalated" });
    ctx.logger.warn("Pipeline escalated", { runId, stageId: stageDef.id });
    return;
  }

  const gotoTargetRow = stageRows.find((s) => s.stageId === failureAction.targetStageId);
  if (!gotoTargetRow) {
    ctx.logger.error("Retry target stage not found — escalating", { runId, targetStageId: failureAction.targetStageId });
    await stateMachine.updateRunStatus(runId, "escalated");
    return;
  }

  const targetDef = pipeline.stages.find((s) => s.id === failureAction.targetStageId);
  if (!targetDef) {
    ctx.logger.error("Retry target stage definition not found — escalating", { runId, targetStageId: failureAction.targetStageId });
    await stateMachine.updateRunStatus(runId, "escalated");
    return;
  }

  await stateMachine.incrementRetryCount(gotoTargetRow.id);

  // Build adjacency from forward edges for downstream reset
  const adjacency = buildAdjacencyFromEdges(pipeline.edges ?? []);
  const allStageIds = pipeline.stages.map((s) => s.id);
  await stateMachine.resetDownstreamStages(runId, failureAction.targetStageId, allStageIds, adjacency);

  const run = await stateMachine.getRun(runId);
  if (!run) return;

  const claimed = await stateMachine.claimStageForDispatch(gotoTargetRow.id);
  if (!claimed) return;

  ctx.streams.emit("run-progress", { runId, stageId: failureAction.targetStageId, status: "running" });

  try {
    const result = await dispatcher.dispatch({
      pipelineRunId: runId,
      stage: targetDef,
      companyId,
      parentIssueId: run.parentIssueId,
      context: failureAction.body,
    });
    await stateMachine.setStageSubIssueId(gotoTargetRow.id, result.issueId);
  } catch (err) {
    ctx.logger.error("Retry dispatch failed — escalating", { runId, stageId: targetDef.id, error: String(err) });
    await stateMachine.updateStageStatus(gotoTargetRow.id, "failed");
    await stateMachine.setStageError(gotoTargetRow.id, `Retry dispatch failed: ${String(err)}`);
    ctx.streams.emit("run-progress", { runId, stageId: targetDef.id, status: "failed" });
    await stateMachine.updateRunStatus(runId, "escalated");
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    const config = (await ctx.config.get()) as unknown as PipelineEngineConfig;

    stateMachine = new StateMachine(ctx.db as any);
    dispatcher = new Dispatcher(ctx.issues as any, config.role_mapping ?? {}, ctx.manifest.id, ctx.agents as any);
    router = new Router();

    pipelines = await loadPipelines(ctx);
    triggerMatcher = new TriggerMatcher(pipelines);

    ctx.logger.info("Pipeline engine initialized", { pipelineCount: pipelines.length });

    // Data handlers for UI
    ctx.data.register("list-pipelines", async (_params) => {
      return {
        pipelines: pipelines.map((p) => ({
          name: p.name,
          trigger: p.trigger,
          stageCount: p.stages.length,
          edgeCount: p.edges.length,
          description: p.description,
        })),
      };
    });

    ctx.data.register("get-pipeline", async (params) => {
      const name = params.name as string | undefined;
      if (!name) return null;
      const pipeline = pipelines.find((p) => p.name === name);
      if (!pipeline) return null;
      return { pipeline };
    });

    ctx.data.register("list-runs", async (params) => {
      const companyId = params.companyId as string | undefined;
      if (!companyId) return { runs: [] };
      const runs = await stateMachine.listRuns(companyId, {
        issueId: params.issueId as string | undefined,
        status: params.status as any,
        limit: params.limit as number | undefined,
      });
      return { runs };
    });

    ctx.data.register("get-run", async (params) => {
      const runId = params.runId as string | undefined;
      if (!runId) return null;
      const run = await stateMachine.getRun(runId);
      if (!run) return null;
      const stages = await stateMachine.getRunStages(runId);
      return { run, stages };
    });

    ctx.data.register("list-agents", async (params) => {
      const companyId = params.companyId as string | undefined;
      if (!companyId) return { agents: [] };
      const agents = await ctx.agents.list({ companyId });
      return { agents };
    });

    ctx.data.register("list-schemas", async () => {
      const schemasDir = resolve(dirname(fileURLToPath(import.meta.url)), "../schemas");
      try {
        const files = readdirSync(schemasDir);
        const schemas = files
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.replace(/\.json$/, ""));
        return { schemas };
      } catch {
        return { schemas: [] };
      }
    });

    // Action handlers for UI
    ctx.actions.register("save-pipeline", async (params) => {
      const name = params.name as string | undefined;
      const content = params.content as string | undefined;
      if (!name || !content) throw new Error("name and content required");

      // Validate the pipeline JSON before saving
      const pipeline = parsePipeline(content);
      const validation = validateDAG(pipeline);
      if (!validation.valid) {
        throw new Error(`Invalid pipeline: ${validation.errors.join("; ")}`);
      }

      await ctx.state.set({ scopeKind: "instance", namespace: "pipeline", stateKey: `pipeline:${name}` }, content);
      const registry = await getPipelineRegistry(ctx);
      if (!registry.includes(name)) {
        await ctx.state.set(PIPELINE_REGISTRY_KEY, [...registry, name]);
      }
      pipelines = await loadPipelines(ctx);
      triggerMatcher = new TriggerMatcher(pipelines);
      return { success: true, pipelineName: name };
    });

    ctx.actions.register("delete-pipeline", async (params) => {
      const name = params.name as string | undefined;
      if (!name) throw new Error("name required");
      await ctx.state.delete({ scopeKind: "instance", namespace: "pipeline", stateKey: `pipeline:${name}` });
      const registry = await getPipelineRegistry(ctx);
      await ctx.state.set(PIPELINE_REGISTRY_KEY, registry.filter((n) => n !== name));
      pipelines = await loadPipelines(ctx);
      triggerMatcher = new TriggerMatcher(pipelines);
      return { success: true };
    });

    ctx.actions.register("trigger-run", async (params) => {
      const companyId = params.companyId as string | undefined;
      const issueId = params.issueId as string | undefined;
      const pipelineName = params.pipelineName as string | undefined;
      if (!companyId || !issueId || !pipelineName) throw new Error("companyId, issueId, and pipelineName required");

      const pipeline = pipelines.find((p) => p.name === pipelineName);
      if (!pipeline) throw new Error(`Pipeline "${pipelineName}" not found`);

      const existing = await stateMachine.getActiveRunForIssue(issueId, companyId);
      if (existing) throw new Error(`Active run already exists for issue ${issueId}`);

      await materializePipeline(ctx, pipeline, issueId, companyId);
      return { success: true };
    });

    ctx.actions.register("cancel-run", async (params) => {
      const runId = params.runId as string | undefined;
      if (!runId) throw new Error("runId required");
      const run = await stateMachine.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      await stateMachine.cancelRun(runId);
      ctx.streams.emit("run-progress", { runId, stageId: null, status: "cancelled" });
      return { success: true };
    });

    ctx.events.on("issue.created", async (event: PluginEvent) => {
      try {
        await handleIssueEvent(ctx, event);
      } catch (err) {
        ctx.logger.error("Unhandled error in issue.created handler", {
          entityId: event.entityId,
          companyId: event.companyId,
          error: String(err),
          stack: (err as Error).stack,
        });
      }
    });

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      try {
        await handleIssueEvent(ctx, event);
      } catch (err) {
        ctx.logger.error("Unhandled error in issue.updated handler", {
          entityId: event.entityId,
          companyId: event.companyId,
          error: String(err),
          stack: (err as Error).stack,
        });
      }
    });

    ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
      try {
        await handleCommentEvent(ctx, event);
      } catch (err) {
        ctx.logger.error("Unhandled error in issue.comment.created handler", {
          entityId: event.entityId,
          companyId: event.companyId,
          error: String(err),
          stack: (err as Error).stack,
        });
      }
    });
  },

  async onConfigChanged(newConfig: Record<string, unknown>) {
    pipelines = await loadPipelines(pluginCtx);
    triggerMatcher = new TriggerMatcher(pipelines);
    const config = newConfig as unknown as PipelineEngineConfig;
    dispatcher = new Dispatcher(pluginCtx.issues as any, config.role_mapping ?? {}, pluginCtx.manifest.id, pluginCtx.agents as any);
    pluginCtx.logger.info("Pipeline engine config reloaded", { pipelineCount: pipelines.length });
  },

  async onApiRequest(input) {
    if (input.routeKey === "run-status") {
      const runId = input.params?.runId;
      if (!runId) return { status: 400, body: { error: "runId required" } };
      const run = await stateMachine.getRun(runId);
      if (!run) return { status: 404, body: { error: "not found" } };
      const stages = await stateMachine.getRunStages(runId);
      return { status: 200, body: { run, stages } };
    }
    if (input.routeKey === "pipelines") {
      return { status: 200, body: { pipelines: pipelines.map((p) => ({ name: p.name, trigger: p.trigger, stageCount: p.stages.length })) } };
    }
    return { status: 404, body: { error: "unknown route" } };
  },
});

runWorker(plugin, import.meta.url);
