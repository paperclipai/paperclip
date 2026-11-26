import type { DeploymentMode, DeploymentExposure } from "@paperclipai/shared";

export type LocalAiLoginPolicyOptions = {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
  trustedLocalStdioRuntimeHost?: string | null;
};

/** Same server-host boundary as local stdio runtimes. */
export function supportsLocalAiLogin(options: LocalAiLoginPolicyOptions) {
  return options.deploymentMode !== "authenticated" || options.deploymentExposure !== "public" || Boolean(
    options.trustedLocalStdioRuntimeHost ?? process.env.PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST ?? process.env.PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST,
  );
}

/**
 * Antigravity Google sign-in launches Paperclip's pinned, isolated
 * `agy_acp_server.par` closure with a private per-attempt home rather than
 * touching an ambient host CLI, so authenticated public deployments can safely
 * relay the user's pasted loopback redirect.
 */
export function supportsHostedGoogleAiLogin(_options: LocalAiLoginPolicyOptions = {}) {
  return true;
}
