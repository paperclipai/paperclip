import type { ReactNode } from "react";
import { FileText } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

/** Compact document affordance shared by saved plans and authored document links. */
export function SidebarDocumentLink({ href, children, ariaLabel, testId, className, onPointerEnter, onFocus }: {
  href: string;
  children: ReactNode;
  ariaLabel?: string;
  testId?: string;
  className?: string;
  onPointerEnter?: () => void;
  onFocus?: () => void;
}) {
  return <Link to={href} disableIssueQuicklook aria-label={ariaLabel} data-testid={testId}
    onPointerEnter={onPointerEnter} onFocus={onFocus}
    data-sidebar-document-link
    className={cn("inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/25 px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}>
    <FileText className="size-4 shrink-0" aria-hidden />{children}
  </Link>;
}
