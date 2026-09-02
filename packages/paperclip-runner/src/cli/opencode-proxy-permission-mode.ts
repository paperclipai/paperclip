export type OpenCodeProxyPermissionMode = "allow" | "ask" | "deny";

export function parseOpenCodeProxyPermissionMode(
  value: string | undefined,
): OpenCodeProxyPermissionMode {
  const configured = value?.trim();
  if (!configured) return "ask";
  if (
    configured === "allow"
    || configured === "ask"
    || configured === "deny"
  ) {
    return configured;
  }
  throw new Error("PAPERCLIP_OPENCODE_PERMISSION_MODE is invalid");
}
