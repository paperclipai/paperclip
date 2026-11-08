import type { ReactNode } from "react";
import { FileText } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

/**
 * Compact document affordance shared by saved plans and authored document links.
 * `card` is a standalone padded box; `inline` sits in running text (markdown
 * paragraphs) and must not grow taller than the text line it is part of.
 */
export function SidebarDocumentLink({ href, children, ariaLabel, testId, className, onPointerEnter, onFocus, variant = "card" }: {
  href: string;
  children: ReactNode;
  ariaLabel?: string;
  testId?: string;
  className?: string;
  onPointerEnter?: () => void;
  onFocus?: () => void;
  variant?: "card" | "inline";
}) {
  const inline = variant === "inline";
  return <Link to={href} disableIssueQuicklook aria-label={ariaLabel} data-testid={testId}
    onPointerEnter={onPointerEnter} onFocus={onFocus}
    data-sidebar-document-link
    className={cn(inline
      ? "inline rounded-sm bg-muted/40 px-1 box-decoration-clone text-foreground transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      : "inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/25 px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}>
    <FileText className={inline ? "mr-1 inline-block size-3.5 shrink-0 align-text-bottom text-muted-foreground" : "size-4 shrink-0"} aria-hidden />{children}
  </Link>;
}
