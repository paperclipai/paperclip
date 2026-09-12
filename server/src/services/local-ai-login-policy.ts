import type { DeploymentMode, DeploymentExposure } from "@paperclipai/shared";

/** Same server-host boundary as local stdio runtimes. */
export function supportsLocalAiLogin(options: {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
  trustedLocalStdioRuntimeHost?: string | null;
}) {
  return options.deploymentMode !== "authenticated" || options.deploymentExposure !== "public" || Boolean(
    options.trustedLocalStdioRuntimeHost ?? process.env.PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST ?? process.env.PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST,
  );
}
