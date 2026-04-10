import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

export interface GeminiCliCapabilities {
  supportsPromptFlag: boolean;
  supportsModelFlag: boolean;
  supportsApprovalModeFlag: boolean;
  supportsOutputFormatFlag: boolean;
  supportsResumeFlag: boolean;
  supportsSandboxFlag: boolean;
  supportsStdinPrompt: boolean;
}

const DEFAULT_CAPS: GeminiCliCapabilities = {
  supportsPromptFlag: true,
  supportsModelFlag: true,
  supportsApprovalModeFlag: true,
  supportsOutputFormatFlag: true,
  supportsResumeFlag: true,
  supportsSandboxFlag: true,
  supportsStdinPrompt: false,
};

let cachedCaps: GeminiCliCapabilities | null = null;

export async function detectGeminiCliCapabilities(
  command: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<GeminiCliCapabilities> {
  if (cachedCaps) return cachedCaps;

  try {
    const result = await runChildProcess("cap-probe", command, ["--help"], {
      cwd,
      env: env as Record<string, string>,
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
    });

    const helpText = (result.stdout + "\n" + result.stderr).toLowerCase();
    const caps: GeminiCliCapabilities = {
      supportsPromptFlag: helpText.includes("--prompt"),
      supportsModelFlag: helpText.includes("--model"),
      supportsApprovalModeFlag: helpText.includes("--approval-mode") || helpText.includes("--approve"),
      supportsOutputFormatFlag: helpText.includes("--output-format"),
      supportsResumeFlag: helpText.includes("--resume") || helpText.includes("--session"),
      supportsSandboxFlag: helpText.includes("--sandbox"),
      supportsStdinPrompt: helpText.includes("--stdin") || helpText.includes("stdin") || !helpText.includes("--prompt"),
    };

    cachedCaps = caps;
    return caps;
  } catch (err) {
    console.warn("Failed to probe Gemini CLI capabilities, using defaults:", err);
    return DEFAULT_CAPS;
  }
}

export function buildGeminiArgs(
  options: {
    prompt: string;
    model?: string;
    approvalMode?: string;
    outputFormat?: string;
    resumeSessionId?: string;
    sandbox?: boolean;
    additionalArgs?: string[];
  },
  caps: GeminiCliCapabilities,
): { argv: string[]; stdin?: string } {
  const argv: string[] = [];

  if (caps.supportsOutputFormatFlag && options.outputFormat) {
    argv.push("--output-format", options.outputFormat);
  }

  if (caps.supportsModelFlag && options.model) {
    argv.push("--model", options.model);
  }

  if (options.resumeSessionId && caps.supportsResumeFlag) {
    argv.push("--resume", options.resumeSessionId);
  }

  if (options.sandbox && caps.supportsSandboxFlag) {
    argv.push("--sandbox");
  }

  if (caps.supportsApprovalModeFlag && options.approvalMode) {
    argv.push("--approval-mode", options.approvalMode);
  }

  if (options.additionalArgs) {
    argv.push(...options.additionalArgs);
  }

  let stdin: string | undefined;
  // Use stdin if supported (safer for long prompts), otherwise fallback to --prompt
  if (caps.supportsStdinPrompt) {
    stdin = options.prompt;
    // Some versions might need a --stdin flag to explicitly read from it
  } else if (caps.supportsPromptFlag) {
    argv.push("--prompt", options.prompt);
  } else {
    // Last resort: try --prompt anyway
    argv.push("--prompt", options.prompt);
  }

  return { argv, stdin };
}
