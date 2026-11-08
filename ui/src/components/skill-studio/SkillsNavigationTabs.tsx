import { t as translateShell, useTranslation } from "@/i18n";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { useStreamlinedUiEnabled } from "@/hooks/useStreamlinedUiEnabled";
import { SKILLS_NAVIGATION_HREFS, type SkillsNavigationView } from "@/pages/skills/skills-navigation";

const views = [
  { value: "installed", get label() { return translateShell("shell:installed"); } },
  { value: "discover", get label() { return translateShell("shell:discover"); } },
  { value: "authored", get label() { return translateShell("shell:my_skills"); } },
] as const;

/** Route navigation with the canonical tab appearance. Sources stays in the actions menu. */
export function SkillsNavigationTabs({ activeView }: { activeView: SkillsNavigationView }) {
  const { t: translateShell } = useTranslation("shell");
  return <nav aria-label={translateShell("shell:skills_views")} data-canonical-tabs="standard" className="canonical-tab-list">
    {views.map(view => <Link key={view.value} to={SKILLS_NAVIGATION_HREFS[view.value]}
      className="canonical-tab" data-state={activeView === view.value ? "active" : "inactive"}
      aria-current={activeView === view.value ? "page" : undefined}>{view.label}</Link>)}
  </nav>;
}

/** Standalone Skills pages share navigation beneath their own header controls. */
export function SkillsPageNavigation({ activeView, fallback = null }: { activeView: SkillsNavigationView; fallback?: ReactNode }) {
  const { t: translateShell } = useTranslation("shell");
  const { enabled } = useStreamlinedUiEnabled();
  return enabled ? <div className="shrink-0 border-b border-border px-3 py-2"><SkillsNavigationTabs activeView={activeView} /></div> : fallback;
}
