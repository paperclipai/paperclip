import { NavLink, useLocation } from "@/lib/router";
import { ChatDetailSidebar } from "./chat/ChatDetailSidebar";
import { ChatSetupSidebar } from "./chat/ChatSetupNavigation";
import { Store, ShieldQuestion } from "lucide-react";
import { DEVELOPER_TABS, advancedTabHref, isExperimentalToolTab } from "@/pages/tools/tool-tabs";
import { useSmokeLabEnabled } from "@/hooks/useSmokeLabEnabled";
import { useReviewCount } from "@/pages/apps/useReviewCount";
import { SidebarNavItem } from "./SidebarNavItem";
import { contextualSidebarStyles } from "./contextual-sidebar-styles";

/**
 * Secondary sidebar for the Apps area.
 *
 * Connectors combines discovery, account management, and connection health.
 * Review keeps governed actions waiting on the user's approval. Advanced
 * developer surfaces remain hidden unless one is explicitly enabled.
 */
export function AppsSidebar() {
  const { pathname } = useLocation();
  const reviewCount = useReviewCount();
  const { enabled: smokeLabEnabled } = useSmokeLabEnabled();
  const developerTabs = DEVELOPER_TABS.filter((tab) => {
    // Temporarily hide Gateways and Profiles until they are ready to ship.
    // Keep their tab definitions and routes intact so we can bring them back later.
    if (tab.key === "gateways" || tab.key === "profiles") return false;
    return !isExperimentalToolTab(tab.key) || smokeLabEnabled;
  });

  if (pathname.endsWith("/apps/chat/connect")) return <ChatSetupSidebar />;
  const chatDetail = pathname.match(/\/apps\/chat\/([^/]+)(?:\/(?:settings|access|conversations|activity)|\/reviews(?:\/[^/]+)?)?\/?$/);
  if (chatDetail) return <ChatDetailSidebar endpointId={chatDetail[1]} />;

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      <nav
        aria-label="Connectors"
        data-slot="contextual-sidebar-nav"
        className={contextualSidebarStyles.nav}
      >
        <div data-slot="contextual-sidebar-group" className={contextualSidebarStyles.group}>
          <SidebarNavItem to="/apps" label="Browse" icon={Store} end />
          <SidebarNavItem
            to="/apps/review"
            label="Review"
            icon={ShieldQuestion}
            badge={reviewCount > 0 ? reviewCount : undefined}
            badgeTone="warning"
            badgeLabel="waiting for your OK"
          />
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

/** Mobile collection navigation replaces the desktop Browse/Review rail. */
export function AppsMobileNav() {
  const reviewCount = useReviewCount();
  const segmentClass = ({ isActive }: { isActive: boolean }) =>
    `flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm no-underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"}`;
  return <nav aria-label="Connectors" className="mb-4 flex rounded-lg border border-border bg-background p-1">
    <NavLink to="/apps" end className={segmentClass}>Browse</NavLink>
    <NavLink to="/apps/review" className={segmentClass}>Review{reviewCount > 0 && <span className="rounded-full bg-muted px-1.5 text-xs" aria-label={`${reviewCount} waiting for your OK`}>{reviewCount}</span>}</NavLink>
  </nav>;
}
