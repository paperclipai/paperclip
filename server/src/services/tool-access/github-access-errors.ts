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
