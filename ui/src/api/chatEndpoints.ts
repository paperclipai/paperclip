import { api } from "./client";

export type ChatProvider = "slack" | "github" | "microsoft-teams" | "telegram";
export type ChatEndpointStatus =
  | "draft"
  | "verifying"
  | "active"
  | "paused"
  | "attention"
  | "revoked"
  | "archived";

export type ChatEndpointSetupAction =
  "configure" | "verify" | "pause" | "resume" | "reconnect" | "remove";

export interface ChatEndpointResource {
  id: string;
  type: string;
  providerResourceId: string;
  label: string;
  availability: "available" | "unavailable" | "removed";
  enabled: boolean;
  detail?: string | null;
}

export interface ChatIdentityLink {
  id: string;
  principalId: string;
  externalLabel: string;
  externalDetail?: string | null;
  paperclipUserId?: string | null;
  paperclipUserLabel?: string | null;
  status: "linked" | "pending" | "revoked";
}

export interface ChatConversation {
  id: string;
  externalLabel: string;
  externalUrl?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  state:
    "active" | "waiting" | "completed" | "unavailable" | "endpoint_removed";
  updatedAt: string;
  lastPublicationStatus?:
    | "pending"
    | "streaming"
    | "published"
    | "retry"
    | "delivery_unknown"
    | "failed"
    | "cancelled"
    | null;
}

export interface ChatActivityItem {
  id: string;
  kind: "delivery" | "publication" | "health" | "repair";
  status: string;
  summary: string;
  detail?: string | null;
  createdAt: string;
  replayable?: boolean;
  resolutionActions?: Array<"mark_delivered" | "retry_anyway" | "cancel">;
}

export interface ExternalChannelBindingSummary {
  endpointId: string;
  provider: ChatProvider;
  botLabel?: string | null;
  externalLabel: string;
  externalUrl?: string | null;
  conversationId: string;
  publicationState?: string | null;
  assignedAgentLocked: true;
}

export interface ChatIdentityLinkPreview {
  endpointId: string;
  companyId: string;
  companyName: string;
  companyPrefix: string;
  provider: ChatProvider;
  providerAccountLabel?: string | null;
  botLabel?: string | null;
  externalLabel: string;
  externalDetail?: string | null;
  expiresAt: string;
}

export interface ChatEndpoint {
  id: string;
  companyId: string;
  provider: ChatProvider;
  status: ChatEndpointStatus;
  assignedAgentId: string;
  assignedAgentName: string;
  connectionId?: string | null;
  providerAccountId?: string | null;
  providerAccountLabel?: string | null;
  botLabel?: string | null;
  botUsername?: string | null;
  botExternalId?: string | null;
  allowDirectMessages?: boolean;
  allowGroupChats?: boolean;
  allowUnlinkedPeople: boolean;
  replyMode?: "subscribed" | "mention_each_reply" | null;
  healthMessage?: string | null;
  lastError?: string | null;
  lastActivityAt?: string | null;
  resources?: ChatEndpointResource[];
  identityLinks?: ChatIdentityLink[];
  conversations?: ChatConversation[];
  activity?: ChatActivityItem[];
  setup?: {
    step: string;
    authorizationUrl?: string | null;
    providerUrl?: string | null;
    webhookUrl?: string | null;
    messagingEndpoint?: string | null;
    command?: string | null;
    webhookVerifiedAt?: string | null;
    webhookSecretConfigured?: boolean;
  };
}

export interface ChatEndpointSetupSecret {
  webhookSecret: string;
}

type ListResponse<T> =
  | T[]
  | {
      items?: T[];
      endpoints?: T[];
      resources?: T[];
      principals?: T[];
      conversations?: T[];
      deliveries?: T[];
      publications?: T[];
    };

function rows<T>(response: ListResponse<T>): T[] {
  if (Array.isArray(response)) return response;
  return (
    response.items ??
    response.endpoints ??
    response.resources ??
    response.principals ??
    response.conversations ??
    response.deliveries ??
    response.publications ??
    []
  );
}

