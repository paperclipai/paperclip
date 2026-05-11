import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { parsePipeline, validateDAG } from "../dag-parser.js";
import { Dispatcher } from "../dispatcher.js";
import { extractOutput, validateOutput, loadSchema, setSchemasDir } from "../output-parser.js";
import { Router } from "../router.js";
import { StateMachine } from "../state-machine.js";
import { TriggerMatcher } from "../trigger-matcher.js";
import type { PipelineStage } from "../types.js";

const FEATURE_YAML = `
name: feature
description: Full feature development
trigger:
  label: "pipeline:feature"
stages:
  - id: spec-review
    type: classifier
    agent_role: spec-reviewer
    output_schema: spec-review-output
  - id: implement
    type: worker
    agent_role: code-writer
    depends_on: [spec-review]
    condition: "stages.\\"spec-review\\".output.status = 'approved'"
  - id: validate
    type: worker
    agent_role: validator
    depends_on: [implement]
    on_failure:
      retry_with:
        goto: implement
        body: "Fix: {{ output.errors }}"
        max_retries: 2
`;

function createMockIssues() {
  let issueCounter = 0;
  return {
    create: vi.fn().mockImplementation(async () => ({ id: `issue-${++issueCounter}` })),
    requestWakeup: vi.fn().mockResolvedValue({ queued: true }),
    documents: { upsert: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("integration: end-to-end pipeline flow", () => {
  beforeAll(() => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    setSchemasDir(resolve(__dirname, "../../schemas"));
  });

  it("triggers pipeline, dispatches stages, processes output, and advances", async () => {
    const pipeline = parsePipeline(FEATURE_YAML);
    const validation = validateDAG(pipeline);
    expect(validation.valid).toBe(true);

    const matcher = new TriggerMatcher([pipeline]);
    const matched = matcher.match(["pipeline:feature", "priority:high"]);
    expect(matched).not.toBeNull();
    expect(matched!.name).toBe("feature");

    const router = new Router();
    const initialStages: PipelineStage[] = [
      { id: "row-1", pipelineRunId: "run-1", stageId: "spec-review", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
      { id: "row-2", pipelineRunId: "run-1", stageId: "implement", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
      { id: "row-3", pipelineRunId: "run-1", stageId: "validate", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
    ];

    const ready = await router.getReadyStages(pipeline, initialStages, "company-1");
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe("spec-review");

    const issues = createMockIssues();
    const dispatcher = new Dispatcher(issues as any, { "spec-reviewer": "agent-1", "code-writer": "agent-2", "validator": "agent-3" }, "paperclipai.pipeline-engine");
    const dispatchResult = await dispatcher.dispatch({
      pipelineRunId: "run-1",
      stage: ready[0],
      companyId: "company-1",
      parentIssueId: "parent-1",
    });
    expect(dispatchResult.issueId).toBe("issue-1");

    const commentBody = `Done reviewing.\n\n<!-- pipeline-output -->\n\`\`\`json\n{"status": "approved", "completeness_score": 0.95}\n\`\`\``;
    const output = extractOutput(commentBody);
    expect(output).not.toBeNull();
    expect(output!.status).toBe("approved");

    const schema = loadSchema("spec-review-output");
    const validated = validateOutput(output!, schema);
    expect(validated.valid).toBe(true);

    const afterSpecReview: PipelineStage[] = [
      { ...initialStages[0], status: "completed", output: { status: "approved", completeness_score: 0.95 } },
      { ...initialStages[1] },
      { ...initialStages[2] },
    ];
    const nextReady = await router.getReadyStages(pipeline, afterSpecReview, "company-1");
    expect(nextReady).toHaveLength(1);
    expect(nextReady[0].id).toBe("implement");

    const failedValidateStage = { ...initialStages[2], status: "failed" as const, output: { errors: ["test_a failed"] }, retryCount: 0 };
    const implementTargetRow = { ...initialStages[1], status: "completed" as const, retryCount: 0 };
    const failureAction = router.evaluateFailure(pipeline.stages[2], failedValidateStage, implementTargetRow);
    expect(failureAction.action).toBe("goto");
    expect(failureAction.targetStageId).toBe("implement");
    expect(failureAction.body).toContain("test_a failed");

    const maxRetriedTarget = { ...implementTargetRow, retryCount: 2 };
    const escalateAction = router.evaluateFailure(pipeline.stages[2], failedValidateStage, maxRetriedTarget);
    expect(escalateAction.action).toBe("escalate");
  });

  it("checkpoint with downstream sub-pipeline stages blocks advancement", async () => {
    const checkpointPipeline = parsePipeline(`
name: checkpoint-test
description: Test checkpoint pause behavior
trigger:
  label: "pipeline:checkpoint-test"
stages:
  - id: decompose
    type: classifier
    agent_role: decomposer
    output_schema: decomposition-output
    checkpoint: true
  - id: write-tests
    type: sub-pipeline
    pipeline: test-writing
    per_task: true
    depends_on: [decompose]
  - id: implement
    type: sub-pipeline
    pipeline: implementation
    per_task: true
    depends_on: [write-tests]
`);
    expect(validateDAG(checkpointPipeline).valid).toBe(true);

    const router = new Router();

    const stagesAfterCheckpoint: PipelineStage[] = [
      { id: "row-1", pipelineRunId: "run-2", stageId: "decompose", subIssueId: null, status: "completed", retryCount: 0, output: { tasks: [] }, error: null, startedAt: null, completedAt: null },
      { id: "row-2", pipelineRunId: "run-2", stageId: "write-tests", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
      { id: "row-3", pipelineRunId: "run-2", stageId: "implement", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
    ];

    const ready = await router.getReadyStages(checkpointPipeline, stagesAfterCheckpoint, "company-1");
    expect(ready).toHaveLength(0);
  });
});
