import type {
  AgentGoal,
  BrabrixAgentProfileKey,
  BrabrixTask,
  ProjectContext,
} from "../integrations/brabrix/brabrix-types.js";
import { buildBrabrixAgentContext, type BrabrixAgentContextBundle } from "./context-builder.js";

export interface MapBrabrixTaskToAgentGoalInput {
  task: BrabrixTask;
  projectContext?: ProjectContext | null;
  profileKey?: BrabrixAgentProfileKey | null;
}

export interface BrabrixTaskGoalMapping {
  goal: AgentGoal;
  context: BrabrixAgentContextBundle;
}

function buildGoalDescription(input: {
  task: BrabrixTask;
  context: BrabrixAgentContextBundle;
}): string | null {
  const base = input.task.description?.trim() ?? "";
  const acceptanceSection = input.context.sections.find((section) => section.key === "acceptance_criteria");
  const parts = [base];
  if (acceptanceSection?.content) {
    parts.push(`Acceptance Criteria\n${acceptanceSection.content}`);
  }
  const merged = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
  return merged.length > 0 ? merged : null;
}

export function mapBrabrixTaskToAgentGoal(input: MapBrabrixTaskToAgentGoalInput): BrabrixTaskGoalMapping {
  const context = buildBrabrixAgentContext({
    task: input.task,
    projectContext: input.projectContext ?? null,
    profileKey: input.profileKey ?? null,
  });

  const sourceProjectId = input.task.projectId ?? input.projectContext?.projectId ?? null;
  const goal: AgentGoal = {
    source: "brabrix",
    sourceTaskId: input.task.taskId,
    sourceProjectId,
    title: input.task.title,
    description: buildGoalDescription({ task: input.task, context }),
    level: "task",
    status: "planned",
    agentProfile: context.profile.key,
    metadata: {
      priority: input.task.priority ?? null,
      skillsApplied: context.skillsApplied,
      preferredModel: context.profile.preferredModel,
      allowedTools: context.profile.allowedTools,
      contextEstimatedChars: context.estimatedChars,
      contextEstimatedTokens: context.estimatedTokens,
    },
  };

  return {
    goal,
    context,
  };
}
