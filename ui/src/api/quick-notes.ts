import { api } from "./client";

export interface QuickNote {
  id: string;
  companyId: string;
  userId: string;
  text: string;
  status: string; // 'new' | 'researching' | 'has_suggestions' | 'dismissed'
  dismissed: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuickNoteThread {
  id: string;
  noteId: string;
  authorType: string; // 'user' | 'agent'
  authorId: string;
  body: string;
  createdAt: string;
}

export const quickNotesApi = {
  list: (companyId: string, includeDismissed = false) =>
    api.get<QuickNote[]>(
      `/companies/${companyId}/quick-notes${includeDismissed ? "?includeDismissed=true" : ""}`,
    ),

  create: (companyId: string, data: { text: string; metadata?: Record<string, unknown> }) =>
    api.post<QuickNote>(`/companies/${companyId}/quick-notes`, data),

  get: (noteId: string) => api.get<QuickNote>(`/quick-notes/${noteId}`),

  update: (noteId: string, data: { text?: string; status?: string; dismissed?: boolean }) =>
    api.patch<QuickNote>(`/quick-notes/${noteId}`, data),

  remove: (noteId: string) => api.delete<void>(`/quick-notes/${noteId}`),

  listThreads: (noteId: string) => api.get<QuickNoteThread[]>(`/quick-notes/${noteId}/threads`),

  addThread: (noteId: string, body: string) =>
    api.post<QuickNoteThread>(`/quick-notes/${noteId}/threads`, { body }),
};
