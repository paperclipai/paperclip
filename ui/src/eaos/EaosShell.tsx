import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { EaosTopBar } from "./EaosTopBar";
import { EaosPrimaryNav } from "./EaosPrimaryNav";
import { EaosPostureStrip } from "./EaosPostureStrip";

export interface EaosShellProps {
  variant?: "eaos" | "kernel";
}

// EaosShell is the section layout for the `/eaos/*` board route. It nests
// inside the EaosProductLayout `<main id="main-content">` landmark and owns
// the EAOS-specific section landmarks (`banner`, `navigation`, `region`,
// `contentinfo`).
//
// LET-503 (LET-502 contract §3) — every nested flex region carries
// `min-h-0`, and the content pane scrolls (`overflow-auto`) so child pages
// can use tall tables / boards / detail panes without trapping the
// viewport. The body-level `overflow:hidden` set by EaosProductLayout
// still applies; this shell wires the proper scroll container chain.
export function EaosShell({ variant = "eaos" }: EaosShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const openPrimaryNav = useCallback(() => setDrawerOpen(true), []);
  const closePrimaryNav = useCallback(() => setDrawerOpen(false), []);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-eaos-shell={variant}>
      <EaosTopBar variant={variant} onOpenPrimaryNav={openPrimaryNav} />

      <div className="relative flex min-h-0 flex-1">
        <EaosPrimaryNav drawerOpen={drawerOpen} onClose={closePrimaryNav} />

        {drawerOpen ? (
          <button
            type="button"
            aria-label="Close primary navigation"
            onClick={closePrimaryNav}
            className="absolute inset-0 z-10 bg-black/30 md:hidden"
            data-testid="eaos-primary-nav-backdrop"
          />
        ) : null}

        <section
          role="region"
          id="eaos-section-content"
          tabIndex={-1}
          aria-label={variant === "kernel" ? "Kernel/Admin section content" : "Enterprise Agent OS section content"}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          data-testid="eaos-section"
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto px-4 py-5 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </section>
      </div>

      <EaosPostureStrip variant={variant} />
    </div>
  );
}
