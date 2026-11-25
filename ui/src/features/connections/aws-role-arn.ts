import { getAppStoreDefinition } from "@paperclipai/shared";

/** An IAM role ARN, the same shape the AWS app definition requires. */
const IAM_ROLE_ARN_SHAPE = "^arn:aws[a-z-]*:iam::[0-9]{12}:role/(?:[A-Za-z0-9+=,.@_-]+/)*[A-Za-z0-9+=,.@_-]{1,64}$";

/**
 * The app definition's role ARN rule (a server test keeps it equal to the server's), so this
 * check matches what the server accepts. Without a definition it still requires an IAM role ARN.
 */
export const ROLE_ARN_PATTERN = new RegExp(
  getAppStoreDefinition("aws")?.methods.find((method) => method.key === "aws-role")
    ?.tenantFields?.find((field) => field.key === "roleArn")?.validation?.pattern ?? IAM_ROLE_ARN_SHAPE,
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
