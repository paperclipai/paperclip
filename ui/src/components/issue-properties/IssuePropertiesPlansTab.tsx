import { useCallback, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Issue,
  IssueDocument,
  IssueThreadInteraction,
  RequestConfirmationInteraction,
} from "@paperclipai/shared";
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Loader2,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { issuesApi } from "@/api/issues";
import { IssueDocumentsSection } from "@/components/IssueDocumentsSection";
import { IssuePlanDecompositionsSection } from "@/components/IssuePlanDecompositionsSection";
import { TaskChatCompactInteractionCard } from "@/components/task-chat/TaskChatCompactInteractionCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  isPlanningDocumentKey,
  PLANNING_DOCUMENT_KEYS,
  type PlanningDocumentKey,
} from "@/lib/issue-artifacts";
import {
  buildPlanningDocumentReviewRequest,
  deriveCurrentIssueDocumentReview,
  isIssueDocumentReviewInteraction,
} from "@/lib/issue-thread-interactions";
import { queryKeys } from "@/lib/queryKeys";

interface IssuePropertiesPlansTabProps {
  issue: Issue;
  inline?: boolean;
}

const PLANNING_DOCUMENT_CREATE_OPTIONS = [
  { key: "specification", label: "specification", title: "Specification" },
  { key: "plan", label: "plan", title: null },
] as const;

type ReviewDisplayState =
  | "unreviewed"
  | "waiting"
  | "approved"
  | "changes_requested"
  | "closed"
  | "blocked"
  | "loading"
  | "error";


function ReviewStateBadge({
  state,
  documentKey,
}: {
  state: ReviewDisplayState;
  documentKey: PlanningDocumentKey;
}) {
  const scopeOnly = documentKey === "specification";
  let icon: ReactNode = <ShieldCheck aria-hidden className="h-3 w-3" />;
  let label = scopeOnly ? "Ready for scope review" : "Ready for plan review";
  let className = "bg-background text-muted-foreground";

  if (state === "loading") {
    icon = <Loader2 aria-hidden className="h-3 w-3 animate-spin" />;
    label = "Loading review";
  } else if (state === "waiting") {
    icon = <Clock3 aria-hidden className="h-3 w-3" />;
    label = scopeOnly ? "Waiting for scope review" : "Waiting for plan review";
    className = "bg-muted/50 text-foreground";
  } else if (state === "approved") {
    icon = <CheckCircle2 aria-hidden className="h-3 w-3" />;
    label = scopeOnly
      ? "Approved · scope only"
      : "Approved · implementation authorized";
    className = "bg-accent/60 text-foreground";
  } else if (state === "changes_requested") {
    icon = <CircleAlert aria-hidden className="h-3 w-3" />;
    label = "Changes requested";
    className = "border-destructive/30 bg-destructive/5 text-destructive";
  } else if (state === "closed") {
    icon = <RotateCcw aria-hidden className="h-3 w-3" />;
    label = "Review closed";
  } else if (state === "blocked") {
    icon = <ShieldCheck aria-hidden className="h-3 w-3" />;
    label = "Review unavailable";
  } else if (state === "error") {
    icon = <CircleAlert aria-hidden className="h-3 w-3" />;
    label = "Review unavailable";
    className = "border-destructive/30 bg-destructive/5 text-destructive";
  }

  return (
    <Badge variant="outline" className={className}>
      {icon}
      {label}
    </Badge>
  );
}

interface PlanningDocumentReviewProps {
  issue: Issue;
  document: IssueDocument;
  displayedRevisionNumber: number;
  historicalPreview: boolean;
  draftConflicted: boolean;
  draftSaving: boolean;
  draftUnsaved: boolean;
  interactions: readonly IssueThreadInteraction[];
  interactionsLoading: boolean;
  interactionsError: boolean;
  requestPending: boolean;
  requestError: string | null;
  onRetryInteractions: () => void;
  onRequestReview: () => void;
  onAccept: (interaction: RequestConfirmationInteraction) => Promise<void>;
  onReject: (
    interaction: RequestConfirmationInteraction,
    reason?: string,
  ) => Promise<void>;
}

