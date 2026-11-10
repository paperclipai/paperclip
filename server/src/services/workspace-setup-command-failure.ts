import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import { redactSensitiveText } from "../redaction.js";

/**
 * A configured workspace setup command (a project or service setting) exited
 * non-zero before the agent started. The run keeps its `setup_failed`
 * classification and retry behavior; this bounded record only lets the task
 * page name the setting that broke and what it printed.
 */
type SetupCommandFailure = NonNullable<TaskInterruptionPresentation["setupFailure"]>;
type SetupStep = SetupCommandFailure["step"];

const SETUP_STEPS: ReadonlySet<string> = new Set<SetupStep>(["workspace_provision", "workspace_seed", "workspace_runtime_provision"]);
const MAX_COMMAND_CHARS = 200;
const MAX_OUTPUT_CHARS = 300;
const STEP_SETTINGS: Record<SetupStep, string> = {
  workspace_provision: "The project's workspace provision command",
  workspace_seed: "The workspace seed command",
  workspace_runtime_provision: "The runtime provision command",
};
// Messages written by workspace-runtime.ts before setup failures carried structured fields.
const LEGACY_MESSAGE = /^(Execution workspace provision|Workspace seed|Runtime provision) command "([^"\n]{1,2000})" failed(?:: ([\s\S]+)| with exit code (-?\d+))$/;
const LEGACY_STEPS: Record<string, SetupStep> = {
  "Execution workspace provision": "workspace_provision",
  "Workspace seed": "workspace_seed",
  "Runtime provision": "workspace_runtime_provision",
};

function bounded(value: string, max: number, keep: "head" | "tail"): string {
  const clean = [...redactSensitiveText(value)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "").trim()];
  if (clean.length <= max) return clean.join("");
  return keep === "head" ? `${clean.slice(0, max - 1).join("")}…` : `…${clean.slice(clean.length - (max - 1)).join("")}`;
}

function normalize(step: SetupStep, command: string, exitCode: number | null, output: string | null): SetupCommandFailure | null {
  const safeCommand = bounded(command, MAX_COMMAND_CHARS, "head");
  if (!safeCommand) return null;
  const safeOutput = output ? bounded(output, MAX_OUTPUT_CHARS, "tail") || null : null;
  const status = exitCode === null ? "failed" : `failed with exit code ${exitCode}`;
  return {
    step, command: safeCommand, exitCode, output: safeOutput,
    message: `${STEP_SETTINGS[step]} "${safeCommand}" ${status}${safeOutput ? `: ${safeOutput}` : ""}`,
  };
}

/** Bounded, redacted result evidence for a run whose setup command exited non-zero. */
export function setupCommandFailureResultJson(error: unknown): { setupCommandFailure: SetupCommandFailure } | Record<string, never> {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    // WorkspaceCommandExitError (workspace-runtime.ts), read by shape so this module stays light.
    const value = current as { step?: unknown; command?: unknown; exitCode?: unknown; output?: unknown };
    if (current instanceof Error && typeof value.step === "string" && SETUP_STEPS.has(value.step) && typeof value.command === "string") {
      const failure = normalize(value.step as SetupStep, value.command,
        typeof value.exitCode === "number" && Number.isInteger(value.exitCode) ? value.exitCode : null,
        typeof value.output === "string" ? value.output : null);
      return failure ? { setupCommandFailure: failure } : {};
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return {};
}

/** Read the recorded setup-command failure, or recognize one recorded before the structured field existed. */
export function readSetupCommandFailure(resultJson: Record<string, unknown> | null | undefined, error: unknown): SetupCommandFailure | null {
  const stored = resultJson?.setupCommandFailure;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const value = stored as Record<string, unknown>;
    if (typeof value.step === "string" && SETUP_STEPS.has(value.step) && typeof value.command === "string") {
      return normalize(value.step as SetupStep, value.command,
        typeof value.exitCode === "number" && Number.isInteger(value.exitCode) ? value.exitCode : null,
        typeof value.output === "string" ? value.output : null);
    }
  }
  if (typeof error !== "string") return null;
  const match = LEGACY_MESSAGE.exec(error.trim());
  if (!match) return null;
  return normalize(LEGACY_STEPS[match[1]!]!, match[2]!, match[4] === undefined ? null : Number(match[4]), match[3] ?? null);
}
