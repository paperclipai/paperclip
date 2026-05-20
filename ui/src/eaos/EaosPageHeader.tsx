import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useCompany } from "@/context/CompanyContext";
import { redactSecretLikeText } from "./secret-redact";

// LET-506 (Multica adaptation, round-1) — Multica's page header is a fixed
// 12-h row with the workspace avatar + breadcrumb on the left and slots
// for filters/actions on the right (see `packages/views/layout/page-header.tsx`
// in `/opt/paperclip-reference/multica`). The EAOS adaptation keeps the
// same density and slots but reuses Paperclip's existing company context
// + secret-redact discipline so no operator/runtime/secret data leaks.

export interface EaosPageHeaderProps {
  // The route surface name, e.g. "Missions". Shown in the breadcrumb's
  // active position.
  title: string;
  // Optional slot rendered on the right edge of the header (e.g. a view
  // toggle, a "New" button). Mirrors Multica's `IssuesHeader` action row
  // but stays thin.
  actions?: ReactNode;
  // Optional secondary breadcrumb segment between the workspace name and
  // the active title (e.g. "Projects" → project name).
  breadcrumb?: ReactNode;
  // Optional density override for embedding inside denser pages.
  className?: string;
  // Optional test id override.
  testId?: string;
}

export function EaosPageHeader({
  title,
  actions,
  breadcrumb,
  className,
  testId,
}: EaosPageHeaderProps) {
  const { selectedCompany } = useCompany();
  // Company name originates from user-authored records; route every visible
  // surface through `redactSecretLikeText` so a pasted credential cannot
  // surface in the breadcrumb.
  const companyName = selectedCompany?.name
    ? redactSecretLikeText(selectedCompany.name)
    : "Workspace";

  return (
    <div
      role="region"
      aria-label={`${title} page header`}
      data-testid={testId ?? "eaos-page-header"}
      className={
        "flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-4 " +
        (className ?? "")
      }
    >
      <span
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted/70 text-[10px] font-semibold uppercase text-muted-foreground"
        aria-hidden="true"
      >
        {companyName.charAt(0)}
      </span>
      <span
        className="max-w-[12rem] truncate text-sm text-muted-foreground"
        data-testid="eaos-page-header-workspace"
      >
        {companyName}
      </span>
      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      {breadcrumb ? (
        <>
          <span
            className="max-w-[12rem] truncate text-sm text-muted-foreground"
            data-testid="eaos-page-header-breadcrumb"
          >
            {breadcrumb}
          </span>
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
        </>
      ) : null}
      <span
        className="truncate text-sm font-medium text-foreground"
        data-testid="eaos-page-header-title"
      >
        {title}
      </span>
      {actions ? (
        <div className="ml-auto flex items-center gap-2" data-testid="eaos-page-header-actions">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
