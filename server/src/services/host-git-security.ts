import os from "node:os";
import path from "node:path";
import { assertIsolatedWorkspaceSyncAllowed } from "@paperclipai/adapter-utils/isolated-workspace-guard";

/** Git must not read agent-controlled metadata before the sandbox sync guard runs. */
export async function assertHostGitWorkspaceAllowed(cwd: string): Promise<string> {
  if (process.env.PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME !== "true") return cwd;
  // Git must use this canonical path. The original cwd may cross an alias in an
  // agent-writable directory that can be retargeted after the guard returns.
  return assertIsolatedWorkspaceSyncAllowed(path.resolve(cwd));
}

/** Apply to every host Git process that can run while the service owns the master key. */
export function prepareHostGitInvocation(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: NodeJS.ProcessEnv } {
  if (process.env.PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME !== "true") {
    return { args, env };
  }

  // Ambient GIT_CONFIG_*, GIT_TEMPLATE_DIR, GIT_SSH_COMMAND and GIT_ASKPASS can
  // redirect config or launch commands even if repository config is immutable.
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("GIT_") && key !== "SSH_ASKPASS" && key !== "SSH_ASKPASS_REQUIRE"),
  );
  return {
    args: [
      "-c", `core.hooksPath=${os.devNull}`,
      "-c", "core.fsmonitor=false",
      "-c", `init.templateDir=${os.devNull}`,
      ...args,
    ],
    env: {
      ...cleanEnv,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_ALLOW_PROTOCOL: "https:http:ssh:git",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -F /dev/null -o BatchMode=yes",
    },
  };
}
