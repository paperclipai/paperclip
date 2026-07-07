import { Link, useCaseHref } from "@/lib/router";
import type { CaseSummary } from "@/api/cases";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";

/**
 * Children tree (P4 §3): the parent's direct child cases with type + status
 * chips. Display only — no rollup semantics. Renders nothing structural beyond
 * a flat list; nesting depth is intentionally one level in v1.
 */
export function CaseChildrenTree({ children }: { children: CaseSummary[] }) {
  const caseHref = useCaseHref();
  if (children.length === 0) {
    return <p className="text-xs text-muted-foreground">No child cases.</p>;
  }
  return (
    <ul className="space-y-1">
      {children.map((child) => (
        <li key={child.id}>
          <Link
            to={caseHref(child.identifier)}
            className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm transition-colors hover:bg-accent/50"
          >
            <span className="font-mono text-xs text-muted-foreground shrink-0">{child.identifier}</span>
            <span className="min-w-0 flex-1 truncate" title={child.title}>{child.title}</span>
            <Badge variant="secondary" className="shrink-0">{child.caseType}</Badge>
            <StatusBadge status={child.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
