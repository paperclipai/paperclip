import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import {
  CODEX_CHATGPT_MODEL_REJECTION_RE,
  codexCliVersionAtLeast,
  minimumCodexCliVersionForModel,
  normalizeCodexModel,
  parseCodexCliVersionOutput,
} from "../index.js";

export const CODEX_CLI_VERSION_INCOMPATIBLE_CHECK_CODE = "codex_cli_version_incompatible";
export const CODEX_CLI_VERSION_COMPATIBLE_CHECK_CODE = "codex_cli_version_compatible";
export const CODEX_HELLO_PROBE_MODEL_REJECTED_CHECK_CODE = "codex_hello_probe_model_rejected";

/**
 * Run `codex --version` where the run would execute it. Never cached: an
 * operator may upgrade Codex, or promote a new sandbox image, while the
 * Paperclip server keeps running, and the next Test should see the change.
 */
export async function readCodexCommandVersion(input: {
  runId: string;
  command: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
}): Promise<string | null> {
  try {
    const result = await runAdapterExecutionTargetProcess(
      input.runId,
      input.target,
      input.command,
      ["--version"],
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: 20,
        graceSec: 5,
        onLog: async () => {},
      },
    );
    if (result.timedOut || result.exitCode !== 0) return null;
    return parseCodexCliVersionOutput(`${result.stdout}\n${result.stderr}`);
  } catch {
    return null;
  }
}

function sandboxUpgradeHint(targetIsSandbox: boolean): string {
  return targetIsSandbox
    ? "Promote a sandbox image that ships the Codex CLI version Paperclip pins, then retry the Test. Adding a model to the catalog does not update the Codex CLI baked into existing sandbox images."
    : "Upgrade Codex (for example `npm install -g @openai/codex@latest`) where this agent runs, then retry the Test.";
}

/**
 * Compare the installed Codex CLI with the floor the configured model needs
 * for ChatGPT sign-in. Returns null when the model has no verified floor, so
 * callers skip the version probe entirely for such models.
 */
export async function checkCodexCliVersionForModel(input: {
  runId: string;
  model: string | null | undefined;
  command: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
}): Promise<{ check: AdapterEnvironmentCheck; compatible: boolean; detectedVersion: string | null } | null> {
  const minimum = minimumCodexCliVersionForModel(input.model);
  if (!minimum) return null;
  const model = normalizeCodexModel(input.model);
  const targetIsSandbox = input.target?.kind === "remote" && input.target.transport === "sandbox";
  const detected = await readCodexCommandVersion(input);
  if (detected && codexCliVersionAtLeast(detected, minimum)) {
    return {
      compatible: true,
      detectedVersion: detected,
      check: {
        code: CODEX_CLI_VERSION_COMPATIBLE_CHECK_CODE,
        level: "info",
        message: `Codex CLI ${detected} satisfies the ${minimum} minimum for ${model}.`,
      },
    };
  }
  return {
    compatible: false,
    detectedVersion: detected,
    check: {
      code: CODEX_CLI_VERSION_INCOMPATIBLE_CHECK_CODE,
      level: "error",
      message: `${model} requires Codex CLI ${minimum} or newer with ChatGPT sign-in.`,
      detail: detected
        ? `Detected Codex CLI ${detected}.`
        : "Could not determine the installed Codex CLI version from `codex --version`.",
      hint: sandboxUpgradeHint(targetIsSandbox),
    },
  };
}

/**
 * The backend rejects a model for ChatGPT sign-in with one fixed sentence.
 * Map it to a dedicated check so the cause (stale CLI, or a plan that does
 * not include the model) is named instead of a generic probe failure.
 */
export function codexHelloProbeModelRejectionCheck(input: {
  evidence: string;
  detectedVersion: string | null;
  targetIsSandbox: boolean;
}): AdapterEnvironmentCheck | null {
  const match = CODEX_CHATGPT_MODEL_REJECTION_RE.exec(input.evidence);
  if (!match) return null;
  const model = match[1]!;
  const minimum = minimumCodexCliVersionForModel(model);
  const versionNote = input.detectedVersion
    ? ` Detected Codex CLI ${input.detectedVersion}.`
    : "";
  return {
    code: CODEX_HELLO_PROBE_MODEL_REJECTED_CHECK_CODE,
    level: "error",
    message: `The Codex backend rejected ${model} for this ChatGPT account.`,
    detail: `${match[0]}${versionNote}`,
    hint: minimum
      ? `${model} needs Codex CLI ${minimum} or newer with ChatGPT sign-in. ${sandboxUpgradeHint(input.targetIsSandbox)} If the CLI is already new enough, the plan does not include this model (Enterprise and Edu administrators must enable it) or the rollout has not reached the account; choose another model or use an OpenAI API key.`
      : `The ChatGPT plan does not include ${model}, the rollout has not reached the account, or the installed Codex CLI is older than the model requires. ${sandboxUpgradeHint(input.targetIsSandbox)} Otherwise choose another model or use an OpenAI API key.`,
  };
}
