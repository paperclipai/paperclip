export interface AgentMemory {
  id: string;
  companyId: string;
  agentId: string | null;
  namespace: string;
  key: string;
  value: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
