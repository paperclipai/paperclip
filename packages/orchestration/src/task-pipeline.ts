/**
 * TaskPipeline — encadeamento sequencial de tarefas entre agentes.
 *
 * Permite definir um pipeline onde cada etapa é uma tarefa atribuída a um
 * agente. O pipeline aguarda cada tarefa concluir antes de avançar para a
 * próxima, passando contexto entre as etapas.
 *
 * Exemplo:
 *   const pipeline = new TaskPipeline(orchestrator, { goalId: "..." });
 *   pipeline.step({ name: "research", assigneeAgentId: "agent-a", ... });
 *   pipeline.step({ name: "implement", assigneeAgentId: "agent-b", ... });
 *   pipeline.step({ name: "review", assigneeAgentId: "agent-c", ... });
 *   const result = await pipeline.run();
 */

import type { AgentOrchestrator } from "./orchestrator.js";
import type {
  IssueStatus,
  PipelineContext,
  PipelineRunResult,
  PipelineStep,
} from "./types.js";

const TERMINAL_STATUSES: IssueStatus[] = ["done", "cancelled", "blocked"];
const SUCCESS_STATUS: IssueStatus = "done";

export class TaskPipeline {
  private readonly steps: PipelineStep[] = [];

  constructor(
    private readonly orchestrator: AgentOrchestrator,
    private readonly baseContext: Pick<
      PipelineContext,
      "goalId" | "parentId" | "metadata"
    >,
  ) {}

  /**
   * Adiciona um passo ao pipeline.
   */
  step(step: PipelineStep): this {
    this.steps.push(step);
    return this;
  }

  /**
   * Executa o pipeline sequencialmente.
   *
   * Cada passo cria uma subtarefa atribuída ao agente especificado e aguarda
   * ela atingir um status terminal antes de avançar. Se um passo falhar
   * (blocked/cancelled), o pipeline para e reporta o erro.
   */
  async run(
    opts: { pollIntervalMs?: number; stepTimeoutMs?: number } = {},
  ): Promise<PipelineRunResult> {
    const results: PipelineRunResult["steps"] = [];
    let previousTaskId: string | undefined;
    let previousStatus: IssueStatus | undefined;
    const companyId = this.orchestrator.companyId;

    for (const step of this.steps) {
      const ctx: PipelineContext = {
        companyId,
        goalId: this.baseContext.goalId,
        parentId: this.baseContext.parentId,
        previousTaskId,
        previousTaskStatus: previousStatus,
        metadata: { ...this.baseContext.metadata },
      };

      const description = buildStepDescription(step, ctx);

      const task = await this.orchestrator.tasks.createTask({
        title: step.taskTitle,
        description,
        assigneeAgentId: step.assigneeAgentId,
        goalId: ctx.goalId,
        parentId: ctx.parentId,
        priority: step.priority ?? "medium",
        status: "todo",
      });

      const completed = await this.orchestrator.tasks.waitForStatus(
        task.id,
        TERMINAL_STATUSES,
        {
          pollIntervalMs: opts.pollIntervalMs ?? 15_000,
          timeoutMs: opts.stepTimeoutMs ?? 60 * 60_000,
        },
      );

      results.push({
        stepName: step.name,
        taskId: task.id,
        status: completed.status,
      });

      previousTaskId = task.id;
      previousStatus = completed.status;

      if (completed.status !== SUCCESS_STATUS) {
        return { steps: results, succeeded: false };
      }
    }

    return { steps: results, succeeded: true };
  }
}

function buildStepDescription(
  step: PipelineStep,
  ctx: PipelineContext,
): string {
  const lines: string[] = [];

  if (step.taskDescription) {
    lines.push(step.taskDescription);
    lines.push("");
  }

  lines.push("---");
  lines.push("**Contexto do pipeline:**");
  if (ctx.previousTaskId) {
    lines.push(`- Tarefa anterior: \`${ctx.previousTaskId}\``);
    lines.push(`- Status anterior: \`${ctx.previousTaskStatus}\``);
  }
  if (ctx.goalId) {
    lines.push(`- Goal: \`${ctx.goalId}\``);
  }

  return lines.join("\n");
}
