import * as p from "@clack/prompts";
import { t } from "../i18n/index.js";
import type { LlmConfig } from "../config/schema.js";

export async function promptLlm(): Promise<LlmConfig | undefined> {
  const configureLlm = await p.confirm({
    message: t("llm.configure_message"),
    initialValue: false,
  });

  if (p.isCancel(configureLlm)) {
    p.cancel(t("llm.setup_cancelled"));
    process.exit(0);
  }

  if (!configureLlm) return undefined;

  const provider = await p.select({
    message: t("llm.provider_message"),
    options: [
      { value: "claude" as const, label: t("llm.claude_label") },
      { value: "openai" as const, label: t("llm.openai_label") },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel(t("llm.setup_cancelled"));
    process.exit(0);
  }

  const apiKey = await p.password({
    message: provider === "claude" ? t("llm.api_key_message_anthropic") : t("llm.api_key_message_openai"),
    validate: (val) => {
      if (!val) return t("llm.api_key_required");
    },
  });

  if (p.isCancel(apiKey)) {
    p.cancel(t("llm.setup_cancelled"));
    process.exit(0);
  }

  return { provider, apiKey };
}
