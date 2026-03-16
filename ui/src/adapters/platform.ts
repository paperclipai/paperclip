import type { UIAdapterModule, AdapterConfigFieldsProps } from "./types";

export const platformUIAdapter: UIAdapterModule = {
  type: "platform",
  label: "Platform (Built-in)",

  parseStdoutLine(line: string, ts: string) {
    // Platform adapter uses LLM output, not stdout
    // Return empty array to indicate no stdout processing
    return [];
  },

  ConfigFields: (_props: AdapterConfigFieldsProps) => {
    // Platform adapter doesn't need additional config fields
    // All configuration happens via the LLM provider setup
    return null;
  },

  buildAdapterConfig() {
    // Platform adapter uses LLM providers configured at the system level
    // No additional config needed - providers are configured in the agent's LLM provider settings
    return {
      type: "platform"
    };
  }
};