function PlanningDocumentReview({
  issue,
  document,
  displayedRevisionNumber,
  historicalPreview,
  draftConflicted,
  draftSaving,
  draftUnsaved,
  interactions,
  interactionsLoading,
  interactionsError,
  requestPending,
  requestError,
  onRetryInteractions,
  onRequestReview,
  onAccept,
  onReject,
}: PlanningDocumentReviewProps) {
  if (!isPlanningDocumentKey(document.key)) return null;
  const documentKey = document.key;
  const scopeOnly = documentKey === "specification";
  const review = deriveCurrentIssueDocumentReview(interactions, document);
  const hasEarlierReview = review.state === "unreviewed"
    && interactions.some((interaction) =>
      isIssueDocumentReviewInteraction(interaction, document));

  let blockedReason: string | null = null;
  if (historicalPreview) {
    blockedReason = `Viewing revision ${displayedRevisionNumber}. Review actions are available only on latest saved revision ${document.latestRevisionNumber}.`;
  } else if (draftConflicted) {
    blockedReason = "Resolve the out-of-date draft before reviewing this document.";
  } else if (draftSaving) {
    blockedReason = "Wait for this draft to finish saving before reviewing it.";
  } else if (draftUnsaved) {
    blockedReason = "Save this draft to create the exact revision that people will review.";
  } else if (!document.latestRevisionId) {
    blockedReason = "Save the first document revision before requesting review.";
  } else if (issue.status === "done" || issue.status === "cancelled") {
    blockedReason = "Closed tasks cannot start or resolve a new document review.";
  }

  const displayState: ReviewDisplayState = interactionsLoading
    ? "loading"
    : interactionsError
      ? "error"
      : blockedReason
        ? "blocked"
        : review.state;
  const canRequestReview = !blockedReason
    && !interactionsLoading
    && !interactionsError
    && review.state === "unreviewed";

  let description = scopeOnly
    ? `Approval applies to specification revision ${document.latestRevisionNumber} only. It confirms scope without changing work mode or authorizing implementation.`
    : `Approval applies to plan revision ${document.latestRevisionNumber} only. It authorizes implementation; planning tasks move to standard before continuation.`;
  if (review.state === "waiting") {
    description = `A human-only decision is pending for revision ${document.latestRevisionNumber}. Editing and saving a new revision makes this request stale.`;
  } else if (review.state === "changes_requested") {
    description = `Changes were requested for revision ${document.latestRevisionNumber}. Edit and save the document before requesting another review.`;
  } else if (review.state === "closed") {
    description = `The latest review request for revision ${document.latestRevisionNumber} is closed without current human approval. Edit and save a new revision before requesting another review.`;
  }
  if (interactionsError) {
    description = "Review state could not be loaded. Actions stay disabled until the current exact-revision state is known.";
  } else if (blockedReason) {
    description = blockedReason;
  }

  return (
    <section
      className="border-t border-border/70 pt-3"
      aria-label={`${scopeOnly ? "Specification" : "Plan"} review`}
      data-testid={`planning-document-review-${documentKey}`}
      data-review-state={displayState}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div aria-live="polite">
            <ReviewStateBadge state={displayState} documentKey={documentKey} />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">{description}</p>
          {hasEarlierReview && !blockedReason && !interactionsError ? (
            <p className="text-(length:--text-micro) leading-4 text-muted-foreground">
              Earlier review history remains in the task thread, but no prior decision applies to this revision.
            </p>
          ) : null}
        </div>
        {interactionsError ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full shrink-0 sm:w-auto"
            onClick={onRetryInteractions}
          >
            Retry review state
          </Button>
        ) : canRequestReview ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full shrink-0 sm:w-auto"
            onClick={onRequestReview}
            disabled={requestPending}
          >
            {requestPending ? (
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck aria-hidden className="h-3.5 w-3.5" />
            )}
            {requestPending ? "Requesting…" : "Request human review"}
          </Button>
        ) : null}
      </div>

      {requestError && canRequestReview ? (
        <p className="mt-2 text-xs text-destructive" role="alert">{requestError}</p>
      ) : null}

      {review.interaction && !blockedReason && !interactionsError ? (
        <div className="mt-3">
          <TaskChatCompactInteractionCard
            interaction={review.interaction}
            issueId={issue.id}
            presentation="takeover"
            showPlanPreview={false}
            draftKey={`paperclip:issue-document-review-draft:${review.interaction.id}`}
            onAcceptInteraction={(interaction) => {
              if (interaction.kind !== "request_confirmation") return;
              return onAccept(interaction);
            }}
            onRejectInteraction={(interaction, reason) => {
              if (interaction.kind !== "request_confirmation") return;
              return onReject(interaction, reason);
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Canonical planning surface: durable specification and implementation plan,
 * exact-revision human review, inline annotations, revision history/diffs, and
 * execution records created from accepted plan revisions.
 */
export function IssuePropertiesPlansTab({
  issue,
}: IssuePropertiesPlansTabProps) {
  const queryClient = useQueryClient();
  const interactionsQuery = useQuery({
    queryKey: queryKeys.issues.interactions(issue.id),
    queryFn: () => issuesApi.listInteractions(issue.id),
  });

  const syncInteraction = useCallback((interaction: IssueThreadInteraction) => {
    queryClient.setQueryData<IssueThreadInteraction[] | undefined>(
      queryKeys.issues.interactions(issue.id),
      (current) => {
        if (!current) return [interaction];
        const index = current.findIndex((candidate) => candidate.id === interaction.id);
        if (index === -1) return [...current, interaction];
        return current.map((candidate, candidateIndex) =>
          candidateIndex === index ? interaction : candidate);
      },
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(issue.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(issue.companyId) });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.issues.acceptedPlanDecompositions(issue.id),
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.attention(issue.companyId) });
  }, [issue.companyId, issue.id, queryClient]);

  const requestReviewMutation = useMutation({
    mutationFn: (document: IssueDocument) =>
      issuesApi.createInteraction(issue.id, buildPlanningDocumentReviewRequest(document)),
    onSuccess: syncInteraction,
  });
  const acceptReviewMutation = useMutation({
    mutationFn: (interaction: RequestConfirmationInteraction) =>
      issuesApi.acceptInteraction(issue.id, interaction.id),
    onSuccess: syncInteraction,
  });
  const rejectReviewMutation = useMutation({
    mutationFn: ({
      interaction,
      reason,
    }: {
      interaction: RequestConfirmationInteraction;
      reason?: string;
    }) => issuesApi.rejectInteraction(issue.id, interaction.id, reason),
    onSuccess: syncInteraction,
  });

  return (
    <div className="space-y-5 py-2">
      <section
        className="rounded-md bg-muted/35 p-3"
        aria-labelledby={`planning-approval-boundaries-${issue.id}`}
      >
        <div className="flex items-start gap-2">
          <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h3
              id={`planning-approval-boundaries-${issue.id}`}
              className="text-sm font-medium text-foreground"
            >
              Approval boundaries
            </h3>
            <dl className="mt-2 grid gap-2 text-xs leading-5 text-muted-foreground sm:grid-cols-2">
              <div>
                <dt className="font-medium text-foreground">Specification</dt>
                <dd>Defines scope. Approval is scope-only and never authorizes execution.</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Plan</dt>
                <dd>Defines implementation. Approval of its current revision authorizes execution.</dd>
              </div>
            </dl>
            <p className="mt-2 text-(length:--text-micro) leading-4 text-muted-foreground">
              Decisions apply to one saved revision. Run checklists remain separate from document review.
            </p>
          </div>
        </div>
      </section>

      <IssueDocumentsSection
        issue={issue}
        canDeleteDocuments={false}
        documentKeys={PLANNING_DOCUMENT_KEYS}
        documentCreateOptions={PLANNING_DOCUMENT_CREATE_OPTIONS}
        sectionTitle="Planning documents"
        annotationPanelPlacement="popover"
        renderDocumentFooter={(context) => (
          <PlanningDocumentReview
            issue={issue}
            {...context}
            interactions={interactionsQuery.data ?? []}
            interactionsLoading={interactionsQuery.isLoading}
            interactionsError={interactionsQuery.isError}
            requestPending={requestReviewMutation.isPending}
            requestError={
              requestReviewMutation.variables?.id === context.document.id
              && requestReviewMutation.error
                ? requestReviewMutation.error instanceof Error
                  ? requestReviewMutation.error.message
                  : "Could not request review."
                : null
            }
            onRetryInteractions={() => void interactionsQuery.refetch()}
            onRequestReview={() => requestReviewMutation.mutate(context.document)}
            onAccept={async (interaction) => {
              await acceptReviewMutation.mutateAsync(interaction);
            }}
            onReject={async (interaction, reason) => {
              await rejectReviewMutation.mutateAsync({ interaction, reason });
            }}
          />
        )}
      />

      <IssuePlanDecompositionsSection
        issueId={issue.id}
        issueIdentifier={issue.identifier}
      />
    </div>
  );
}
