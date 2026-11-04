import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";
import type { GitHubReviewEventContext, GitHubIssueEventContext, GitHubReviewPolicy } from "@paperclipai/shared";

import {
  chatDeliveries,
} from "@paperclipai/db";

import type {
  Message,
} from "chat";

type GitHubMessageProvenanceOptions = {
  githubManualMessages: WeakMap<object, { policy: GitHubReviewPolicy; revision: number; event: "mention" | "comment" }>;
  githubAutomaticMessages: WeakMap<object, { context: GitHubReviewEventContext; revision: number; policy: GitHubReviewPolicy }>;
  githubIssueMessages: WeakMap<object, { context: GitHubIssueEventContext; revision: number; policy: GitHubReviewPolicy }>;
};
export function createGitHubMessageProvenance(options: GitHubMessageProvenanceOptions) {
  const { githubManualMessages, githubAutomaticMessages, githubIssueMessages } = options;
  function restoreGitHubMessageProvenance(delivery: typeof chatDeliveries.$inferSelect, endpointRuntime: Pick<ChatEndpointRuntime, "provider">, message: Message): void {
const githubManual = delivery.normalizedEvent.githubManual;
    if (endpointRuntime.provider === "github" && githubManual && typeof githubManual === "object") githubManualMessages.set(message, githubManual as { policy: GitHubReviewPolicy; revision: number; event: "mention" | "comment" });
    const githubAutomatic = delivery.normalizedEvent.githubAutomatic;
    if (endpointRuntime.provider === "github" && githubAutomatic && typeof githubAutomatic === "object") {
      githubAutomaticMessages.set(message, githubAutomatic as { context: GitHubReviewEventContext; revision: number; policy: GitHubReviewPolicy });
    }
    const githubIssue = delivery.normalizedEvent.githubIssue;
    if (endpointRuntime.provider === "github" && githubIssue && typeof githubIssue === "object") {
      githubIssueMessages.set(message, githubIssue as { context: GitHubIssueEventContext; revision: number; policy: GitHubReviewPolicy });
    }
  }
  return { restoreGitHubMessageProvenance };
}
