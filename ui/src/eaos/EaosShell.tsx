import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { EaosTopBar } from "./EaosTopBar";
import { EaosPrimaryNav } from "./EaosPrimaryNav";
import { EaosPostureStrip } from "./EaosPostureStrip";

export interface EaosShellProps {
  variant?: "eaos" | "kernel";
}

// EaosShell is the section layout for the `/eaos/*` board route. It nests
// inside the existing kernel `Layout` (which already owns the page-level
// `<main id="main-content">` landmark and skip-link), so the shell renders
// the EAOS-specific section landmarks only:
//   - `banner`        -> EaosTopBar (section header)
//   - `navigation`    -> EaosPrimaryNav (zone strip)
//   - `region`        -> Outlet wrapper (section content)
//   - `contentinfo`   -> EaosPostureStrip (section posture)
//
// This slice is read-only — no LIVE mutating controls, no risky calls, no
// container/runtime mutation. Zone count badges are visibly marked as
// stub/preview until the LET-182 read model is wired.
export function EaosShell({ variant = "eaos" }: EaosShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const openPrimaryNav = useCallback(() => setDrawerOpen(true), []);
  const closePrimaryNav = useCallback(() => setDrawerOpen(false), []);

  return (
    <div className="flex flex-1 flex-col" data-eaos-shell={variant}>
      <EaosTopBar variant={variant} onOpenPrimaryNav={openPrimaryNav} />

      <div className="relative flex flex-1">
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
          className="flex flex-1 flex-col"
          data-testid="eaos-section"
        >
          <div className="w-full flex-1 px-4 py-5 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </section>
      </div>

      <EaosPostureStrip variant={variant} />
    </div>
  );
}
