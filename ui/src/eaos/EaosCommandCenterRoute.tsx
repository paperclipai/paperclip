// LET-513 §1 — EAOS landing-route wrapper.
//
// `/eaos` (index) routes through this component so first-run users with no
// companies see the EAOS-native onboarding screen at `/eaos/onboarding`
// instead of the dashboard. Users with at least one company hit the
// canonical `CommandCenterLanding` immediately. While the company list is
// still loading the route renders a neutral hold rather than flashing the
// dashboard or onboarding.
//
// The redirect is deliberately router-level (matches `CompanyRootRedirect`
// in App.tsx) so the dashboard never paints with empty state during
// onboarding.

import { Navigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { CommandCenterLanding } from "./CommandCenterLanding";
import { EaosPageHeader } from "./EaosPageHeader";

export function EaosCommandCenterRoute() {
  const { companies, loading } = useCompany();

  if (loading) {
    return (
      <section
        className="-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8"
        data-testid="eaos-command-center-loading"
      >
        <EaosPageHeader title="Dashboard" testId="eaos-command-center-loading-page-header" />
        <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
          <p
            role="status"
            aria-live="polite"
            className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
          >
            Loading workspace…
          </p>
        </div>
      </section>
    );
  }

  if (companies.length === 0) {
    return <Navigate to="/eaos/onboarding" replace />;
  }

  return <CommandCenterLanding />;
}
