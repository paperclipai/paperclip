/**
 * TaskRouter — primitivas de roteamento e handoff de tarefas.
 *
 * Fornece operações de alto nível sobre issues do Paperclip:
 * - criação de tarefas e subtarefas
 * - handoff (transferência) entre agentes
 * - checkout / release
 * - atualização de status
 */

import type { PaperclipRawClient } from "./client.js";
import type {
  CreateTaskInput,
  HandoffInput,
  IssueStatus,
  TaskSummary,
} from "./types.js";

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  parentId: string | null;
  goalId: string | null;
}

export class TaskRouter {
  constructor(
    private readonly client: PaperclipRawClient,
    private readonly companyId: string,
    private readonly agentId: string,
  ) {}

  /**
   * Cria uma nova tarefa (issue) e a atribui opcionalmente a um agente.
   */
  async createTask(input: CreateTaskInput): Promise<TaskSummary> {
    const payload: Record<string, unknown> = {
      title: input.title,
      companyId: this.companyId,
    };
    if (input.description) payload.description = input.description;
    if (input.assigneeAgentId) payload.assigneeAgentId = input.assigneeAgentId;
    if (input.parentId) payload.parentId = input.parentId;
    if (input.goalId) payload.goalId = input.goalId;
    if (input.priority) payload.priority = input.priority;
    if (input.status) payload.status = input.status;
    if (input.billingCode) payload.billingCode = input.billingCode;

    const raw = await this.client.post<RawIssue>(
      `/api/companies/${this.companyId}/issues`,
      payload,
    );
    return normalizeIssue(raw);
  }

  /**
   * Faz checkout de uma tarefa para este agente antes de começar a trabalhar.
   * Lança ConflictError se a tarefa já está em uso por outro agente.
   */
  async checkout(
    issueId: string,
    expectedStatuses: IssueStatus[] = ["todo", "backlog", "blocked"],
  ): Promise<TaskSummary> {
    const raw = await this.client.post<RawIssue>(
      `/api/issues/${issueId}/checkout`,
      {
        agentId: this.agentId,
        expectedStatuses,
      },
    );
    return normalizeIssue(raw);
  }

  /**
   * Transfere (handoff) uma tarefa para outro agente.
   * Opcionalmente posta um comentário explicando o motivo.
   */
  async handoff(input: HandoffInput): Promise<TaskSummary> {
    const patch: Record<string, unknown> = {
      assigneeAgentId: input.toAgentId,
      status: input.newStatus ?? "todo",
    };
    if (input.comment) {
      patch.comment = input.comment;
    }

    const raw = await this.client.patch<RawIssue>(
      `/api/issues/${input.issueId}`,
      patch,
    );
    return normalizeIssue(raw);
  }

  /**
   * Atualiza o status de uma tarefa, com comentário opcional.
   */
  async updateStatus(
    issueId: string,
    status: IssueStatus,
    comment?: string,
  ): Promise<TaskSummary> {
    const patch: Record<string, unknown> = { status };
    if (comment) patch.comment = comment;

    const raw = await this.client.patch<RawIssue>(
      `/api/issues/${issueId}`,
      patch,
    );
    return normalizeIssue(raw);
  }

  /**
   * Marca uma tarefa como concluída.
   */
  async complete(issueId: string, comment?: string): Promise<TaskSummary> {
    return this.updateStatus(issueId, "done", comment);
  }

  /**
   * Marca uma tarefa como bloqueada e documenta o bloqueio.
   */
  async block(issueId: string, reason: string): Promise<TaskSummary> {
    return this.updateStatus(issueId, "blocked", reason);
  }

  /**
   * Busca uma tarefa pelo ID.
   */
  async getTask(issueId: string): Promise<TaskSummary> {
    const raw = await this.client.get<RawIssue>(`/api/issues/${issueId}`);
    return normalizeIssue(raw);
  }

  /**
   * Lista tarefas atribuídas a um agente específico.
   */
  async listTasksForAgent(
    agentId: string,
    statuses: IssueStatus[] = ["todo", "in_progress", "blocked"],
  ): Promise<TaskSummary[]> {
    const qs = new URLSearchParams({
      assigneeAgentId: agentId,
      status: statuses.join(","),
    });
    const raw = await this.client.get<RawIssue[]>(
      `/api/companies/${this.companyId}/issues?${qs}`,
    );
    return raw.map(normalizeIssue);
  }

  /**
   * Aguarda uma tarefa atingir um dos status alvo, consultando periodicamente.
   */
  async waitForStatus(
    issueId: string,
    targetStatuses: IssueStatus[],
    opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<TaskSummary> {
    const interval = opts.pollIntervalMs ?? 10_000;
    const timeout = opts.timeoutMs ?? 30 * 60_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const task = await this.getTask(issueId);
      if (targetStatuses.includes(task.status as IssueStatus)) return task;
      await sleep(interval);
    }

    throw new Error(
      `Timeout aguardando tarefa ${issueId} atingir status: ${targetStatuses.join(", ")}`,
    );
  }
}

function normalizeIssue(raw: RawIssue): TaskSummary {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    status: raw.status as TaskSummary["status"],
    priority: raw.priority as TaskSummary["priority"],
    assigneeAgentId: raw.assigneeAgentId,
    parentId: raw.parentId,
    goalId: raw.goalId,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
