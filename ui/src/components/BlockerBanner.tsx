import { useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import type { IssueRelation } from "@paperclipai/shared";

/**
 * Displays contextual banners for blocked/blocking issue relationships.
 *
 * On a blocked issue:  "This issue is blocked by [BLOCKER] — View blocker"
 * On a blocker issue:  "Resolving this issue will unblock [ORIGINAL]" + "Resolve & Unblock" button with comment field
 */
export function BlockerBanner({
  issueId,
  companyId,
  issueStatus,
}: {
  issueId: string;
  companyId: string;
  issueStatus: string;
}) {
  const queryClient = useQueryClient();
  const [resolveComment, setResolveComment] = useState("");
  const [showResolveForm, setShowResolveForm] = useState(false);

  const { data: relations } = useQuery({
    queryKey: queryKeys.issues.relations(issueId),
    queryFn: () => issuesApi.listRelations(issueId),
  });

  const resolveBlocker = useMutation({
    mutationFn: (data: { comment?: string }) =>
      issuesApi.resolveBlocker(issueId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.relations(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      setResolveComment("");
      setShowResolveForm(false);
    },
  });

  if (!relations || relations.length === 0) return null;

  // This issue is blocked by something (someone created a blocker that "blocks" this issue)
  const blockers = relations.filter(
    (r: IssueRelation) =>
      r.type === "blocks" &&
      r.relatedIssueId === issueId &&
      r.relatedIssue &&
      r.relatedIssue.status !== "done" &&
      r.relatedIssue.status !== "cancelled",
  );

  // This issue blocks something (this is a blocker issue)
  const blocking = relations.filter(
    (r: IssueRelation) =>
      r.type === "blocks" &&
      r.issueId === issueId,
  );

  return (
    <div className="space-y-2">
      {/* Banner: This issue is blocked */}
      {issueStatus === "blocked" && blockers.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="font-medium">This issue is blocked</span>
          </div>
          <div className="mt-2 space-y-1">
            {blockers.map((r: IssueRelation) => (
              <Link
                key={r.id}
                to={`/issues/${r.issueId}`}
                className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400 hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                <span>
                  Waiting on{" "}
                  <span className="font-mono font-medium">
                    {r.relatedIssue?.identifier ?? r.issueId.slice(0, 8)}
                  </span>
                  {r.relatedIssue?.title ? `: ${r.relatedIssue.title}` : ""}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Banner: This issue is a blocker — offer Resolve & Unblock */}
      {blocking.length > 0 && issueStatus !== "done" && issueStatus !== "cancelled" && (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-blue-700 dark:text-blue-400">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span className="font-medium">
              Resolving this issue will unblock{" "}
              {blocking.map((r: IssueRelation) => (
                <Link
                  key={r.id}
                  to={`/issues/${r.relatedIssueId}`}
                  className="font-mono hover:underline"
                >
                  {r.relatedIssue?.identifier ?? r.relatedIssueId.slice(0, 8)}
                </Link>
              ))}
            </span>
          </div>

          {!showResolveForm ? (
            <div className="mt-2">
              <Button
                size="sm"
                variant="default"
                onClick={() => setShowResolveForm(true)}
              >
                Resolve & Unblock
              </Button>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <textarea
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="Add context or instructions for the agent (optional)..."
                rows={3}
                value={resolveComment}
                onChange={(e) => setResolveComment(e.target.value)}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="default"
                  disabled={resolveBlocker.isPending}
                  onClick={() =>
                    resolveBlocker.mutate({
                      comment: resolveComment.trim() || undefined,
                    })
                  }
                >
                  {resolveBlocker.isPending ? "Resolving..." : "Confirm Resolve & Unblock"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowResolveForm(false);
                    setResolveComment("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
