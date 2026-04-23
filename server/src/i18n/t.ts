import type { ServerLocale, ServerMessageKey } from "./types.js";
import { enMessages } from "./messages/en.js";
import { zhCnMessages } from "./messages/zh-CN.js";

const catalogs = {
  en: enMessages,
  "zh-CN": zhCnMessages,
} as const;

const messageKeyByEnglishText = new Map<string, ServerMessageKey>([
  [enMessages["errors.auth.board_required"], "errors.auth.board_required"],
  [enMessages["errors.auth.instance_admin_required"], "errors.auth.instance_admin_required"],
  [
    enMessages["errors.auth.company_membership_or_instance_admin_required"],
    "errors.auth.company_membership_or_instance_admin_required",
  ],
  [enMessages["errors.auth.agent_authentication_required"], "errors.auth.agent_authentication_required"],
  [enMessages["errors.auth.agent_cross_company_access"], "errors.auth.agent_cross_company_access"],
  [enMessages["errors.auth.company_access_required"], "errors.auth.company_access_required"],
  [enMessages["errors.auth.active_company_access_required"], "errors.auth.active_company_access_required"],
  [enMessages["errors.auth.viewer_read_only"], "errors.auth.viewer_read_only"],
  [enMessages["errors.company.not_found"], "errors.company.not_found"],
  [enMessages["errors.company.ceo_or_board_required"], "errors.company.ceo_or_board_required"],
]);

export function t(locale: ServerLocale, key: ServerMessageKey) {
  return catalogs[locale][key] ?? catalogs.en[key];
}

export function translateKnownErrorMessage(locale: ServerLocale, message: string) {
  const key = messageKeyByEnglishText.get(message);
  return key ? t(locale, key) : message;
}
