import type { ServerMessageKey } from "../types.js";

export const zhCnMessages: Record<ServerMessageKey, string> = {
  "errors.validation": "验证错误",
  "errors.internal": "内部服务器错误",
  "errors.auth.board_required": "需要 board 访问权限",
  "errors.auth.instance_admin_required": "需要实例管理员权限",
  "errors.auth.company_membership_or_instance_admin_required": "需要公司成员身份或实例管理员权限",
  "errors.auth.agent_authentication_required": "需要代理身份认证",
  "errors.auth.agent_cross_company_access": "代理密钥不能访问其他公司",
  "errors.auth.company_access_required": "当前用户无权访问该公司",
  "errors.auth.active_company_access_required": "当前用户没有有效的公司访问权限",
  "errors.auth.viewer_read_only": "查看者权限为只读",
  "errors.company.not_found": "未找到公司",
  "errors.company.ceo_or_board_required": "只有 CEO 代理或 board 用户可以更新公司设置",
};
