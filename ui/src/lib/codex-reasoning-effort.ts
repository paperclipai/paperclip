import {
  codexLocalReasoningEffortsForModel,
  type CodexLocalReasoningEffort,
} from "@paperclipai/adapter-codex-local";
import { DEEPSEEK_REASONING_EFFORTS, isDeepSeekModel } from "@paperclipai/shared";

const CODEX_REASONING_EFFORT_LABELS: Record<CodexLocalReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
  ultra: "Ultra",
};

export function codexReasoningEffortOptions(
  model: string | null | undefined,
  defaultLabel = "Default",
) {
  // DeepSeek on the Codex harness accepts only low/high/max; the Codex-native
  // model list does not apply and would offer unsupported values. The shared
  // helper keeps this list identical to the server-side MCP validation.
  const values: CodexLocalReasoningEffort[] = isDeepSeekModel(model)
    ? [...DEEPSEEK_REASONING_EFFORTS]
    : [...codexLocalReasoningEffortsForModel(model)];
  return [
    { value: "", label: defaultLabel },
    ...values.map((value) => ({
      value,
      label: CODEX_REASONING_EFFORT_LABELS[value],
    })),
  ];
}
