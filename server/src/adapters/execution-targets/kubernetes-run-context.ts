import type { AdapterKubernetesExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type {
  ResolvedClusterConnection,
  ResolvedRunContext,
} from "@paperclipai/execution-target-kubernetes";
import { buildAdapterManagedWorkspaceRequestJson } from "./workspace-strategy-json.js";

export function buildKubernetesRunContext(input: {
  companyName: string;
  target: AdapterKubernetesExecutionTarget;
  connection: ResolvedClusterConnection;
  paperclipApiUrl?: string;
}): ResolvedRunContext {
  const companySlug = input.companyName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "company";
  const imageRegistry =
    input.connection.imageRegistry?.replace(/\/+$/, "") ?? "ghcr.io/paperclipai";
  const defaultImage = `${imageRegistry}/agent-runtime-claude:v1`;
  return {
    companySlug,
    image:
      input.connection.allowAgentImageOverride && input.target.imageOverride
        ? input.target.imageOverride
        : defaultImage,
    initImage: `${imageRegistry}/agent-runtime-base:v1`,
    paperclipPublicUrl:
      input.connection.paperclipPublicUrl ??
      input.paperclipApiUrl ??
      process.env.PAPERCLIP_API_URL ??
      "",
    workspaceStrategyJson: buildAdapterManagedWorkspaceRequestJson(),
    workspaceStrategyKey: "ephemeral",
    adapterEnv: input.target.envOverrides ? { ...input.target.envOverrides } : undefined,
    storageSizeGi: input.target.storage?.sizeGi,
    storageClassName: input.target.storage?.storageClass,
  };
}
