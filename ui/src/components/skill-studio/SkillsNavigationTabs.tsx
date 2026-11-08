import { type ReactNode, useMemo } from "react";
import { useTranslation } from "@/i18n";
import { Link } from "@/lib/router";
import { useStreamlinedUiEnabled } from "@/hooks/useStreamlinedUiEnabled";
import { SKILLS_NAVIGATION_HREFS, type SkillsNavigationView } from "@/pages/skills/skills-navigation";

const views = [
  { value: "installed", label: "Installed" },
  { value: "discover", label: "Discover" },
  { value: "authored", label: "My Skills" },
] as const;

/** Route navigation with the canonical tab appearance. Sources stays in the actions menu. */
export function SkillsNavigationTabs({ activeView }: { activeView: SkillsNavigationView }) {
  const { t } = useTranslation();
  const translatedViews: { value: SkillsNavigationView; label: string }[] = useMemo(() => [
    { value: "installed", label: t("skills.tabs.installed", { defaultValue: "Installed" }) },
    { value: "discover", label: t("skills.tabs.discover", { defaultValue: "Discover" }) },
    { value: "authored", label: t("skills.tabs.mySkills", { defaultValue: "My Skills" }) },
  ], [t]);
  return <nav aria-label="Skills views" data-canonical-tabs="standard" className="canonical-tab-list">
    {translatedViews.map(view => <Link key={view.value} to={SKILLS_NAVIGATION_HREFS[view.value]}
      className="canonical-tab" data-state={activeView === view.value ? "active" : "inactive"}
      aria-current={activeView === view.value ? "page" : undefined}>{view.label}</Link>)}
  </nav>;
}

/** Standalone Skills pages share navigation beneath their own header controls. */
export function SkillsPageNavigation({ activeView, fallback = null }: { activeView: SkillsNavigationView; fallback?: ReactNode }) {
  const { enabled } = useStreamlinedUiEnabled();
  return enabled ? <div className="shrink-0 border-b border-border px-3 py-2"><SkillsNavigationTabs activeView={activeView} /></div> : fallback;
}
