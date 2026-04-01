import { api } from "./client";

export interface MessagingBridge {
  id: string;
  companyId: string;
  platform: "telegram" | "email" | "slack" | "discord";
  status: "connected" | "disconnected" | "error";
  lastError: string | null;
  config: Record<string, unknown>;
  secretId: string | null;
  running?: boolean;
  botUsername?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessagingBridgesResponse {
  bridges: MessagingBridge[];
  email: {
    address: string | null;
    status: string;
    note: string;
  };
  platforms: {
    supported: string[];
    comingSoon: string[];
  };
}

export interface TelegramTestResult {
  ok: boolean;
  botUsername?: string;
  running?: boolean;
  status?: string;
  error?: string;
}

export const messagingApi = {
  listBridges: (companyId: string) =>
    api.get<MessagingBridgesResponse>(`/companies/${companyId}/messaging/bridges`),

  configureTelegram: (companyId: string, token: string) =>
    api.post<MessagingBridge>(`/companies/${companyId}/messaging/telegram`, { token }),

  removeTelegram: (companyId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/messaging/telegram`),

  testTelegram: (companyId: string) =>
    api.post<TelegramTestResult>(`/companies/${companyId}/messaging/telegram/test`, {}),
};
