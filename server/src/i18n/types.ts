import type { Request } from "express";
import type { SupportedLocale } from "@paperclipai/shared";

export type ServerLocale = SupportedLocale;

export type ServerMessageKey =
  | "errors.validation"
  | "errors.internal"
  | "errors.auth.board_required"
  | "errors.auth.instance_admin_required"
  | "errors.auth.company_membership_or_instance_admin_required"
  | "errors.auth.agent_authentication_required"
  | "errors.auth.agent_cross_company_access"
  | "errors.auth.company_access_required"
  | "errors.auth.active_company_access_required"
  | "errors.auth.viewer_read_only"
  | "errors.company.not_found"
  | "errors.company.ceo_or_board_required";

export type LocalizedRequest = Request & {
  locale?: ServerLocale;
};
