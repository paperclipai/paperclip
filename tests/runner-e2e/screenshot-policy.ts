export const PUBLIC_RUNNER_SCREENSHOT_MARKER = "public-runner-fixture" as const;

export interface PublicRunnerScreenshotTarget {
  chatAgentId?: string;
  issuePrefix: string | null | undefined;
  issueId: string | null | undefined;
  issueIdentifier: string | null | undefined;
  caseId?: string;
  caseIdentifier?: string;
}

export function isPublicRunnerScreenshotRoute(
  url: string,
  target: PublicRunnerScreenshotTarget,
) {
  try {
    if (!target.issuePrefix || !target.issueId) return false;
    const candidate = new URL(url);
    const issueReference = target.issueIdentifier ?? target.issueId;
    const expectedPath = `/${encodeURIComponent(target.issuePrefix)}/issues/${encodeURIComponent(issueReference)}`;
    const chatPath = target.chatAgentId ? `/${encodeURIComponent(target.issuePrefix)}/chats/${encodeURIComponent(target.chatAgentId)}` : null;
    const casePath = target.caseId ? `/${encodeURIComponent(target.issuePrefix)}/cases/${encodeURIComponent(target.caseIdentifier ?? target.caseId)}` : null;
    return (
      candidate.protocol === "http:" &&
      candidate.hostname === "127.0.0.1" &&
      (candidate.pathname === chatPath ||
        candidate.pathname === casePath ||
        candidate.pathname === expectedPath ||
        candidate.pathname === `${expectedPath}/`)
    );
  } catch {
    return false;
  }
}

/** The one zero-task chat boundary has no source issue. Its resource identity
 * must be independently read through the actual signed-in page before capture.
 */
export function isDisabledChatBoundaryScreenshotRoute(url: string, target: {
  scenarioId: string; origin: string; companyId: string; agentCompanyId: string;
  issuePrefix: string; agentId: string; authenticatedPersonId: string; agentChatEnabled: boolean;
}) {
  try {
    const candidate = new URL(url), origin = new URL(target.origin);
    return target.scenarioId === "agent-chat.chat-disabled" && target.agentChatEnabled === false && !!target.companyId && target.agentCompanyId === target.companyId
      && !!target.authenticatedPersonId && target.authenticatedPersonId !== "local-board" && !!target.agentId && !!target.issuePrefix
      && origin.protocol === "http:" && origin.hostname === "127.0.0.1" && candidate.origin === origin.origin
      && !candidate.username && !candidate.password && !candidate.search && !candidate.hash
      && candidate.pathname === `/${encodeURIComponent(target.issuePrefix)}/chats/${encodeURIComponent(target.agentId)}`;
  } catch { return false; }
}
