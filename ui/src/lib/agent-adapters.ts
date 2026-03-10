import type { AgentAdapterType } from "@paperclipai/shared";

export const adapterLabels: Record<string, string> = {
  claude_local: "Claude (local)",
  codex_local: "Codex (local)",
  opencode_local: "OpenCode (local)",
  hermes_gateway: "Hermes Gateway",
  hermes_local: "Hermes (local)",
  pi_local: "Pi (local)",
  cursor: "Cursor (local)",
  openclaw_gateway: "OpenClaw Gateway",
  process: "Process",
  http: "HTTP",
};

const LOCAL_CLI_ADAPTER_COMMANDS: Record<string, string> = {
  claude_local: "claude",
  codex_local: "codex",
  opencode_local: "opencode",
  hermes_local: "hermes",
  pi_local: "pi",
  cursor: "agent",
};

export const ENABLED_ADVANCED_ADAPTER_TYPES = new Set<AgentAdapterType>([
  "claude_local",
  "codex_local",
  "opencode_local",
  "hermes_gateway",
  "hermes_local",
  "pi_local",
  "cursor",
]);

export const ENABLED_INVITE_ADAPTER_TYPES = new Set<AgentAdapterType>([
  "claude_local",
  "codex_local",
  "opencode_local",
  "hermes_local",
  "cursor",
]);

export function isLocalCliAdapter(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOCAL_CLI_ADAPTER_COMMANDS, type);
}

export function getDefaultLocalAdapterCommand(type: string): string | null {
  return LOCAL_CLI_ADAPTER_COMMANDS[type] ?? null;
}

export function getLocalAdapterHelloProbeCommand(type: string, commandOverride?: string): string | null {
  if (!isLocalCliAdapter(type)) return null;
  const command = commandOverride?.trim() || getDefaultLocalAdapterCommand(type);
  if (!command) return null;

  switch (type) {
    case "cursor":
      return `${command} -p --mode ask --output-format json \"Respond with hello.\"`;
    case "codex_local":
      return `${command} exec --json -`;
    case "opencode_local":
      return `${command} run --format json \"Respond with hello.\"`;
    case "hermes_local":
      return `${command} chat -q \"Respond with exactly: hello\"`;
    case "pi_local":
      return `${command} -p \"Respond with hello.\" --mode json --tools read`;
    default:
      return `${command} --print - --output-format stream-json --verbose`;
  }
}
