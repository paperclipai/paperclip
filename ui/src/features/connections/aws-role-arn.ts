import { getAppStoreDefinition } from "@paperclipai/shared";

/**
 * The app definition's role ARN rule (a server test keeps it equal to the server's), so this
 * check matches what the server accepts. Without a definition the server alone decides.
 */
export const ROLE_ARN_PATTERN = new RegExp(
  getAppStoreDefinition("aws")?.methods.find((method) => method.key === "aws-role")
    ?.tenantFields?.find((field) => field.key === "roleArn")?.validation?.pattern ?? "^arn:",
);

/**
 * The role ARN an agent reported in its finish summary, accepted only when it names this
 * connection's own role, so a summary can never point the connection at another role. An ARN
 * that continues past the role name (`…/<roleName>/other`) names a different role and is rejected.
 */
export function roleArnFromAgentSummary(summary: string | null | undefined, roleName: string): string | null {
  const escaped = roleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = summary?.match(new RegExp(`arn:aws[a-z-]*:iam::\\d{12}:role/(?:[\\w+=,.@-]+/)*${escaped}(?![\\w+=,@/-]|\\.[\\w+=,@/-])`));
  return match && ROLE_ARN_PATTERN.test(match[0]) ? match[0] : null;
}
