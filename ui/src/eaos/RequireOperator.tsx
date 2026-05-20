// LET-513 §4 — Route-level operator guard for EAOS surfaces.
//
// The rail filters operator-only zones out for customer-member viewers
// (`EaosPrimaryNav`), but a direct URL hit (`/eaos/admin`,
// `/eaos/approvals`, `/eaos/org`, `/eaos/capabilities`, `/eaos/blueprints`)
// still resolves to the page component. This guard wraps those routes so a
// customer viewer sees a clear "Operator only" notice instead of operator
// chrome.
//
// Failure mode is permissive while the access query is loading (matches
// `useEaosViewerRole` semantics) so customers don't see a brief operator
// flash on first paint — the loading state renders a neutral panel rather
// than the underlying page.

import type { ReactNode } from "react";
import { Outlet } from "@/lib/router";
import { EaosPageHeader } from "./EaosPageHeader";
import { useEaosViewerRole } from "./useEaosViewerRole";

export interface RequireOperatorProps {
  // When set, render the children directly instead of `<Outlet />`. Used by
  // tests and by pages that want page-level (rather than route-level)
  // gating.
  children?: ReactNode;
  // Human-readable surface label shown in the not-authorized notice.
  surfaceLabel?: string;
}

export function RequireOperator({ children, surfaceLabel }: RequireOperatorProps = {}) {
  const { isOperator, loading } = useEaosViewerRole();

  if (loading) {
    return (
      <section
        aria-labelledby="eaos-require-operator-loading-title"
        className="-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8"
        data-testid="eaos-require-operator-loading"
      >
        <EaosPageHeader
          title={surfaceLabel ?? "Loading"}
          testId="eaos-require-operator-page-header"
        />
        <h1 id="eaos-require-operator-loading-title" className="sr-only">
          Checking access…
        </h1>
        <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
          <p
            role="status"
            aria-live="polite"
            className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
          >
            Checking access…
          </p>
        </div>
      </section>
    );
  }

  if (!isOperator) {
    return (
      <section
        aria-labelledby="eaos-require-operator-title"
        className="-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8"
        data-testid="eaos-require-operator-denied"
      >
        <EaosPageHeader
          title={surfaceLabel ?? "Operator only"}
          testId="eaos-require-operator-page-header"
        />
        <h1 id="eaos-require-operator-title" className="sr-only">
          Operator only
        </h1>
        <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
          <div
            role="alert"
            className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
            data-testid="eaos-require-operator-message"
          >
            <p className="font-medium">This surface is admin-only.</p>
            <p className="mt-1 text-xs">
              Ask a company owner, admin, or operator to invite you with elevated
              access, or return to your dashboard.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return <>{children ?? <Outlet />}</>;
}
