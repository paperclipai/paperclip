import type { DispatchRequest, RoleMapping } from "./types.js";

interface IssuesClient {
  create(input: Record<string, unknown>): Promise<{ id: string }>;
  requestWakeup(issueId: string, companyId: string, options: Record<string, unknown>): Promise<{ queued: boolean }>;
  documents: {
    upsert(input: Record<string, unknown>): Promise<void>;
  };
}

export interface DispatchResult {
  issueId: string;
  wakeupQueued: boolean;
}

export class Dispatcher {
  constructor(
    private issues: IssuesClient,
    private roleMapping: RoleMapping,
    private pluginId: string,
  ) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const { pipelineRunId, stage, companyId, parentIssueId, context } = request;

    if (stage.agent_role && !this.roleMapping[stage.agent_role]) {
      throw new Error(`CONFIGURATION_ERROR: no agent mapped for role "${stage.agent_role}"`);
    }

    const agentId = stage.agent_role ? this.roleMapping[stage.agent_role] : undefined;

    const description = context
      ? `## Pipeline Stage: ${stage.id}\n\n${context}`
      : `## Pipeline Stage: ${stage.id}`;

    const issue = await this.issues.create({
      companyId,
      parentId: parentIssueId,
      inheritExecutionWorkspaceFromIssueId: parentIssueId,
      title: `[pipeline] ${stage.id}`,
      description,
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      billingCode: `plugin:pipeline-engine:${pipelineRunId}`,
      originKind: `plugin:${this.pluginId}:stage`,
      originId: `${pipelineRunId}:${stage.id}`,
    });

    const wakeup = await this.issues.requestWakeup(issue.id, companyId, {
      reason: `plugin:pipeline-engine:${stage.id}`,
      contextSource: "plugin-pipeline-engine",
      idempotencyKey: `${pipelineRunId}:${stage.id}:${Date.now()}`,
    });

    return { issueId: issue.id, wakeupQueued: wakeup.queued };
  }
}
