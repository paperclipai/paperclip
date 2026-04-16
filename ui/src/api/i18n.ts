import type { I18nConfig } from "@paperclipai/shared";
import { api } from "./client";

export const i18nApi = {
  getConfig: () => api.get<I18nConfig>("/i18n/config"),
};
