import { t } from "@/i18n";
import type { ToastInput } from "@/context/ToastContext";

export interface BuiltInAgentPausedToastOptions {
  /** Display name of the paused built-in agent, e.g. "Briefs Agent". */
  displayName: string;
  /** Deep link to the agent page (from `agentUrl(agent)`). */
  agentHref: string;
  /** Noun for the feature item, e.g. "brief". */
  featureNoun?: string;
}

/**
 * Build the "use-while-paused" toast payload (ux-spec §5 / D9).
 *
 * `ToastAction` supports a single `href` link only, so v1 carries one
 * "View agent" link and Resume happens on the agent page. Deduped so repeated
 * feature actions don't stack duplicate toasts.
 */
export function buildBuiltInAgentPausedToast(options: BuiltInAgentPausedToastOptions): ToastInput {
  const noun = options.featureNoun ?? "item";
  return {
    dedupeKey: `built-in-agent-paused:${options.displayName}`,
    get "title"() { return t("display:copy_df2f984408bb", { value0: options.displayName }); },
    get "body"() { return t("display:copy_c78fda3e16d2", { value0: noun }); },
    tone: "warn",
    action: { get "label"() { return t("display:copy_06d0e001ac9e"); }, href: options.agentHref },
  };
}
