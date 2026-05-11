import type { CreateIssueInput, DispatchRequest, RoleMapping, WakeupOptions } from "./types.js";
import { loadSchema } from "./output-parser.js";

export interface AgentsClient {
  list(input: { companyId: string; status?: string; limit?: number; offset?: number }): Promise<Array<{ id: string; name: string }>>;
}

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

function normalizeRoleName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, "");
}

export class Dispatcher {
  private agentNameCache = new Map<string, Map<string, string>>();

  constructor(
    private issues: IssuesClient,
    private roleMapping: RoleMapping,
    private pluginId: string,
    private agents?: AgentsClient,
  ) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const { pipelineRunId, stage, companyId, parentIssueId, context } = request;

    const agentRole = "agent_role" in stage ? stage.agent_role : undefined;

    const agentId = agentRole ? await this.resolveAgent(agentRole, companyId) : undefined;

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

  private async resolveAgent(agentRole: string, companyId: string): Promise<string> {
    if (this.roleMapping[agentRole]) {
      return this.roleMapping[agentRole];
    }

    if (!this.agents) {
      throw new Error(`CONFIGURATION_ERROR: no agent mapped for role "${agentRole}"`);
    }

    let nameMap = this.agentNameCache.get(companyId);
    if (!nameMap) {
      const agents = await this.agents.list({ companyId });
      nameMap = new Map<string, string>();
      for (const agent of agents) {
        nameMap.set(normalizeRoleName(agent.name), agent.id);
      }
      this.agentNameCache.set(companyId, nameMap);
    }

    const normalized = normalizeRoleName(agentRole);
    const agentId = nameMap.get(normalized);
    if (!agentId) {
      throw new Error(`CONFIGURATION_ERROR: no agent mapped for role "${agentRole}" (no match by name either)`);
    }
    return agentId;
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
