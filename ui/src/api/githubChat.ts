import type {
  ChatEndpointSetupState,
  GitHubChatConfiguration,
  GitHubTaskReview,
} from "@paperclipai/shared";
import { api } from "./client";
import type { ChatEndpoint, ChatEndpointResource } from "./chatEndpoints";
export type GitHubConfigurationRecord = {
  revision: number;
  configuration: GitHubChatConfiguration;
};
export type GitHubIdentity = {
  githubUserId: string;
  login: string;
  connectionId: string;
  avatarUrl: string | null;
};
export type GitHubVerification = {
  ready: boolean;
  checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
};
const path = (endpointId: string) => `/chat-endpoints/${endpointId}/github`;
export const githubChatApi = {
  configuration: (id: string) =>
    api.get<GitHubConfigurationRecord>(`${path(id)}/configuration`),
  save: (
    id: string,
    expectedRevision: number,
    configuration: GitHubChatConfiguration,
  ) =>
    api.put<GitHubConfigurationRecord>(`${path(id)}/configuration`, {
      expectedRevision,
      configuration,
    }),
  registration: (id: string, name: string) =>
    api.post<{
      registrationUrl: string;
      manifest: Record<string, unknown>;
      expiresAt: string;
    }>(`${path(id)}/registration`, { name }),
  connectApp: (
    id: string,
    credentials: { appId: string; privateKey: string; webhookSecret: string },
  ) => api.post<ChatEndpoint>(`${path(id)}/app`, credentials),
  refreshRepositories: (id: string) =>
    api.post<ChatEndpointResource[]>(`${path(id)}/repositories/refresh`, {}),
  verify: (id: string) =>
    api.post<GitHubVerification>(`${path(id)}/verify`, {}),
  progress: (
    id: string,
    stage: NonNullable<ChatEndpointSetupState["github"]>["stage"],
  ) => api.put<ChatEndpoint>(`${path(id)}/progress`, { stage }),
  personalConnections: (id: string) =>
    api.get<
      Array<{
        connectionId: string;
        name: string;
        login: string | null;
        status: string;
        enabled: boolean;
      }>
    >(`${path(id)}/personal-connections`),
  identity: (
    id: string,
    connectionId: string,
    confirmedGithubUserId?: string,
  ) =>
    api.post<GitHubIdentity>(`${path(id)}/identity`, {
      connectionId,
      confirmedGithubUserId,
    }),
  lookup: (id: string, login: string) =>
    api.post<{ githubUserId: string; login: string }>(
      `${path(id)}/people/lookup`,
      { login },
    ),
  reviews: (id: string) => api.get<GitHubTaskReview[]>(`${path(id)}/reviews`),
};
