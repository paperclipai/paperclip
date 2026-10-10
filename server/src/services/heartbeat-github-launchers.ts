import { createHash } from "node:crypto";
import { githubBrokerEnvironment } from "@paperclipai/adapter-utils/github-launcher";
import { cleanupGitHubOperationLaunchers, prepareGitHubOperationLaunchers } from "@paperclipai/adapter-utils/execution-target";

type LauncherInput = Parameters<typeof prepareGitHubOperationLaunchers>[0];

export async function prepareHeartbeatGitHubLaunchers(
  input: LauncherInput & {
    native: boolean;
    githubConfigured: boolean;
    agentId: string;
    brokerUrl: string;
    createBrokerToken: () => string;
  },
  prepareLaunchers = prepareGitHubOperationLaunchers,
  cleanupLaunchers = cleanupGitHubOperationLaunchers,
) {
  // Native configured access is owned by the provider session supervisor.
  // Defer staging until it has acquired that session; never mutate a live
  // process's authorization from heartbeat preparation.
  if (input.native && input.githubConfigured) {
    return { env: githubBrokerEnvironment(input.env, { url: "", token: "" }), cleanupLocation: null };
  }
  // An unconfigured sandbox has no managed GitHub identity to broker. Its
  // token-free wrappers still isolate image credentials, but may live as long
  // as the workspace so a warm provider never inherits a deleted run path.
  // Other adapter paths retain their run-scoped capability/retirement rules.
  const anonymous = input.native && !input.githubConfigured &&
    input.target?.kind === "remote" && input.target.transport === "sandbox";
  const location = {
    runId: anonymous
      ? `anonymous-${input.agentId}-${createHash("sha256").update(input.env.PATH ?? "").digest("hex").slice(0, 16)}`
      : input.runId,
    target: input.target,
  };
  const env = githubBrokerEnvironment(input.env, {
    url: anonymous ? "" : input.brokerUrl,
    token: anonymous ? "" : input.createBrokerToken(),
  });
  try {
    return {
      env: await prepareLaunchers({ ...location, cwd: input.cwd, env }),
      cleanupLocation: anonymous ? null : location,
    };
  } catch (error) {
    // The caller cannot retain a cleanup location until staging returns. Clean
    // partial run-specific files here, preserving the original staging failure.
    // Anonymous files may still belong to a live warm provider; never delete them.
    if (!anonymous) await cleanupLaunchers(location).catch(() => undefined);
    throw error;
  }
}
