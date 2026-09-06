import {
  codexLocalReasoningEffortsForModel,
  type CodexLocalReasoningEffort,
} from "@paperclipai/adapter-codex-local";

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
  return [
    { value: "", label: defaultLabel },
    ...codexLocalReasoningEffortsForModel(model).map((value) => ({
      value,
      label: CODEX_REASONING_EFFORT_LABELS[value],
    })),
  ];
}
