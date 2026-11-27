import { useLocation } from "@/lib/router";
import { ChatDetailMobileNav, ChatDetailSidebar } from "./chat/ChatDetailSidebar";
import { ChatSetupSidebar } from "./chat/ChatSetupNavigation";
import { Store } from "lucide-react";
import { DEVELOPER_TABS, advancedTabHref, isExperimentalToolTab } from "@/pages/tools/tool-tabs";
import { useSmokeLabEnabled } from "@/hooks/useSmokeLabEnabled";
import { MobileContextualNav } from "./MobileContextualNav";
import { SidebarNavItem } from "./SidebarNavItem";
import { contextualSidebarStyles } from "./contextual-sidebar-styles";

const CHAT_DETAIL_PATH_RE = /\/apps\/chat\/([^/]+)(?:\/(?:settings|access|conversations|activity)|\/reviews(?:\/[^/]+)?)?\/?$/;

function isChatConnectPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "").endsWith("/apps/chat/connect");
}

export function appsRouteHasMobileNav(pathname: string, hasDeveloperTabs: boolean): boolean {
  if (isChatConnectPath(pathname)) return false;
  if (CHAT_DETAIL_PATH_RE.test(pathname)) return true;
  return hasDeveloperTabs;
}

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

  if (isChatConnectPath(pathname)) return <ChatSetupSidebar />;
  const chatDetail = pathname.match(CHAT_DETAIL_PATH_RE);
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

export function AppsMobileNav() {
  const { pathname } = useLocation();
  const developerTabs = useAppsDeveloperTabs();

  if (isChatConnectPath(pathname)) return null;
  const chatDetail = pathname.match(CHAT_DETAIL_PATH_RE);
  if (chatDetail) return <ChatDetailMobileNav endpointId={chatDetail[1]} />;
  if (developerTabs.length === 0) return null;

  return (
    <MobileContextualNav
      surface="apps"
      ariaLabel="Plugins"
      groups={[
        {
          key: "plugins",
          items: [{ key: "all-plugins", to: "/apps", label: "All plugins", icon: Store, end: true }],
        },
        {
          key: "developer",
          items: developerTabs.map((tab) => ({
            key: tab.key,
            to: advancedTabHref(tab.key),
            label: tab.label,
            icon: tab.icon,
            end: true,
          })),
        },
      ]}
    />
  );
}
