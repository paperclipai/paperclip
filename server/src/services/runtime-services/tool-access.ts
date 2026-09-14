import type { AdapterRuntimeServiceAccess } from "@paperclipai/adapter-utils";
import { RUNTIME_SERVICE_AGENT_GUIDANCE, RUNTIME_SERVICE_TOOL_NAMES } from "@paperclipai/shared";
import { createRuntimeToolsToken } from "../../runtime-tools-token.js";

export function createRuntimeServiceToolAccess(input: {
  agentId: string; companyId: string; runId: string; responsibleUserId: string | null; baseUrl: string | null;
}): AdapterRuntimeServiceAccess | undefined {
  if (!input.baseUrl) return undefined;
  const minted = createRuntimeToolsToken({ ...input, responsibleUserId: input.responsibleUserId ?? "", scope: "runtime_services" });
  if (!minted) return undefined;
  const base = input.baseUrl.replace(/\/$/, "");
  return Object.freeze({
    version: 1, guidance: RUNTIME_SERVICE_AGENT_GUIDANCE,
    mcpEndpoint: `${base}/mcp/runtime-services`, callEndpoint: `${base}/runtime-tools/services/call`,
    bearerToken: minted.token, expiresAt: minted.expiresAt, tools: RUNTIME_SERVICE_TOOL_NAMES,
  });
}
