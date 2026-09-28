import { api } from "./client";
import type { ChatEndpoint } from "./chatEndpoints";
export const xChatApi = {
  identityStatus: (endpointId: string) =>
    api.get<{ linked: boolean }>(`/chat-endpoints/${endpointId}/x/identity`),
  authorize: (
    endpointId: string,
    purpose: "bot" | "identity",
    client?: { clientId: string; clientSecret: string },
  ) =>
    api.post<{ url: string; redirectUri: string }>(
      `/chat-endpoints/${endpointId}/x/authorize`,
      { purpose, ...(client ? { client } : {}) },
    ),
  progress: (endpointId: string, stage: number) =>
    api.put<ChatEndpoint>(`/chat-endpoints/${endpointId}/x/progress`, {
      stage,
    }),
  confirmation: (id: string) =>
    api.get<{
      identity: { id: string; username: string; name: string };
      endpointId: string;
    }>(`/x/identity/${id}`),
  confirm: (id: string) =>
    api.post<{ endpointId: string }>(`/x/identity/${id}/confirm`, {}),
  finish: (endpointId: string) =>
    api.post<ChatEndpoint>(`/chat-endpoints/${endpointId}/x/finish`, {}),
};
