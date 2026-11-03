import { t, useTranslation } from "@/i18n";
import type { AiConnectionRouterSelection } from "@paperclipai/shared";
import { EFFORT_LABELS } from "@/components/task-chat/composer-run-settings";
import { AI_PROVIDERS } from "./model";

function runtimeCaption(value: unknown): string | undefined {
  if (!value) return undefined;
  const names: Record<string, string> = { codex: "Codex", opencode: "OpenCode", claude_managed: "Claude Managed", aws_agentcore: "AWS AgentCore", acpx: t("oct5Core.acpAgents"), claude: "Claude", grok: "Grok", gemini: "Gemini" };
  const raw = String(value);
  return Object.hasOwn(names, raw) ? names[raw] : raw;
}

export function AiConnectionPoolRunDetails({ context }: { context: Record<string, unknown> | null }) {
  useTranslation();
  const selection = context?.aiRouterSelection as AiConnectionRouterSelection | undefined;
  if (!selection) return null;
  const account = context?.aiConnection as { accountName?: string; connectionId?: string } | undefined;
  const config = selection.runtimeConfig;
  const effort = config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort ?? config.variant;
  const effortCaption = typeof effort === "string" && Object.hasOwn(EFFORT_LABELS, effort) ? EFFORT_LABELS[effort] : effort;
  return <div className="rounded-lg border p-4 text-sm space-y-1">
    <p className="font-medium">{t("oct6Beta.poolUsedAccount", { name: account?.accountName ?? account?.connectionId ?? t("oct6Beta.copy072") })}</p>
    <p>{[AI_PROVIDERS[selection.binding.provider]?.name ?? selection.binding.provider, runtimeCaption(config.provider), runtimeCaption(config.acpxAgent), config.model, effortCaption].filter(Boolean).map(String).join(" · ")}</p>
    {selection.notes.length > 0 && <p className="text-muted-foreground">{selection.notes.map(note => note === "Model override is unavailable for this member; using its default." ? t("oct6Beta.poolModelOverride") : note === "Effort override is unavailable for this member; using its default." ? t("oct6Beta.poolEffortOverride") : note).join(" ")}</p>}
  </div>;
}
