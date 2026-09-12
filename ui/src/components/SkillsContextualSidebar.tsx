import { useTranslation } from "@/i18n";
import { Compass, Library, PencilRuler } from "lucide-react";
import { useLocation } from "@/lib/router";
import {
  resolveSkillsNavigationView,
  SKILLS_NAVIGATION_HREFS,
} from "@/pages/skills/skills-navigation";
import { ContextualSidebarFrame } from "./ContextualSidebarFrame";
import { SidebarNavItem } from "./SidebarNavItem";
import { contextualSidebarStyles } from "./contextual-sidebar-styles";

export {
  resolveSkillsDiscoveryView,
  resolveSkillsNavigationView,
  SKILLS_NAVIGATION_HREFS,
  withSkillsDiscoveryView,
  type SkillsNavigationView,
} from "@/pages/skills/skills-navigation";

export function SkillsContextualSidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const activeView = resolveSkillsNavigationView(location.pathname, location.search);

  return (
    <ContextualSidebarFrame
      surface="skills"
      title={t("localizationCommonChrome.skills")}
      icon={Library}
      fallbackTo="/dashboard"
      showHeader={false}
      className="border-r border-border bg-background"
    >
      <nav
        aria-label={t("localizationCommonChrome.skills")}
        data-slot="contextual-sidebar-nav"
        className={contextualSidebarStyles.nav}
      >
        <div data-slot="contextual-sidebar-group" className={contextualSidebarStyles.group}>
          <SidebarNavItem
            to={SKILLS_NAVIGATION_HREFS.installed}
            label={t("localizationCommonChrome.installed")}
            icon={Library}
            active={activeView === "installed"}
            end
          />
          <SidebarNavItem
            to={SKILLS_NAVIGATION_HREFS.discover}
            label={t("localizationCommonChrome.discover")}
            icon={Compass}
            active={activeView === "discover"}
            end
          />
        </div>

        <div data-slot="contextual-sidebar-section" className={contextualSidebarStyles.section}>
          <div
            data-slot="contextual-sidebar-section-label"
            className={contextualSidebarStyles.sectionLabel}
          >{t("localizationCommonChrome.author")}</div>
          <p
            data-slot="contextual-sidebar-section-description"
            className={contextualSidebarStyles.sectionDescription}
          >{t("localizationCommonChrome.skillsYouCreate")}</p>
          <div data-slot="contextual-sidebar-group" className={contextualSidebarStyles.group}>
            <SidebarNavItem
              to={SKILLS_NAVIGATION_HREFS.authored}
              label={t("localizationCommonChrome.mySkills")}
              icon={PencilRuler}
              active={activeView === "authored"}
            />
          </div>
        </div>
      </nav>
    </ContextualSidebarFrame>
  );
}
