import { logger } from "../middleware/logger.js";
import { BrabrixClient } from "../integrations/brabrix/brabrix-client.js";
import { getBrabrixConfig, resolveBrabrixConfig, type BrabrixConfig } from "../integrations/brabrix/brabrix-config.js";
import type {
  AgentGoal,
  BrabrixAgentProfileKey,
  AgentRun,
  BrabrixCompleteTaskInput,
  BrabrixRunLogEntry,
  BrabrixSendRunLogsInput,
  BrabrixTask,
  BrabrixTaskCompletionStatus,
  ProjectContext,
} from "../integrations/brabrix/brabrix-types.js";
import { mapBrabrixTaskToAgentGoal } from "./brabrix-task-goal-mapper.js";
import type { BrabrixAgentContextBundle } from "./context-builder.js";

interface BrabrixClientContract {
  getProjectContext(): Promise<ProjectContext | null>;
  getNextTask(): Promise<BrabrixTask | null>;
  sendRunLogs(input: BrabrixSendRunLogsInput): Promise<void>;
  completeTask(input: BrabrixCompleteTaskInput): Promise<void>;
}

export interface BrabrixAgentSyncService {
  isEnabled(): boolean;
  fetchNextTask(): Promise<BrabrixTaskDispatchBundle>;
  sendRunLogs(input: BrabrixSendRunLogsInput): Promise<void>;
  syncStatus(input: BrabrixCompleteTaskInput): Promise<void>;
  updateExecution(input: {
    taskId: string;
    run: AgentRun;
    logs?: BrabrixRunLogEntry[];
    summary?: string | null;
    output?: Record<string, unknown> | null;
  }): Promise<void>;
}

export interface BrabrixTaskDispatchBundle {
  projectContext: ProjectContext | null;
  task: BrabrixTask | null;
  goal: AgentGoal | null;
  context: BrabrixAgentContextBundle | null;
}

export interface CreateBrabrixAgentSyncServiceOptions {
  config?: BrabrixConfig;
  client?: BrabrixClientContract;
  defaultAgentProfile?: BrabrixAgentProfileKey | null;
}

const TERMINAL_RUN_STATUS_TO_TASK_STATUS: Record<string, BrabrixTaskCompletionStatus> = {
  completed: "completed",
  failed: "failed",
  canceled: "canceled",
};

function toCompletionStatus(runStatus: string): BrabrixTaskCompletionStatus | null {
  return TERMINAL_RUN_STATUS_TO_TASK_STATUS[runStatus] ?? null;
}

export function createBrabrixAgentSyncService(
  options: CreateBrabrixAgentSyncServiceOptions = {},
): BrabrixAgentSyncService {
  const config = options.config ?? getBrabrixConfig();
  const resolvedConfig = resolveBrabrixConfig(config);
  const client = options.client ?? new BrabrixClient(config);
  const log = logger.child({
    service: "brabrix-agent-sync",
    projectId: config.projectId,
    provider: config.provider,
  });

  const enabled = !!resolvedConfig;
  if (!enabled) {
    log.info(
      {
        hasProjectId: !!config.projectId,
        hasToken: !!config.agentToken,
        hasEndpoints:
          !!config.endpoints.projectContext
          && !!config.endpoints.nextTask
          && !!config.endpoints.sendRunLogs
          && !!config.endpoints.completeTask,
      },
      "brabrix sync service disabled: missing integration configuration",
    );
  }

  return {
    isEnabled() {
      return enabled;
    },

    async fetchNextTask() {
      if (!enabled) return { projectContext: null, task: null, goal: null, context: null };

      const [projectContext, task] = await Promise.all([
        client.getProjectContext(),
        client.getNextTask(),
      ]);
      const mapped = task
        ? mapBrabrixTaskToAgentGoal({
            task,
            projectContext,
            profileKey: options.defaultAgentProfile ?? null,
          })
        : null;

      log.info(
        {
          projectId: resolvedConfig?.projectId ?? null,
          taskId: task?.taskId ?? null,
          hasProjectContext: projectContext !== null,
          goalProfile: mapped?.goal.agentProfile ?? null,
          contextSections: mapped?.context.sections.map((section) => section.key) ?? [],
          contextEstimatedChars: mapped?.context.estimatedChars ?? 0,
          contextEstimatedTokens: mapped?.context.estimatedTokens ?? 0,
          skillsApplied: mapped?.context.skillsApplied ?? [],
        },
        "brabrix next-task sync completed",
      );

      return {
        projectContext,
        task,
        goal: mapped?.goal ?? null,
        context: mapped?.context ?? null,
      };
    },

    async sendRunLogs(input: BrabrixSendRunLogsInput) {
      if (!enabled) return;
      await client.sendRunLogs(input);
      log.info(
        {
          taskId: input.taskId ?? null,
          runId: input.runId ?? input.agentRun?.runId ?? null,
          logCount: input.logs.length,
        },
        "brabrix run-log sync completed",
      );
    },

    async syncStatus(input: BrabrixCompleteTaskInput) {
      if (!enabled) return;
      await client.completeTask(input);
      log.info(
        {
          taskId: input.taskId,
          runId: input.runId ?? input.agentRun?.runId ?? null,
          status: input.status,
        },
        "brabrix status sync completed",
      );
    },

    async updateExecution(input: {
      taskId: string;
      run: AgentRun;
      logs?: BrabrixRunLogEntry[];
      summary?: string | null;
      output?: Record<string, unknown> | null;
    }) {
      if (!enabled) return;

      if (input.logs && input.logs.length > 0) {
        await client.sendRunLogs({
          taskId: input.taskId,
          runId: input.run.runId,
          agentRun: input.run,
          logs: input.logs,
        });
      }

      const completionStatus = toCompletionStatus(input.run.status);
      if (!completionStatus) {
        log.debug(
          {
            taskId: input.taskId,
            runId: input.run.runId,
            runStatus: input.run.status,
          },
          "brabrix execution update sent without completion status",
        );
        return;
      }

      await client.completeTask({
        taskId: input.taskId,
        runId: input.run.runId,
        agentRun: input.run,
        status: completionStatus,
        summary: input.summary ?? null,
        output: input.output ?? null,
      });

      log.info(
        {
          taskId: input.taskId,
          runId: input.run.runId,
          runStatus: input.run.status,
          completionStatus,
        },
        "brabrix execution completion sync completed",
      );
    },
  };
}
