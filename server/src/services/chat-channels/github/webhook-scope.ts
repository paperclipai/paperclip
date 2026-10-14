import type { LifecycleRuntimeFence } from "../runtime-types.js";
import type { ChatSdkProvider } from "../../chat-sdk-runtime.js";
export type GitHubIngressContext = { githubIngressActionId: string; githubIngressFence: LifecycleRuntimeFence; superseded?: boolean };
export function createGitHubWebhookScope(provider: ChatSdkProvider, internalContext: GitHubIngressContext | undefined, responseBudgetMs: number | undefined, GITHUB_WEBHOOK_RESPONSE_BUDGET_MS: number) {
  const replayingDurableGitHubIngress =
    provider === "github" && Boolean(internalContext?.githubIngressActionId);
  const ignoreSupersededIngress = () => {
    if (internalContext) internalContext.superseded = true;
    return new Response("ignored", { status: 200 });
  };
  const matchesGitHubIngressFence = (context: LifecycleRuntimeFence) => {
    if (!replayingDurableGitHubIngress) return true;
    const matches =
      context.generation ===
      internalContext?.githubIngressFence?.generation &&
      context.credentialFingerprint ===
      internalContext?.githubIngressFence?.credentialFingerprint;
    if (!matches && internalContext) internalContext.superseded = true;
    return matches;
  };
  const githubResponseDeadlineAt =
    provider === "github" && !replayingDurableGitHubIngress
      ? Date.now() +
      Math.max(
        1,
        Math.min(
          responseBudgetMs ??
          GITHUB_WEBHOOK_RESPONSE_BUDGET_MS,
          9_000,
        ),
      )
      : null;
  const completeGitHubPreflightBeforeDeadline = async <T>(
    task: Promise<T>,
  ): Promise<
    { completed: true; value: T } | { completed: false; value?: never }
  > => {
    if (githubResponseDeadlineAt === null)
      return { completed: true, value: await task };
    const remaining = githubResponseDeadlineAt - Date.now();
    if (remaining <= 0) return { completed: false };
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        task.then((value) => ({ completed: true as const, value })),
        new Promise<{ completed: false; value?: never }>((resolve) => {
          timeout = setTimeout(
            () => resolve({ completed: false }),
            remaining,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  return { replayingDurableGitHubIngress, ignoreSupersededIngress, matchesGitHubIngressFence, githubResponseDeadlineAt, completeGitHubPreflightBeforeDeadline };
}
export type GitHubWebhookScope = ReturnType<typeof createGitHubWebhookScope>;
