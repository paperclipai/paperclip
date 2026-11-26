import { onTestFinished } from "vitest";
import { GOOGLE_WORKSPACE_TOOL_TRANSPORT, type GoogleWorkspaceService } from "@paperclipai/shared";

export function useGoogleMcpTransport() {
  const saved = { ...GOOGLE_WORKSPACE_TOOL_TRANSPORT };
  for (const service of Object.keys(saved) as GoogleWorkspaceService[]) GOOGLE_WORKSPACE_TOOL_TRANSPORT[service] = "google_mcp";
  onTestFinished(() => {
    Object.assign(GOOGLE_WORKSPACE_TOOL_TRANSPORT, saved);
  });
}
