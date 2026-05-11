import type { CreateIssueInput, DispatchRequest, RoleMapping, WakeupOptions } from "./types.js";
import { loadSchema } from "./output-parser.js";

export interface IssuesClient {
  create(input: CreateIssueInput): Promise<{ id: string }>;
  requestWakeup(issueId: string, companyId: string, options: WakeupOptions): Promise<{ queued: boolean }>;
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

    const agentRole = "agent_role" in stage ? stage.agent_role : undefined;

    if (agentRole && !this.roleMapping[agentRole]) {
      throw new Error(`CONFIGURATION_ERROR: no agent mapped for role "${agentRole}"`);
    }

    const agentId = agentRole ? this.roleMapping[agentRole] : undefined;

    const outputSchema = "output_schema" in stage ? stage.output_schema : undefined;
    const outputInstructions = this.buildOutputInstructions(outputSchema);

    const description = context
      ? `## Pipeline Stage: ${stage.id}\n\n${context}${outputInstructions}`
      : `## Pipeline Stage: ${stage.id}${outputInstructions}`;

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

  private buildOutputInstructions(outputSchema: string | undefined): string {
    const format = `\n\n---\n### Output Format\nWhen you have completed this task, post a comment containing your structured result in this exact format:\n\n\`\`\`\n<!-- pipeline-output -->\n\\\`\\\`\\\`json\n{ ... your JSON result ... }\n\\\`\\\`\\\`\n\`\`\``;

    if (!outputSchema) return format;

    let schemaJson: string;
    try {
      const schema = loadSchema(outputSchema);
      schemaJson = JSON.stringify(schema, null, 2);
    } catch {
      return `${format}\n\nThe JSON must conform to schema: \`${outputSchema}\``;
    }

    return `${format}\n\n### Required Schema: \`${outputSchema}\`\n\n\`\`\`json\n${schemaJson}\n\`\`\``;
  }
}
