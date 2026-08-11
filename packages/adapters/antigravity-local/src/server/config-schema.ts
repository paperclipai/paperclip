import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { DEFAULT_ANTIGRAVITY_MAX_TOKENS_PER_RUN } from "./execute.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "maxTokensPerRun",
        label: "Maximum tokens per run",
        type: "number",
        default: DEFAULT_ANTIGRAVITY_MAX_TOKENS_PER_RUN,
        hint: "Required hard ceiling. Antigravity stream-json usage is monitored during the turn and the local process is stopped before another model step once the ceiling is crossed.",
      },
    ],
  };
}
