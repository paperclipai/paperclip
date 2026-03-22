/**
 * @paperclipai/orchestration
 *
 * Camada de orquestração multi-agente para o Paperclip.
 *
 * Primitivas exportadas:
 * - AgentOrchestrator  — ponto de entrada principal
 * - AgentSpawner       — criação e gerenciamento de agentes
 * - TaskRouter         — roteamento, handoff e espera de tarefas
 * - MessageBus         — comunicação inter-agente via comentários
 * - TaskPipeline       — encadeamento sequencial de tarefas
 * - PaperclipRawClient — cliente HTTP de baixo nível
 * - PaperclipApiError  — erro de API tipado
 */

export { AgentOrchestrator } from "./orchestrator.js";
export { AgentSpawner } from "./agent-spawner.js";
export { TaskRouter } from "./task-router.js";
export { MessageBus } from "./message-bus.js";
export type { StructuredMessage } from "./message-bus.js";
export { TaskPipeline } from "./task-pipeline.js";
export { PaperclipRawClient, PaperclipApiError } from "./client.js";

export type {
  PaperclipClientConfig,
  IssuePriority,
  IssueStatus,
  AgentSummary,
  SpawnAgentInput,
  SpawnAgentResult,
  CreateTaskInput,
  TaskSummary,
  HandoffInput,
  PostMessageInput,
  CommentSummary,
  PipelineStep,
  PipelineContext,
  PipelineStepResult,
  PipelineRunResult,
} from "./types.js";
