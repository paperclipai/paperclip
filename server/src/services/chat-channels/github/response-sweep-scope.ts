import type { ChatResponseScope } from "../../chat-response-availability.js";

export type GitHubResponseSweepScope = ChatResponseScope & { endpointId?: string; repositoryId?: string; number?: number };

export const GITHUB_RESPONSE_COMPANY_RECONSTRUCTION_MS = 30_000;

export function githubResponseReconstructionIntervalMs(scope: GitHubResponseSweepScope | undefined) {
  return scope && !scope.issueId && !scope.deliveryId && !scope.conversationId && !scope.endpointId
    && !scope.repositoryId && !scope.number ? GITHUB_RESPONSE_COMPANY_RECONSTRUCTION_MS : 0;
}
