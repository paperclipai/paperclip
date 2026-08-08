import type { IssueSubtreeDiagnosticsResponse } from "@paperclipai/shared";
import { AlertTriangle, CheckCircle2, CircleDashed, GitBranch, Link2, Route } from "lucide-react";
import { Badge } from "@/components/ui/badge";

function pathLabel(path: IssueSubtreeDiagnosticsResponse["treeHealth"]["nodes"][number]["unresolvedPathType"]) {
  if (path === "none") return "No unresolved path";
  if (path === "execution") return "Needs execution";
  if (path === "dependency") return "Waiting on dependency";
  if (path === "review") return "Waiting on review";
  if (path === "external") return "External blocker";
  return "Cycle detected";
}

export function IssueTreeHealthDigest({ diagnostics }: { diagnostics: IssueSubtreeDiagnosticsResponse }) {
  const root = diagnostics.treeHealth.nodes.find((node) => node.issueId === diagnostics.issue.id);
  const hasWarning = diagnostics.treeHealth.cycleStatus === "detected"
    || Boolean(root?.continuationWarning || root?.depthWarning || root?.successfulRunsWithoutProgressWarning);
  const reason = diagnostics.likelyReason ?? (root ? pathLabel(root.unresolvedPathType) : "No tree-health signal yet");

  return (
    <section className="mb-3 rounded-lg border border-border bg-accent/20 p-3" aria-label="Tree health">
      <div className="flex flex-wrap items-start gap-2">
        {hasWarning ? <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden /> : <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">Tree health</h3>
            <Badge variant="outline" className="text-(length:--text-nano)">{hasWarning ? "Needs attention" : "Healthy"}</Badge>
          </div>
          <p className="mt-1 text-(length:--text-micro) text-muted-foreground">{reason}</p>
        </div>
      </div>
      {root ? (
        <div className="mt-3 grid gap-2 text-(length:--text-micro) text-muted-foreground sm:grid-cols-3">
          <div className="flex items-center gap-1.5"><Route className="h-3.5 w-3.5" aria-hidden />{pathLabel(root.unresolvedPathType)}</div>
          <div className="flex items-center gap-1.5"><GitBranch className="h-3.5 w-3.5" aria-hidden />Canonical continuation: {root.continuationCount}</div>
          <div className="flex items-center gap-1.5"><Link2 className="h-3.5 w-3.5" aria-hidden />Depth {root.depth}</div>
        </div>
      ) : null}
      {diagnostics.treeHealth.supersessionCandidates.length > 0 ? (
        <div className="mt-3 flex items-center gap-1.5 text-(length:--text-micro) text-muted-foreground"><CircleDashed className="h-3.5 w-3.5" aria-hidden />Possible duplicate continuation titles are advisory only; no routing has been changed.</div>
      ) : null}
    </section>
  );
}
