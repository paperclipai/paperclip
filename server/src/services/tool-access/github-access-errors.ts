import type { RequestConfirmationPayload, RequestConfirmationResult } from "@paperclipai/shared";

/** GitHub reports repository permission failures inside successful MCP HTTP
 * responses. Do not infer that every 403 is an access problem (rate limits also
 * use 403), or echo provider response text into the repair instructions. */
export function githubAccessError(sourceTemplateKey: unknown, message: unknown) {
  if (sourceTemplateKey !== "github" || typeof message !== "string" ||
      !/\b403\b[^\n]*\bResource not accessible by (?:integration|personal access token)\b/i.test(message)) return null;
  return { errorCode: "github_access_denied" as const };
}

/** Upgrade the display of already saved tool errors; retain the stored error
 * and decision. Only server-authored GitHub tool cards use this projection. */
export function projectGitHubActionResult(payload: RequestConfirmationPayload, result: RequestConfirmationResult | null): RequestConfirmationResult | null {
  const action = result?.toolAction;
  if (!action || action.status !== "failed" || action.errorCode !== "tool_error" || payload.toolAction?.appDisplayName !== "GitHub") return result;
  const failure = githubAccessError("github", action.errorMessage);
  return failure ? { ...result, toolAction: { ...action, ...failure } } : result;
}
