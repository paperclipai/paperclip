/**
 * AgentOrchestrator — ponto de entrada principal da camada de orquestração.
 *
 * Agrega AgentSpawner, TaskRouter e MessageBus em uma interface coesa para
 * orquestrar workflows multi-agente no Paperclip.
 *
 * Uso típico (dentro de um heartbeat):
 *
 *   const orch = AgentOrchestrator.fromEnv();
 *   const task = await orch.tasks.createTask({ title: "...", assigneeAgentId: "..." });
 *   await orch.messages.mention(task.id, "other-agent", "Por favor, revise.");
 *   await orch.tasks.waitForStatus(task.id, ["done"]);
 */

import { PaperclipRawClient } from "./client.js";
import { AgentSpawner } from "./agent-spawner.js";
import { TaskRouter } from "./task-router.js";
import { MessageBus } from "./message-bus.js";
import { TaskPipeline } from "./task-pipeline.js";
import type { PaperclipClientConfig, PipelineStep } from "./types.js";

export class AgentOrchestrator {
  readonly companyId: string;
  readonly agentId: string;

  readonly spawner: AgentSpawner;
  readonly tasks: TaskRouter;
  readonly messages: MessageBus;

  private constructor(
    config: PaperclipClientConfig & { agentId: string },
    client: PaperclipRawClient,
  ) {
    this.companyId = config.companyId;
    this.agentId = config.agentId;
    this.spawner = new AgentSpawner(client, config.companyId);
    this.tasks = new TaskRouter(client, config.companyId, config.agentId);
    this.messages = new MessageBus(client);
  }

  /**
   * Cria um orquestrador a partir de variáveis de ambiente.
   * Espera: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID,
   *         PAPERCLIP_AGENT_ID, PAPERCLIP_RUN_ID (opcional).
   */
  static fromEnv(): AgentOrchestrator {
    const apiUrl = requireEnv("PAPERCLIP_API_URL");
    const apiKey = requireEnv("PAPERCLIP_API_KEY");
    const companyId = requireEnv("PAPERCLIP_COMPANY_ID");
    const agentId = requireEnv("PAPERCLIP_AGENT_ID");
    const runId = process.env["PAPERCLIP_RUN_ID"];

    return AgentOrchestrator.create({ apiUrl, apiKey, companyId, runId }, agentId);
  }

  /**
   * Cria um orquestrador com configuração explícita.
   */
  static create(
    config: PaperclipClientConfig,
    agentId: string,
  ): AgentOrchestrator {
    const client = new PaperclipRawClient({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      runId: config.runId,
    });
    return new AgentOrchestrator({ ...config, agentId }, client);
  }

  /**
   * Cria um TaskPipeline encadeado a este orquestrador.
   *
   * @example
   * const result = await orch
   *   .pipeline({ goalId: "..." })
   *   .step({ name: "pesquisa", assigneeAgentId: researcherId, taskTitle: "..." })
   *   .step({ name: "implementação", assigneeAgentId: devId, taskTitle: "..." })
   *   .run();
   */
  pipeline(
    baseContext: { goalId?: string; parentId?: string; metadata?: Record<string, unknown> },
  ): TaskPipeline {
    return new TaskPipeline(this, {
      goalId: baseContext.goalId,
      parentId: baseContext.parentId,
      metadata: baseContext.metadata ?? {},
    });
  }

  /**
   * Atalho: cria e executa um pipeline simples de um único passo.
   */
  async delegate(
    step: PipelineStep & { goalId?: string; parentId?: string },
  ): Promise<import("./types.ts").TaskSummary> {
    const task = await this.tasks.createTask({
      title: step.taskTitle,
      description: step.taskDescription,
      assigneeAgentId: step.assigneeAgentId,
      goalId: step.goalId,
      parentId: step.parentId,
      priority: step.priority ?? "medium",
      status: "todo",
    });
    return task;
  }
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
  return val;
}
