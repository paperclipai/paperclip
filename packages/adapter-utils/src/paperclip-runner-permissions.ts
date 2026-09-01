export type PaperclipRunnerProvider = "codex";

export type CodexPermissionMode = "never" | "on-request" | "untrusted";
export type PaperclipRunnerPermissionMode = CodexPermissionMode;

export interface PaperclipRunnerPermissionOption<TMode extends string = string> {
  value: TMode;
  label: string;
  description: string;
}

export interface PaperclipRunnerPermissionCapability {
  configurable: true;
  configKey: "codexPermissionMode";
  defaultMode: PaperclipRunnerPermissionMode;
  options: readonly PaperclipRunnerPermissionOption<PaperclipRunnerPermissionMode>[];
  description: string;
}

/**
 * Control-plane catalog for Paperclip Runner permission UX and validation.
 * Runtime contracts validate the same native values again at the process
 * boundary; this catalog must remain browser-safe.
 */
export const PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES = {
  codex: {
    configurable: true,
    configKey: "codexPermissionMode",
    defaultMode: "never",
    description: "Controls when Codex asks before an operation inside the assigned Paperclip environment.",
    options: [
      { value: "never", label: "Full auto (never ask)", description: "Run without Codex approval pauses." },
      { value: "on-request", label: "Ask when requested", description: "Prompt when Codex requests approval." },
      { value: "untrusted", label: "Ask for untrusted operations", description: "Prompt for operations Codex does not classify as trusted." },
    ],
  },
} as const satisfies Record<PaperclipRunnerProvider, PaperclipRunnerPermissionCapability>;

export function isPaperclipRunnerProvider(value: unknown): value is PaperclipRunnerProvider {
  return typeof value === "string" && value in PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES;
}

export function resolvePaperclipRunnerPermissionMode(
  provider: PaperclipRunnerProvider,
  value: unknown,
): PaperclipRunnerPermissionMode {
  const capability = PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[provider];
  return capability.options.some((option) => option.value === value)
    ? value as PaperclipRunnerPermissionMode
    : capability.defaultMode;
}
