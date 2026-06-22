import type { AgentMemory, CreateAgentMemory, CorrectAgentMemory } from "@paperclipai/shared";
import { api } from "./client";

export const agentMemoriesApi = {
  list: (agentId: string, includeForgotten = false) => {
    const qs = includeForgotten ? "?includeForgotten=1" : "";
    return api.get<AgentMemory[]>(`/agents/${agentId}/memories${qs}`);
  },
  create: (agentId: string, body: CreateAgentMemory) =>
    api.post<AgentMemory>(`/agents/${agentId}/memories`, body),
  forget: (agentId: string, memoryId: string) =>
    api.post<AgentMemory>(`/agents/${agentId}/memories/${memoryId}/forget`, {}),
  correct: (agentId: string, memoryId: string, body: CorrectAgentMemory) =>
    api.post<AgentMemory>(`/agents/${agentId}/memories/${memoryId}/correct`, body),
};
