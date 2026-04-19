import type { AgentServiceHealth } from "@paperclipai/shared";
import { api } from "./client";

export const agentServiceHealthApi = {
  get: () => api.get<AgentServiceHealth>("/instance/agent-service-health"),
};
