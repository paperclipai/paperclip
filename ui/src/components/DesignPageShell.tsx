import type { ReactNode } from "react";
import { SidebarShell } from "./SidebarShell";
import { DesignPageAside } from "./DesignPageAside";
import { useScrollbarWhileScrolling } from "./side-panel";
import { FlyoutAppearanceProvider } from "./ui/flyout";

export type DesignPageShellProps = {
  sidebar: ReactNode;
  title: string;
  children: ReactNode;
  sidebarStorageKey?: string;
  headerActions?: ReactNode;
  /** Omit for the two-pane layout. Content scrolls independently of the main pane. */
  rightSidebar?: ReactNode;
  rightSidebarTitle?: string;
  rightSidebarHeader?: ReactNode;
  rightSidebarControls?: ReactNode;
  rightSidebarMaximized?: boolean;
  rightSidebarStorageKey?: string;
};

/** Shared proposed desktop shell. Pages supply content; the shell owns pane geometry and scrolling. */
export function DesignPageShell({
  sidebar,
  title,
  children,
  sidebarStorageKey = "paperclip.design-proposal.sidebar-width",
  headerActions,
  rightSidebar,
  rightSidebarTitle = "Details",
  rightSidebarHeader,
  rightSidebarControls,
  rightSidebarMaximized = false,
  rightSidebarStorageKey = `${sidebarStorageKey}.right`,
}: DesignPageShellProps) {
  const handleMainScroll = useScrollbarWhileScrolling<HTMLElement>();
  const handleAsideScroll = useScrollbarWhileScrolling();
  const hasRightSidebar = rightSidebar != null && rightSidebar !== false;
  const maximized = hasRightSidebar && rightSidebarMaximized;
  return (
    <FlyoutAppearanceProvider><div className="task-row-design-preview design-page-shell" data-testid="design-page-shell" data-aside-maximized={maximized || undefined}>
      <a href={maximized ? "#design-page-aside-content" : "#design-page-content"} className="design-page-skip-link">Skip to main content</a>
      <SidebarShell open resizable storageKey={sidebarStorageKey} className="design-page-navigation">{sidebar}</SidebarShell>
      <div className="design-page-main">
        <header className="design-page-header"><h1>{title}</h1>{headerActions && <div className="design-page-header-actions">{headerActions}</div>}</header>
        <main id="design-page-content" className="design-page-content scrollbar-while-scrolling" onScroll={handleMainScroll} tabIndex={-1}>{children}</main>
      </div>
      {hasRightSidebar && <DesignPageAside title={rightSidebarTitle} maximized={maximized} storageKey={rightSidebarStorageKey}>
        <header className={`design-page-header${rightSidebarHeader ? " design-page-aside-header" : ""}`}>
          <h2 className={rightSidebarHeader ? "sr-only" : undefined}>{rightSidebarTitle}</h2>
          {rightSidebarHeader && <div className="design-page-aside-tabs">{rightSidebarHeader}</div>}
          {rightSidebarControls && <div className="design-page-aside-controls">{rightSidebarControls}</div>}
        </header>
        <div id="design-page-aside-content" className="design-page-content scrollbar-while-scrolling" onScroll={handleAsideScroll} role="region" aria-label={`${rightSidebarTitle} content`} tabIndex={0}>{rightSidebar}</div>
      </DesignPageAside>}
    </div></FlyoutAppearanceProvider>
  );
}
