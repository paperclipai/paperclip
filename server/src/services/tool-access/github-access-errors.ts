import type { RequestConfirmationResult } from "@paperclipai/shared";

/** GitHub reports repository permission failures inside successful MCP HTTP
 * responses. Do not infer that every 403 is an access problem (rate limits also
 * use 403), or echo provider response text into the repair instructions. */
export function githubAccessError(sourceTemplateKey: unknown, message: unknown) {
  if (sourceTemplateKey !== "github" || typeof message !== "string" ||
      !/\b403\s+Resource not accessible by (?:integration|personal access token)\b/i.test(message.slice(0, 4000))) return null;
  return { errorCode: "github_access_denied" as const };
}

/** Upgrade already saved tool errors using verified connection identity. Retain
 * the stored error and decision, including both legacy invocation error codes. */
export function projectGitHubActionResult(sourceTemplateKey: unknown, result: RequestConfirmationResult | null | undefined): RequestConfirmationResult | null | undefined {
  const action = result?.toolAction;
  if (!action || action.status !== "failed" ||
      (action.errorCode !== "tool_error" && action.errorCode !== "tool_execution_failed")) return result;
  const failure = githubAccessError(sourceTemplateKey, action.errorMessage);
  return failure ? { ...result, toolAction: { ...action, ...failure } } : result;
}

/** Trusted, server-authored next steps for the agent after GitHub denied an
 * approved action. Access must be repaired before another attempt. The
 * provider text stays in the untrusted result, never in these instructions. */
export function githubAccessDeniedInstructions(toolName: string, connectionMethodKey: unknown = null): string {
  const operation = (toolName.split(":").pop() ?? "").trim().toLowerCase().replace(/-/g, "_");
  const base = "GitHub denied this approved action because the Paperclip GitHub connection cannot access the requested account or repository. Do not retry or request approval for the same call until GitHub access is repaired. Never automatically replay the stored approval.";
  if (connectionMethodKey === "mcp-key") {
    return `${base} Ask the user to check the personal access token's resource owner, repository selection and required permissions in GitHub. They must update or replace the token on the GitHub connection's Permissions page. Continue after they confirm the access change.`;
  }
  if (connectionMethodKey !== "managed") {
    return `${base} Ask the user to open the GitHub connection's Permissions page and check its connected account, authentication method and requested repository access. Continue after they repair that connection.`;
  }
  if (operation === "create_repository") {
    return `${base} Tell the user that Paperclip cannot create this repository with the current GitHub access. Ask them to create the repository at https://github.com/new, give the Paperclip GitHub App access to it, and select Refresh access on the GitHub connection's Permissions page. Then continue with that existing repository.`;
  }
  return `${base} Tell the user which account or repository you need. Ask them to give the Paperclip GitHub App access from the GitHub connection's Permissions page and select Refresh access. Continue after they confirm.`;
}
