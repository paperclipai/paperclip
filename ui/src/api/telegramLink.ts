import {
  telegramLinkStatusSchema,
  type TelegramLinkStatus,
} from "@paperclipai/shared";

async function parseStatus(res: Response): Promise<TelegramLinkStatus> {
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
        ? ((payload as { error: string }).error)
        : null) ?? `Request failed (${res.status})`;
    throw new Error(message);
  }
  return telegramLinkStatusSchema.parse(payload);
}

export const telegramLinkApi = {
  get: async (): Promise<TelegramLinkStatus> => {
    const res = await fetch("/api/users/me/telegram-link", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    return parseStatus(res);
  },

  link: async (code: string): Promise<TelegramLinkStatus> => {
    const res = await fetch("/api/users/me/telegram-link", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code }),
    });
    return parseStatus(res);
  },

  unlink: async (): Promise<TelegramLinkStatus> => {
    const res = await fetch("/api/users/me/telegram-link", {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    return parseStatus(res);
  },
};
