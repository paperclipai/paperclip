import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { IssuePlanDecompositionsSection } from "@/components/IssuePlanDecompositionsSection";
import { MarkdownBody } from "@/components/MarkdownBody";
import { useIssuePlanDocument } from "@/hooks/useIssuePlanDocument";
import { IssuePlanConfirmationActionBar } from "./IssuePlanConfirmationActionBar";

interface IssuePropertiesPlansTabProps {
  issue: Issue;
  /** True when hosted outside the properties panel (mobile sheet) — the plan
   * confirmation bar then renders in place instead of the pane footer slot. */
  inline?: boolean;
}

/**
 * Plans tab of the redesigned properties pane (flag: enableTaskChatRedesign).
 *
 * Owns the plan surface with the flag ON: the `plan` document itself (formerly
 * pinned above the tabs via IssueDocumentsSection, which the chat shell gates
 * off) rendered above the accepted-plan decomposition history. Structured live
 * PlanEntry/todo streaming is a flagged protocol dependency (demonstrated in
 * the /dev/task-chat-lab harness).
 */
export function IssuePropertiesPlansTab({ issue, inline }: IssuePropertiesPlansTabProps) {
  const { data: planDocument, isLoading: planDocumentLoading } = useIssuePlanDocument(issue.id);
  const { data } = useQuery({
    queryKey: queryKeys.issues.acceptedPlanDecompositions(issue.id),
    queryFn: () => issuesApi.listAcceptedPlanDecompositions(issue.id),
  });
  const hasPlans = (data?.length ?? 0) > 0;

  if (!planDocument && !hasPlans) {
    return (
      <div className="px-1 py-6 text-sm text-muted-foreground">
        {planDocumentLoading
          ? "Loading plan…"
          : "No plan yet. The plan document, accepted plans, and their revisions will appear here."}
      </div>
    );
  }

  return (
    <div className="space-y-4 py-2">
      {/* Pending plan confirmation: its CTAs pin to the pane's footer slot so
          they stay visible while the plan scrolls. */}
      {planDocument ? <IssuePlanConfirmationActionBar issue={issue} inline={inline} /> : null}
      {planDocument ? (
        <section data-testid="issue-plan-document" className="space-y-2">
          <div className="text-xs text-muted-foreground">
            {`Revision ${planDocument.latestRevisionNumber ?? 1} · updated ${new Date(planDocument.updatedAt).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}`}
          </div>
          <MarkdownBody>{planDocument.body}</MarkdownBody>
        </section>
      ) : null}
      {hasPlans ? (
        <IssuePlanDecompositionsSection issueId={issue.id} issueIdentifier={issue.identifier} />
      ) : null}
    </div>
  );
}
