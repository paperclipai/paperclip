import { t } from "@/i18n";
import {
  codexLocalReasoningEffortsForModel,
  type CodexLocalReasoningEffort,
} from "@paperclipai/adapter-codex-local";

const CODEX_REASONING_EFFORT_LABELS: Record<CodexLocalReasoningEffort, string> = {
  get "minimal"() { return t("display:meta_a711cca9a4a9"); },
  get "low"() { return t("display:meta_a124947cbd2d"); },
  get "medium"() { return t("display:meta_d404968ea90b"); },
  get "high"() { return t("display:meta_b1a5954a483f"); },
  get "xhigh"() { return t("display:meta_79c18753a6f9"); },
  get "max"() { return t("display:meta_a95e85aed563"); },
  get "ultra"() { return t("display:meta_50050d5b621c"); },
};

export function codexReasoningEffortOptions(
  model: string | null | undefined,
  defaultLabel = t("display:effort_default"),
) {
  return [
    { value: "", label: defaultLabel },
    ...codexLocalReasoningEffortsForModel(model).map((value) => ({
      value,
      label: CODEX_REASONING_EFFORT_LABELS[value],
    })),
  ];
}
