import type {
  ChatEndpointSetupState,
  GitHubChatConfiguration,
  GitHubTaskReview,
  GitHubAppRegistrationInput, GitHubAppWizardState,
  GitHubRepositoryPage,
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
  repositories: (id: string, options: { offset?: number; search?: string; limit?: number } = {}) => {
    const query = new URLSearchParams({ limit: String(options.limit ?? 20), offset: String(options.offset ?? 0), search: options.search ?? "" });
    return api.get<GitHubRepositoryPage>(`${path(id)}/repositories?${query}`);
  },
  toggleAllRepositories: (id: string, enabled: boolean) =>
    api.put<{ success: true }>(`${path(id)}/repositories/access`, { enabled }),
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
  registration: (id: string, input: GitHubAppRegistrationInput) =>
    api.post<GitHubAppWizardState>(`${path(id)}/registration`, input),
  restartRegistration: (id: string, registrationId: string) => api.post<GitHubAppWizardState>(`${path(id)}/registration/restart`, { registrationId, appNotCreated: true }),
  saveDraft: (id: string, input: GitHubAppRegistrationInput) => api.put<{ saved: true }>(`${path(id)}/draft`, input),
  advance: (id: string) => api.post<GitHubAppWizardState>(`${path(id)}/setup`, {}),
  startIdentity: (id: string) => api.post<{ authorizationUrl: string }>(`${path(id)}/identity/start`, {}),
  confirmIdentity: (id: string, githubUserId: string) => api.post<GitHubAppWizardState>(`${path(id)}/identity/confirm`, { githubUserId }),
  connectApp: (
    id: string,
    credentials: { appId: string; privateKey: string; webhookSecret: string; clientId?: string; clientSecret?: string },
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
  review: (id: string, reviewId: string) => api.get<GitHubTaskReview>(`${path(id)}/reviews/${reviewId}`),
  reviews: (id: string) => api.get<GitHubTaskReview[]>(`${path(id)}/reviews`),
};
