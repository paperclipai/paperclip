import { useLocation } from "@/lib/router";
import { ChatDetailSidebar } from "./chat/ChatDetailSidebar";
import { ChatSetupSidebar } from "./chat/ChatSetupNavigation";
import { Store } from "lucide-react";
import { DEVELOPER_TABS, advancedTabHref, isExperimentalToolTab } from "@/pages/tools/tool-tabs";
import { useSmokeLabEnabled } from "@/hooks/useSmokeLabEnabled";
import { SidebarNavItem } from "./SidebarNavItem";
import { contextualSidebarStyles } from "./contextual-sidebar-styles";

/** Developer tabs that are switched on for this instance; Gateways and Profiles stay hidden until they ship. */
export function useAppsDeveloperTabs() {
  const { enabled: smokeLabEnabled } = useSmokeLabEnabled();
  return DEVELOPER_TABS.filter((tab) => {
    if (tab.key === "gateways" || tab.key === "profiles") return false;
    return !isExperimentalToolTab(tab.key) || smokeLabEnabled;
  });
}

/**
 * Secondary sidebar for the parts of the Apps area that still need one: chat
 * setup and detail, and the developer pages. The Plugins marketplace and
 * Review have no rail; their page headers link to each other.
 */
export function AppsSidebar() {
  const { pathname } = useLocation();
  const developerTabs = useAppsDeveloperTabs();

  if (pathname.endsWith("/apps/chat/connect")) return <ChatSetupSidebar />;
  const chatDetail = pathname.match(/\/apps\/chat\/([^/]+)(?:\/(?:settings|access|conversations|activity)|\/reviews(?:\/[^/]+)?)?\/?$/);
  if (chatDetail) return <ChatDetailSidebar endpointId={chatDetail[1]} />;

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      <nav
        aria-label="Plugins"
        data-slot="contextual-sidebar-nav"
        className={contextualSidebarStyles.nav}
      >
        <div data-slot="contextual-sidebar-group" className={contextualSidebarStyles.group}>
          <SidebarNavItem to="/apps" label="All plugins" icon={Store} end />
        </div>
        {developerTabs.length > 0 ? (
          <div data-slot="contextual-sidebar-section" className={contextualSidebarStyles.section}>
            <div
              data-slot="contextual-sidebar-section-label"
              className={contextualSidebarStyles.sectionLabel}
            >
              Developer
            </div>
            <p
              data-slot="contextual-sidebar-section-description"
              className={contextualSidebarStyles.sectionDescription}
            >
              Advanced setup for developers.
            </p>
            <div data-slot="contextual-sidebar-group" className={contextualSidebarStyles.group}>
              {developerTabs.map((tab) => (
                <SidebarNavItem
                  key={tab.key}
                  to={advancedTabHref(tab.key)}
                  label={tab.label}
                  icon={tab.icon}
                  end
                />
              ))}
            </div>
          </div>
        ) : null}
      </nav>
    </aside>
  );
}
