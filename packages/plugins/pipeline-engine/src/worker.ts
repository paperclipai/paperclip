import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import { parsePipeline, validateDAG } from "./dag-parser.js";
import { Dispatcher } from "./dispatcher.js";
import { evaluateCondition, buildExpressionContext } from "./expression-engine.js";
import { extractOutput, loadSchema, validateOutput } from "./output-parser.js";
import { Router } from "./router.js";
import { StateMachine } from "./state-machine.js";
import { TriggerMatcher } from "./trigger-matcher.js";
import type { PipelineDefinition, PipelineEngineConfig, StageDefinition } from "./types.js";

let stateMachine: StateMachine;
let dispatcher: Dispatcher;
let router: Router;
let triggerMatcher: TriggerMatcher;
let pipelines: PipelineDefinition[] = [];

async function loadPipelines(ctx: PluginContext): Promise<PipelineDefinition[]> {
  const config = (await ctx.config.get()) as unknown as PipelineEngineConfig;
  const triggerLabels = config.trigger_labels ?? {};
  const loaded: PipelineDefinition[] = [];

  for (const [_labelName, pipelineName] of Object.entries(triggerLabels)) {
    const yamlContent = await ctx.state.get({ scopeKind: "instance", namespace: "pipeline", stateKey: `yaml:${pipelineName}` });
    if (yamlContent) {
      const pipeline = parsePipeline(yamlContent as string);
      const validation = validateDAG(pipeline);
      if (validation.valid) {
        loaded.push(pipeline);
      } else {
        ctx.logger.warn("Invalid pipeline definition", { pipelineName, errors: validation.errors });
      }
    }
  }

  return loaded;
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
  if (!mapping || typeof mapping !== "object") return [];
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
  const pipelineYaml = JSON.stringify(pipeline);

  await stateMachine.createRun({
    id: runId,
    companyId,
    parentIssueId,
    pipelineName: pipeline.name,
    pipelineVersion: 1,
    pipelineYaml,
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
  const run = await stateMachine.getRun(runId);
  if (!run || run.status !== "running") return;

  const stageRows = await stateMachine.getRunStages(runId);

  const skippedStages = await router.getSkippedStages(pipeline, stageRows, companyId);
  for (const stageDef of skippedStages) {
    const stageRow = stageRows.find((s) => s.stageId === stageDef.id);
    if (!stageRow) continue;
    await stateMachine.updateStageStatus(stageRow.id, "skipped");
  }

  const currentRows = skippedStages.length > 0
    ? await stateMachine.getRunStages(runId)
    : stageRows;

  const readyStages = await router.getReadyStages(pipeline, currentRows, companyId);

  for (const stageDef of readyStages) {
    const stageRow = currentRows.find((s) => s.stageId === stageDef.id);
    if (!stageRow) continue;

    if (stageDef.type === "gate") {
      await handleGateStage(ctx, runId, pipeline, stageDef, stageRow, companyId);
      continue;
    }

    if (!router.requiresAgentDispatch(stageDef)) {
      ctx.logger.warn("Stage type not dispatchable in this phase", { stageId: stageDef.id, type: stageDef.type });
      await stateMachine.updateStageStatus(stageRow.id, "failed");
      await stateMachine.setStageError(stageRow.id, `Stage type "${stageDef.type}" requires dynamic materialization (not yet supported)`);
      continue;
    }

    if (!stageDef.agent_role) {
      await stateMachine.updateStageStatus(stageRow.id, "failed");
      await stateMachine.setStageError(stageRow.id, `Stage "${stageDef.id}" has no agent_role configured`);
      continue;
    }

    await stateMachine.updateStageStatus(stageRow.id, "running");
    const result = await dispatcher.dispatch({
      pipelineRunId: runId,
      stage: stageDef,
      companyId,
      parentIssueId: run.parentIssueId,
    });
    await stateMachine.setStageSubIssueId(stageRow.id, result.issueId);
  }

  const updatedRows = await stateMachine.getRunStages(runId);
  const allDone = updatedRows.every((s) => s.status === "completed" || s.status === "skipped");
  if (allDone && updatedRows.length > 0) {
    await stateMachine.updateRunStatus(runId, "completed");
    ctx.logger.info("Pipeline completed", { runId });
  }
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

  const conditionMet = stageDef.condition ? await evaluateCondition(stageDef.condition, context) : true;

  if (conditionMet) {
    await stateMachine.updateStageStatus(stageRow.id, "completed");
    await advancePipeline(ctx, runId, pipeline, companyId);
  } else {
    await stateMachine.updateStageStatus(stageRow.id, "failed");
    await handleStageFailure(ctx, runId, pipeline, stageDef, stageRow.id, companyId);
  }
}

async function handleCommentEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const payload = event.payload as { issueId?: string; body?: string; commentId?: string };
  if (!payload.issueId || !payload.body) return;

  const stageRow = await stateMachine.getStageBySubIssueId(payload.issueId);
  if (!stageRow) return;

  const output = extractOutput(payload.body);
  if (!output) return;

  const run = await stateMachine.getRun(stageRow.pipelineRunId);
  if (!run) return;

  const pipeline = JSON.parse(run.pipelineYaml) as PipelineDefinition;
  const stageDef = pipeline.stages.find((s) => s.id === stageRow.stageId);
  if (!stageDef) return;

  if (stageDef.output_schema) {
    const schema = loadSchema(stageDef.output_schema);
    const validation = validateOutput(output, schema);
    if (!validation.valid) {
      await stateMachine.setStageError(stageRow.id, `malformed output: ${validation.error}`);
      await stateMachine.updateStageStatus(stageRow.id, "failed");
      await handleStageFailure(ctx, stageRow.pipelineRunId, pipeline, stageDef, stageRow.id, run.companyId);
      return;
    }
  }

  await stateMachine.setStageOutput(stageRow.id, output);
  await stateMachine.updateStageStatus(stageRow.id, "completed");

  ctx.logger.info("Stage completed", { stageId: stageRow.stageId, pipelineRunId: stageRow.pipelineRunId });

  if (stageDef.checkpoint) {
    await handleCheckpointCompletion(ctx, stageRow.pipelineRunId, pipeline, stageDef, output, run.companyId);
    return;
  }

  await advancePipeline(ctx, stageRow.pipelineRunId, pipeline, run.companyId);
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

  const downstreamDefs = pipeline.stages.filter((s) =>
    (s.depends_on ?? []).includes(checkpointStageDef.id),
  );
  const hasSubPipelines = downstreamDefs.some((s) => s.type === "sub-pipeline");

  if (hasSubPipelines) {
    ctx.logger.warn("Sub-pipeline materialization not yet implemented — pipeline paused", { runId });
    await stateMachine.updateRunStatus(runId, "paused");
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
  if (!stageRow) return;

  const targetStageId = stageDef.on_failure?.retry_with?.goto;
  const targetRow = targetStageId
    ? stageRows.find((s) => s.stageId === targetStageId)
    : undefined;

  const failureAction = router.evaluateFailure(stageDef, stageRow, targetRow ?? undefined);

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
    ctx.logger.warn("Pipeline escalated", { runId, stageId: stageDef.id });
    return;
  }

  if (failureAction.action === "goto" && failureAction.targetStageId) {
    const gotoTargetRow = stageRows.find((s) => s.stageId === failureAction.targetStageId);
    if (!gotoTargetRow) return;

    const targetDef = pipeline.stages.find((s) => s.id === failureAction.targetStageId);
    if (!targetDef) return;

    await stateMachine.incrementRetryCount(gotoTargetRow.id);

    const allStageIds = pipeline.stages.map((s) => s.id);
    const adjacency = new Map(pipeline.stages.map((s) => [s.id, s.depends_on ?? []]));
    await stateMachine.resetDownstreamStages(runId, failureAction.targetStageId, allStageIds, adjacency);

    const run = await stateMachine.getRun(runId);
    if (!run) return;

    await stateMachine.updateStageStatus(gotoTargetRow.id, "running");
    const result = await dispatcher.dispatch({
      pipelineRunId: runId,
      stage: targetDef,
      companyId,
      parentIssueId: run.parentIssueId,
      context: failureAction.body,
    });
    await stateMachine.setStageSubIssueId(gotoTargetRow.id, result.issueId);
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    const config = (await ctx.config.get()) as unknown as PipelineEngineConfig;

    stateMachine = new StateMachine(ctx.db as any);
    dispatcher = new Dispatcher(ctx.issues as any, config.role_mapping ?? {}, ctx.manifest.id);
    router = new Router();

    pipelines = await loadPipelines(ctx);
    triggerMatcher = new TriggerMatcher(pipelines);

    ctx.logger.info("Pipeline engine initialized", { pipelineCount: pipelines.length });

    ctx.events.on("issue.created", async (event: PluginEvent) => {
      await handleIssueEvent(ctx, event);
    });

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      await handleIssueEvent(ctx, event);
    });

    ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
      await handleCommentEvent(ctx, event);
    });
  },

  async onConfigChanged(newConfig: Record<string, unknown>) {
    const config = newConfig as unknown as PipelineEngineConfig;
    triggerMatcher = new TriggerMatcher(pipelines);
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