export const chatEndpointsApi = {
  list: async (companyId: string) =>
    rows(
      await api.get<ListResponse<ChatEndpoint>>(
        `/companies/${companyId}/chat-endpoints`,
      ),
    ),
  get: (endpointId: string) =>
    api.get<ChatEndpoint>(`/chat-endpoints/${endpointId}`),
  create: (
    companyId: string,
    input: { provider: ChatProvider; assignedAgentId: string },
  ) => api.post<ChatEndpoint>(`/companies/${companyId}/chat-endpoints`, input),
  update: (
    endpointId: string,
    input: Partial<
      Pick<
        ChatEndpoint,
        "allowDirectMessages" | "allowGroupChats" | "allowUnlinkedPeople"
      >
    >,
  ) => api.patch<ChatEndpoint>(`/chat-endpoints/${endpointId}`, input),
  setup: (
    endpointId: string,
    input: {
      action: ChatEndpointSetupAction;
      credentials?: Record<string, string>;
    },
  ) => api.post<ChatEndpoint>(`/chat-endpoints/${endpointId}/setup`, input),
  generateSetupSecret: (endpointId: string) =>
    api.post<ChatEndpointSetupSecret>(
      `/chat-endpoints/${endpointId}/setup-secret`,
      {},
    ),
  test: (endpointId: string) =>
    api.post<ChatEndpoint>(`/chat-endpoints/${endpointId}/test`, {}),
  listResources: async (endpointId: string) =>
    rows(
      await api.get<ListResponse<ChatEndpointResource>>(
        `/chat-endpoints/${endpointId}/resources`,
      ),
    ),
  updateResources: (
    endpointId: string,
    resources: Array<{ id: string; enabled: boolean }>,
  ) =>
    api.put<ChatEndpointResource[]>(`/chat-endpoints/${endpointId}/resources`, {
      resources,
    }),
  listPrincipals: async (endpointId: string) =>
    rows(
      await api.get<ListResponse<ChatIdentityLink>>(
        `/chat-endpoints/${endpointId}/principals`,
      ),
    ),
  createLinkIntent: (endpointId: string, principalId: string) =>
    api.post<{ confirmationUrl: string }>(
      `/chat-endpoints/${endpointId}/principals/${principalId}/link-intent`,
      {},
    ),
  revokeLink: (endpointId: string, principalId: string) =>
    api.delete<void>(
      `/chat-endpoints/${endpointId}/principals/${principalId}/link`,
    ),
  previewIdentityLink: (token: string) =>
    api.get<ChatIdentityLinkPreview>(
      `/chat-identity-links/preview?token=${encodeURIComponent(token)}`,
    ),
  confirmIdentityLink: (token: string) =>
    api.post<{ ok: true; endpointId: string }>("/chat-identity-links/confirm", {
      token,
    }),
  listConversations: async (endpointId: string) =>
    rows(
      await api.get<ListResponse<ChatConversation>>(
        `/chat-endpoints/${endpointId}/conversations`,
      ),
    ),
  listActivity: async (endpointId: string) =>
    rows(
      await api.get<ListResponse<ChatActivityItem>>(
        `/chat-endpoints/${endpointId}/activity`,
      ),
    ),
  getIssueBinding: (issueId: string) =>
    api.get<ExternalChannelBindingSummary | null>(
      `/issues/${issueId}/chat-binding`,
    ),
  replayDelivery: (endpointId: string, deliveryId: string) =>
    api.post<void>(
      `/chat-endpoints/${endpointId}/deliveries/${deliveryId}/replay`,
      {},
    ),
  replayPublication: (endpointId: string, publicationId: string) =>
    api.post<void>(
      `/chat-endpoints/${endpointId}/publications/${publicationId}/replay`,
      {},
    ),
  resolvePublication: (
    endpointId: string,
    publicationId: string,
    action: "mark_delivered" | "retry_anyway" | "cancel",
  ) =>
    api.post<void>(
      `/chat-endpoints/${endpointId}/publications/${publicationId}/resolve`,
      { action },
    ),
  publishComment: (
    endpointId: string,
    conversationId: string,
    commentId: string,
  ) =>
    api.post<void>(
      `/chat-endpoints/${endpointId}/conversations/${conversationId}/publications`,
      { commentId },
    ),
  publishBoardMessage: (
    endpointId: string,
    conversationId: string,
    body: string,
    idempotencyKey: string,
  ) =>
    api.post<void>(
      `/chat-endpoints/${endpointId}/conversations/${conversationId}/publications`,
      { body, idempotencyKey },
    ),
};
