import { api } from "./client";

export type UserProfile = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: string;
  memberships: Array<{
    companyId: string;
    membershipRole: string | null;
    status: string;
  }>;
};

export type UserSession = {
  id: string;
  createdAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  isCurrent: boolean;
};

export const usersApi = {
  getMe: () => api.get<UserProfile>("/users/me"),

  updateMe: (data: { name?: string; email?: string }) =>
    api.patch<{ id: string; name: string; email: string; image: string | null }>(
      "/users/me",
      data,
    ),

  uploadAvatar: (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return api.postForm<{ avatarUrl: string }>("/users/me/avatar", formData);
  },

  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    api.post<{ success: boolean }>("/users/me/change-password", data),

  listSessions: () => api.get<UserSession[]>("/users/me/sessions"),

  revokeSession: (sessionId: string) =>
    api.post<{ revoked: boolean }>(
      `/users/me/sessions/${sessionId}/revoke`,
      {},
    ),

  revokeAllSessions: () =>
    api.post<{ revoked: boolean }>("/users/me/sessions/revoke-all", {}),

  forgotPassword: (email: string) =>
    api.post<{ sent: boolean }>("/users/forgot-password", { email }),

  resetPassword: (token: string, newPassword: string) =>
    api.post<{ success: boolean }>("/users/reset-password", { token, newPassword }),
};
