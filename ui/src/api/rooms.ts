import { api } from "./client";

export interface Room {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status: string;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoomParticipant {
  id: string;
  roomId: string;
  agentId: string | null;
  userId: string | null;
  role: string;
  joinedAt: string;
}

export interface RoomAttachment {
  assetId: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
  thumbnailUrl?: string | null;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  senderAgentId: string | null;
  senderUserId: string | null;
  type: string;
  body: string;
  attachments: RoomAttachment[] | null;
  actionPayload: Record<string, unknown> | null;
  actionStatus: string | null;
  actionTargetAgentId: string | null;
  actionResult: Record<string, unknown> | null;
  actionError: string | null;
  actionExecutedAt: string | null;
  actionExecutedByAgentId: string | null;
  actionExecutedByUserId: string | null;
  // Phase 5.2f — optional FK to an approvals row that gates the
  // "Mark executed" transition. null for text messages and for
  // action messages created without `requiresApproval`.
  approvalId?: string | null;
  replyToId: string | null;
  createdAt: string;
}

export interface RoomIssueLink {
  roomId: string;
  issueId: string;
  linkedAt: string;
  issue: { id: string; identifier: string | null; title: string; status: string };
}

export const roomsApi = {
  list: (companyId: string) => api.get<Room[]>(`/companies/${companyId}/rooms`),
  get: (companyId: string, roomId: string) =>
    api.get<Room>(`/companies/${companyId}/rooms/${roomId}`),
  create: (companyId: string, data: { name: string; description?: string | null }) =>
    api.post<Room>(`/companies/${companyId}/rooms`, data),
  update: (companyId: string, roomId: string, data: Partial<Room>) =>
    api.patch<Room>(`/companies/${companyId}/rooms/${roomId}`, data),
  archive: (companyId: string, roomId: string) =>
    api.delete<Room>(`/companies/${companyId}/rooms/${roomId}`),

  listParticipants: (companyId: string, roomId: string) =>
    api.get<RoomParticipant[]>(`/companies/${companyId}/rooms/${roomId}/participants`),
  addParticipant: (
    companyId: string,
    roomId: string,
    data: { agentId?: string; userId?: string; role?: string },
  ) => api.post<RoomParticipant>(`/companies/${companyId}/rooms/${roomId}/participants`, data),
  removeParticipant: (companyId: string, roomId: string, participantId: string) =>
    api.delete<RoomParticipant>(
      `/companies/${companyId}/rooms/${roomId}/participants/${participantId}`,
    ),

  listMessages: (companyId: string, roomId: string, opts?: { limit?: number; before?: string }) => {
    const params = new URLSearchParams();
    params.set("limit", String(opts?.limit ?? 50));
    if (opts?.before) params.set("before", opts.before);
    return api.get<RoomMessage[]>(`/companies/${companyId}/rooms/${roomId}/messages?${params}`);
  },
  sendMessage: (
    companyId: string,
    roomId: string,
    data: {
      type?: string;
      body: string;
      attachments?: RoomAttachment[] | null;
      actionPayload?: Record<string, unknown> | null;
      actionTargetAgentId?: string | null;
      replyToId?: string | null;
      // Phase 5.2f — gate the "Mark executed" transition on an
      // approval. Only valid for action messages (server rejects
      // otherwise). Optional, default false.
      requiresApproval?: boolean;
    },
  ) => api.post<RoomMessage>(`/companies/${companyId}/rooms/${roomId}/messages`, data),

  uploadAttachment: async (
    companyId: string,
    roomId: string,
    file: File,
  ): Promise<RoomAttachment> => {
    const buffer = await file.arrayBuffer();
    const safeFile = new File([buffer], file.name || "file", { type: file.type || "application/octet-stream" });
    const form = new FormData();
    form.append("file", safeFile);
    return api.postForm<RoomAttachment>(
      `/companies/${companyId}/rooms/${roomId}/attachments`,
      form,
    );
  },
  updateActionStatus: (
    companyId: string,
    roomId: string,
    messageId: string,
    actionStatus: string,
    extras?: { result?: Record<string, unknown>; error?: string },
  ) =>
    api.patch<RoomMessage>(
      `/companies/${companyId}/rooms/${roomId}/messages/${messageId}/action-status`,
      { actionStatus, ...extras },
    ),

  listIssues: (companyId: string, roomId: string) =>
    api.get<RoomIssueLink[]>(`/companies/${companyId}/rooms/${roomId}/issues`),
  linkIssue: (companyId: string, roomId: string, issueId: string) =>
    api.post<RoomIssueLink>(`/companies/${companyId}/rooms/${roomId}/issues`, { issueId }),
  unlinkIssue: (companyId: string, roomId: string, issueId: string) =>
    api.delete<RoomIssueLink>(`/companies/${companyId}/rooms/${roomId}/issues/${issueId}`),
};
