export const GITHUB_APP_PERMISSION_DENIED_REASON = "github_app_permission_denied";

// GitHub answers with this exact text only for GitHub App tokens (installation
// or user-to-server) whose App lacks the permission or repository selection
// the endpoint needs. Retrying or re-approving in Paperclip cannot change that.
const GITHUB_INTEGRATION_FORBIDDEN = /\b403\b[^\n]*Resource not accessible by integration/i;

function normalizedOperation(upstreamToolName: string | null | undefined): string {
  return (upstreamToolName ?? "").trim().toLowerCase().replace(/-/g, "_");
}

/**
 * Explains a GitHub App permission refusal in terms the approver and agent can
 * act on. Returns null for every other provider error.
 */
export function describeGitHubAppPermissionDenial(input: {
  message: string;
  upstreamToolName?: string | null;
}): string | null {
  if (!GITHUB_INTEGRATION_FORBIDDEN.test(input.message)) return null;
  const githubSaid = `GitHub said: ${input.message.trim()}`;
  if (normalizedOperation(input.upstreamToolName) === "create_repository") {
    return [
      "The Paperclip GitHub App is not allowed to create repositories for this GitHub account or organization, so GitHub refused the request.",
      "Approving the action again cannot grant this GitHub permission.",
      "To continue: create the repository at https://github.com/new, give the Paperclip GitHub App access to it (Configure on GitHub),",
      "select Refresh access on the GitHub connection in Paperclip, then ask the agent to use the existing repository.",
      githubSaid,
    ].join(" ");
  }
  return [
    "GitHub refused this action because the Paperclip GitHub App does not have the GitHub permission it needs, or the repository is not selected for the App installation.",
    "Approving the action again cannot grant this GitHub permission.",
    "To continue: open Configure on GitHub from the GitHub connection in Paperclip, add the repository or approve the requested permission,",
    "select Refresh access, then ask the agent to retry.",
    githubSaid,
  ].join(" ");
}

/**
 * Classifies a provider-reported tool failure, upgrading a GitHub App
 * permission refusal to an actionable reason code and message.
 */
export function classifyProviderToolFailure(input: {
  message: string;
  reasonCode: string;
  upstreamToolName?: string | null;
}): { message: string; reasonCode: string } {
  const guidance = describeGitHubAppPermissionDenial(input);
  return guidance
    ? { message: guidance, reasonCode: GITHUB_APP_PERMISSION_DENIED_REASON }
    : { message: input.message, reasonCode: input.reasonCode };
}
