export type PaperclipRunnerProvider =
  | "codex"
  | "opencode"
  | "claude_managed"
  | "aws_agentcore"
  | "acpx";

export type CodexPermissionMode = "never" | "on-request" | "untrusted";
export type OpenCodePermissionMode = "allow" | "ask" | "deny";
export type AcpxPermissionMode = "approve-all" | "approve-reads" | "deny-all";

export type PaperclipRunnerPermissionMode =
  | CodexPermissionMode
  | OpenCodePermissionMode
  | AcpxPermissionMode;

export const PAPERCLIP_RUNNER_IDLE_TIMEOUT_DEFAULT_MS = 300_000;
export const PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS = 86_400_000;

export interface PaperclipRunnerPermissionOption<TMode extends string = string> {
  value: TMode;
  label: string;
  description: string;
}

export type PaperclipRunnerPermissionCapability =
  | {
      configurable: true;
      configKey: "codexPermissionMode" | "opencodePermissionMode" | "acpxPermissionMode";
      defaultMode: PaperclipRunnerPermissionMode;
      options: readonly PaperclipRunnerPermissionOption<PaperclipRunnerPermissionMode>[];
      description: string;
    }
  | {
      configurable: false;
      defaultMode: "provider-managed";
      options: readonly [];
      description: string;
    };

/**
 * Control-plane catalog for Paperclip Runner permission UX and validation.
 * Runtime contracts validate the same native values again at the process
 * boundary; this catalog must remain browser-safe.
 */
export const PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES = {
  codex: {
    configurable: true,
    configKey: "codexPermissionMode",
    defaultMode: "untrusted",
    description: "Controls when Codex asks before an operation inside the assigned Paperclip environment.",
    options: [
      { value: "never", label: "Full auto (never ask)", description: "Run without Codex approval pauses." },
      { value: "on-request", label: "Ask when requested", description: "Prompt when Codex requests approval." },
      { value: "untrusted", label: "Ask for untrusted operations", description: "Prompt for operations Codex does not classify as trusted." },
    ],
  },
  opencode: {
    configurable: true,
    configKey: "opencodePermissionMode",
    defaultMode: "ask",
    description: "Controls OpenCode tool permissions inside the assigned Paperclip environment.",
    options: [
      { value: "allow", label: "Full auto (allow)", description: "Allow OpenCode operations without approval pauses." },
      { value: "ask", label: "Ask for permission", description: "Prompt before protected OpenCode operations." },
      { value: "deny", label: "Deny operations", description: "Reject protected OpenCode operations." },
    ],
  },
  claude_managed: {
    configurable: false,
    defaultMode: "provider-managed",
    options: [],
    description: "Claude Managed runs non-interactively under its qualified provider profile and Paperclip policy.",
  },
  aws_agentcore: {
    configurable: false,
    defaultMode: "provider-managed",
    options: [],
    description: "AWS AgentCore runs non-interactively under its qualified harness profile and Paperclip policy.",
  },
  acpx: {
    configurable: true,
    configKey: "acpxPermissionMode",
    defaultMode: "approve-reads",
    description: "Controls ACPX agent operations inside the assigned Paperclip environment.",
    options: [
      { value: "approve-all", label: "Full auto (approve all)", description: "Approve ACPX operations without approval pauses." },
      { value: "approve-reads", label: "Ask for mutations", description: "Approve reads and prompt for writes, edits, and execution." },
      { value: "deny-all", label: "Deny all", description: "Reject harness permission requests." },
    ],
  },
} as const satisfies Record<PaperclipRunnerProvider, PaperclipRunnerPermissionCapability>;

export function isPaperclipRunnerProvider(value: unknown): value is PaperclipRunnerProvider {
  return value === "codex"
    || value === "opencode"
    || value === "claude_managed"
    || value === "aws_agentcore"
    || value === "acpx";
}

export function resolvePaperclipRunnerPermissionMode(
  provider: PaperclipRunnerProvider,
  value: unknown,
): PaperclipRunnerPermissionMode | "provider-managed" {
  const capability = PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[provider];
  if (!capability.configurable) return capability.defaultMode;
  return capability.options.some((option) => option.value === value)
    ? value as PaperclipRunnerPermissionMode
    : capability.defaultMode;
}

export function resolvePaperclipRunnerIdleTimeoutMs(value: unknown): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS
    ? value
    : PAPERCLIP_RUNNER_IDLE_TIMEOUT_DEFAULT_MS;
}
