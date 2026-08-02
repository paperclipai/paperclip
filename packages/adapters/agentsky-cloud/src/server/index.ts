export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { sessionCodec } from "./session.js";

import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  AGENTSKY_HARNESSES,
  AGENTSKY_HARNESS_LABELS,
  AGENTSKY_MODELS,
  DEFAULT_AGENTSKY_API_BASE_URL,
  DEFAULT_AGENTSKY_HARNESS,
} from "../models.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "harness",
        label: "Harness",
        type: "select",
        default: DEFAULT_AGENTSKY_HARNESS,
        required: true,
        options: AGENTSKY_HARNESSES.map((harness) => ({
          value: harness,
          label: AGENTSKY_HARNESS_LABELS[harness],
        })),
        hint: "AgentSky agent type provisioned for this Paperclip agent.",
      },
      {
        key: "model",
        label: "Model",
        // combobox (not select): model ids repeat across harness groups, and
        // the combobox renderer groups options so repeated values stay distinct.
        type: "combobox",
        default: "",
        options: [
          { value: "", label: "Harness default" },
          ...AGENTSKY_HARNESSES.flatMap((harness) =>
            AGENTSKY_MODELS[harness].map((model) => ({
              value: model,
              label: model,
              group: AGENTSKY_HARNESS_LABELS[harness],
            })),
          ),
        ],
        hint: "Must be compatible with the chosen harness (options are grouped by harness). Leave empty for the harness default.",
      },
      {
        key: "agentSlug",
        label: "Existing agent slug",
        type: "text",
        hint: "Optional: attach to a pre-existing AgentSky agent instead of auto-creating one. Harness and model above are then ignored.",
      },
      {
        key: "apiBaseUrl",
        label: "API base URL",
        type: "text",
        default: DEFAULT_AGENTSKY_API_BASE_URL,
        hint: "Override only for staging or self-hosted AgentSky.",
      },
    ],
  };
}
