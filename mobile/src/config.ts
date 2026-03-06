export type PaperclipDeploymentMode = "local_trusted" | "authenticated";

export interface PaperclipMobileConfig {
  apiUrl: string;
  companyId: string;
  agentId: string;
  runId: string;
  deploymentMode: PaperclipDeploymentMode;
  missing: string[];
}

const FALLBACK_API_URL = "http://127.0.0.1:3004";

export function getPaperclipConfig(): PaperclipMobileConfig {
  const apiUrl = (process.env.EXPO_PUBLIC_PAPERCLIP_API_URL ?? FALLBACK_API_URL).replace(
    /\/+$/,
    "",
  );
  const companyId = process.env.EXPO_PUBLIC_PAPERCLIP_COMPANY_ID ?? "";
  const agentId = process.env.EXPO_PUBLIC_PAPERCLIP_AGENT_ID ?? "";
  const runId = (process.env.EXPO_PUBLIC_PAPERCLIP_RUN_ID ?? "").trim();
  const deploymentMode =
    process.env.EXPO_PUBLIC_PAPERCLIP_DEPLOYMENT_MODE === "local_trusted"
      ? "local_trusted"
      : "authenticated";

  const missing: string[] = [];
  if (!companyId) {
    missing.push("EXPO_PUBLIC_PAPERCLIP_COMPANY_ID");
  }
  if (!agentId) {
    missing.push("EXPO_PUBLIC_PAPERCLIP_AGENT_ID");
  }

  return {
    apiUrl,
    companyId,
    agentId,
    runId,
    deploymentMode,
    missing,
  };
}

export function appConfigSummary(config: PaperclipMobileConfig): string {
  if (config.missing.length > 0) {
    return `Missing: ${config.missing.join(", ")}`;
  }

  return `Mode ${config.deploymentMode}, Company ${config.companyId.slice(0, 8)}..., Agent ${config.agentId.slice(0, 8)}...`;
}
