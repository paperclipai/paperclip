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

export interface RoomMessage {
  id: string;
  roomId: string;
  senderAgentId: string | null;
  senderUserId: string | null;
  type: string;
  body: string;
  actionPayload: Record<string, unknown> | null;
  actionStatus: string | null;
  actionTargetAgentId: string | null;
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

  listMessages: (companyId: string, roomId: string, limit = 100) =>
    api.get<RoomMessage[]>(`/companies/${companyId}/rooms/${roomId}/messages?limit=${limit}`),
  sendMessage: (
    companyId: string,
    roomId: string,
    data: {
      type?: string;
      body: string;
      actionPayload?: Record<string, unknown> | null;
      actionTargetAgentId?: string | null;
      replyToId?: string | null;
    },
  ) => api.post<RoomMessage>(`/companies/${companyId}/rooms/${roomId}/messages`, data),
  updateActionStatus: (
    companyId: string,
    roomId: string,
    messageId: string,
    actionStatus: string,
  ) =>
    api.patch<RoomMessage>(
      `/companies/${companyId}/rooms/${roomId}/messages/${messageId}/action-status`,
      { actionStatus },
    ),

  listIssues: (companyId: string, roomId: string) =>
    api.get<RoomIssueLink[]>(`/companies/${companyId}/rooms/${roomId}/issues`),
  linkIssue: (companyId: string, roomId: string, issueId: string) =>
    api.post<RoomIssueLink>(`/companies/${companyId}/rooms/${roomId}/issues`, { issueId }),
  unlinkIssue: (companyId: string, roomId: string, issueId: string) =>
    api.delete<RoomIssueLink>(`/companies/${companyId}/rooms/${roomId}/issues/${issueId}`),
};
