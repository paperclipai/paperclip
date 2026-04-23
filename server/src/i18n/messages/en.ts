import type { ServerMessageKey } from "../types.js";

export const enMessages: Record<ServerMessageKey, string> = {
  "errors.validation": "Validation error",
  "errors.internal": "Internal server error",
  "errors.auth.board_required": "Board access required",
  "errors.auth.instance_admin_required": "Instance admin access required",
  "errors.auth.company_membership_or_instance_admin_required": "Company membership or instance admin access required",
  "errors.auth.agent_authentication_required": "Agent authentication required",
  "errors.auth.agent_cross_company_access": "Agent key cannot access another company",
  "errors.auth.company_access_required": "User does not have access to this company",
  "errors.auth.active_company_access_required": "User does not have active company access",
  "errors.auth.viewer_read_only": "Viewer access is read-only",
  "errors.company.not_found": "Company not found",
  "errors.company.ceo_or_board_required": "Only CEO agents or board users may update company settings",
};
