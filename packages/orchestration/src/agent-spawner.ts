/**
 * AgentSpawner — primitiva de spawn de agentes.
 *
 * Abstrai a criação de agentes via API do Paperclip, lidando com o fluxo de
 * aprovação quando necessário.
 */

import type { PaperclipRawClient } from "./client.js";
import type {
  AgentSummary,
  SpawnAgentInput,
  SpawnAgentResult,
} from "./types.js";

interface RawAgent {
  id: string;
  name: string;
  nameKey: string;
  role: string;
  status: string;
  adapterType: string;
  managerId: string | null;
}

interface RawHireResponse {
  agent?: RawAgent;
  approvalId?: string;
  requiresApproval?: boolean;
}

export class AgentSpawner {
  constructor(
    private readonly client: PaperclipRawClient,
    private readonly companyId: string,
  ) {}

  /**
   * Lista todos os agentes ativos da empresa.
   */
  async listAgents(): Promise<AgentSummary[]> {
    const raw = await this.client.get<RawAgent[]>(
      `/api/companies/${this.companyId}/agents`,
    );
    return raw.map(normalizeAgent);
  }

  /**
   * Cria (spawna) um novo agente.
   *
   * Se a empresa exigir aprovação para contratações, retorna o approvalId e
   * `requiresApproval: true`. O agente só fica disponível após aprovação pelo
   * board.
   */
  async spawn(input: SpawnAgentInput): Promise<SpawnAgentResult> {
    const payload: Record<string, unknown> = {
      name: input.name,
      role: input.role,
      adapterType: input.adapterType,
    };
    if (input.adapterConfig) payload.adapterConfig = input.adapterConfig;
    if (input.managerId) payload.managerId = input.managerId;
    if (input.desiredSkills) payload.desiredSkills = input.desiredSkills;

    const raw = await this.client.post<RawHireResponse>(
      `/api/companies/${this.companyId}/agents`,
      payload,
    );

    return {
      agentId: raw.agent?.id ?? "",
      approvalId: raw.approvalId ?? null,
      requiresApproval: raw.requiresApproval ?? false,
    };
  }

  /**
   * Aguarda a aprovação de um spawn, verificando o status periodicamente.
   * Lança erro se o tempo máximo for atingido.
   */
  async waitForApproval(
    approvalId: string,
    opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<"approved" | "rejected"> {
    const interval = opts.pollIntervalMs ?? 5_000;
    const timeout = opts.timeoutMs ?? 5 * 60_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const approval = await this.client.get<{ status: string }>(
        `/api/approvals/${approvalId}`,
      );
      if (approval.status === "approved") return "approved";
      if (approval.status === "rejected") return "rejected";
      await sleep(interval);
    }

    throw new Error(
      `Timeout aguardando aprovação ${approvalId} após ${timeout}ms`,
    );
  }
}

function normalizeAgent(raw: RawAgent): AgentSummary {
  return {
    id: raw.id,
    name: raw.name,
    nameKey: raw.nameKey,
    role: raw.role,
    status: raw.status,
    adapterType: raw.adapterType,
    managerId: raw.managerId,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
