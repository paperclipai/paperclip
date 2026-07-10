import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FeedbackTrace,
  ImprovementSuggestion,
  InstanceImprovementSuggestion,
} from "@paperclipai/shared";
import { BrainCircuit, Building2, Check, MessageSquareWarning, ShieldCheck, X } from "lucide-react";
import { improvementSuggestionsApi } from "@/api/improvementSuggestions";
import { accessApi } from "@/api/access";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";

type ReviewState = {
  suggestion: ImprovementSuggestion;
  decision: "accept" | "reject";
} | null;

const targetLabels: Record<ImprovementSuggestion["targetLayer"], string> = {
  agent_prompt: "Agent prompt",
  company_skill: "Company skill",
  company_sop: "Company SOP",
  root_skill: "Paperclip root skill",
  orchestration_code: "Paperclip orchestration",
  qa_gate: "QA guardrail",
  workspace_guard: "Workspace guardrail",
};

const originLabels: Record<ImprovementSuggestion["originKind"], string> = {
  feedback_detected: "From feedback",
  agent_detected: "AI suggested",
  board_directed: "Board directed",
};

function statusVariant(status: ImprovementSuggestion["status"]) {
  if (status === "accepted") return "default" as const;
  if (status === "rejected") return "secondary" as const;
  return "outline" as const;
}

function canReviewCompanySuggestion(
  suggestion: ImprovementSuggestion,
  boardAccess: Awaited<ReturnType<typeof accessApi.getCurrentBoardAccess>> | undefined,
) {
  if (!boardAccess) return false;
  if (boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin) return true;
  if (suggestion.scope === "instance") return false;
  const membership = boardAccess.memberships?.find((entry) => entry.companyId === suggestion.companyId);
  return membership?.status === "active"
    && (membership.membershipRole === "owner" || membership.membershipRole === "admin");
}

function SuggestionCard({
  suggestion,
  companyPrefix,
  companyName,
  canReview,
  onReview,
}: {
  suggestion: ImprovementSuggestion;
  companyPrefix: string;
  companyName?: string;
  canReview: boolean;
  onReview: (suggestion: ImprovementSuggestion, decision: "accept" | "reject") => void;
}) {
  return (
    <article className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={suggestion.scope === "instance" ? "default" : "secondary"}>
              {suggestion.scope === "instance" ? "Paperclip / instance" : "Company"}
            </Badge>
            <Badge variant="outline">{targetLabels[suggestion.targetLayer]}</Badge>
            <Badge variant={statusVariant(suggestion.status)}>{suggestion.status.replace("_", " ")}</Badge>
            <span className="text-xs text-muted-foreground">{originLabels[suggestion.originKind]}</span>
          </div>
          <h2 className="text-base font-semibold text-foreground">{suggestion.title}</h2>
          {companyName ? <p className="text-xs text-muted-foreground">Raised from {companyName}</p> : null}
        </div>
        <span className="text-xs text-muted-foreground">{timeAgo(suggestion.createdAt)}</span>
      </div>

      <p className="mt-4 text-sm leading-6 text-muted-foreground">{suggestion.summary}</p>
      <div className="mt-4 rounded-lg border border-border/70 bg-background/60 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Proposed durable change</div>
        <p className="mt-1.5 text-sm leading-6 text-foreground">{suggestion.proposedChange}</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{suggestion.evidence.length} evidence item{suggestion.evidence.length === 1 ? "" : "s"}</span>
        {suggestion.sourceIssueId ? (
          <>
            <span>·</span>
            <Link
              to={`/${companyPrefix}/issues/${suggestion.sourceIssueId}`}
              className="font-medium text-foreground underline underline-offset-4"
            >
              Open source issue
            </Link>
          </>
        ) : null}
      </div>

      {suggestion.status === "pending_review" ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
          <p className="text-xs text-muted-foreground">
            {canReview
              ? "Approval records the direction; it does not silently edit code or skills."
              : suggestion.scope === "instance"
                ? "An instance administrator must review this Paperclip-level suggestion."
                : "A company owner or administrator must review this suggestion."}
          </p>
          {canReview ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => onReview(suggestion, "reject")}>
                <X className="mr-1.5 h-3.5 w-3.5" /> Reject
              </Button>
              <Button size="sm" onClick={() => onReview(suggestion, "accept")}>
                <Check className="mr-1.5 h-3.5 w-3.5" /> Accept
              </Button>
            </div>
          ) : null}
        </div>
      ) : suggestion.reviewNote ? (
        <div className="mt-4 border-t border-border/70 pt-4 text-xs text-muted-foreground">
          Review note: {suggestion.reviewNote}
        </div>
      ) : null}
    </article>
  );
}

function FeedbackRow({ trace, companyPrefix }: { trace: FeedbackTrace; companyPrefix: string }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={trace.vote === "down" ? "outline" : "secondary"}>
            {trace.vote === "down" ? "Needs work" : "Helpful"}
          </Badge>
          <Link
            to={`/${companyPrefix}/issues/${trace.issueId}`}
            className="truncate text-sm font-medium text-foreground hover:underline"
          >
            {trace.issueIdentifier ?? trace.issueTitle}
          </Link>
          <span className="text-xs text-muted-foreground">{trace.targetSummary.label}</span>
        </div>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {trace.reason || (trace.vote === "down" ? "No note was added." : "No note required.")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <span>{trace.status === "local_only" ? "Saved locally" : trace.status}</span>
        <span>·</span>
        <span>{timeAgo(trace.updatedAt)}</span>
      </div>
    </div>
  );
}

function ReviewDialog({
  state,
  note,
  setNote,
  saving,
  onClose,
  onSubmit,
}: {
  state: ReviewState;
  note: string;
  setNote: (value: string) => void;
  saving: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.decision === "accept" ? "Accept improvement" : "Reject improvement"}</DialogTitle>
          <DialogDescription>
            Record why this direction should or should not move forward. The decision is auditable and can only be made once.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Decision rationale"
          className="min-h-28"
          disabled={saving}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={onSubmit} disabled={saving || !note.trim()}>
            {saving ? "Saving..." : "Record decision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CompanyImprovementSuggestions() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<"all" | "company" | "instance">("all");
  const [reviewState, setReviewState] = useState<ReviewState>(null);
  const [reviewNote, setReviewNote] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Company Settings" }, { label: "Improvements" }]);
  }, [setBreadcrumbs]);

  const suggestionsQuery = useQuery({
    queryKey: queryKeys.improvementSuggestions.company(selectedCompanyId!),
    queryFn: () => improvementSuggestionsApi.listCompany(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const feedbackQuery = useQuery({
    queryKey: queryKeys.improvementSuggestions.feedback(selectedCompanyId!),
    queryFn: () => improvementSuggestionsApi.listFeedback(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const reviewMutation = useMutation({
    mutationFn: ({ suggestion, decision, note }: { suggestion: ImprovementSuggestion; decision: "accept" | "reject"; note: string }) =>
      improvementSuggestionsApi.review(suggestion.companyId, suggestion.id, { decision, note }),
    onSuccess: async () => {
      setReviewState(null);
      setReviewNote("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.improvementSuggestions.company(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.improvementSuggestions.instance }),
      ]);
    },
  });

  const suggestions = suggestionsQuery.data ?? [];
  const filteredSuggestions = scope === "all"
    ? suggestions
    : suggestions.filter((suggestion) => suggestion.scope === scope);
  const feedback = feedbackQuery.data ?? [];
  const downvotes = feedback.filter((trace) => trace.vote === "down").length;
  const pendingCompany = suggestions.filter((item) => item.status === "pending_review" && item.scope === "company").length;
  const pendingInstance = suggestions.filter((item) => item.status === "pending_review" && item.scope === "instance").length;

  if (!selectedCompanyId || !selectedCompany) {
    return <EmptyState icon={Building2} message="Select a company to review improvements." />;
  }
  if (suggestionsQuery.isLoading || feedbackQuery.isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <BrainCircuit className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Improvement inbox</h1>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Every Helpful or Needs work vote stays in the feedback history below. Needs work votes also create a pending,
          evidence-linked candidate; agents can add their own AI-detected suggestions through the same governed queue.
        </p>
      </div>

      {(suggestionsQuery.error || feedbackQuery.error || reviewMutation.error) ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {(suggestionsQuery.error ?? feedbackQuery.error ?? reviewMutation.error) instanceof Error
            ? (suggestionsQuery.error ?? feedbackQuery.error ?? reviewMutation.error as Error).message
            : "Failed to load improvement data."}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryBox label="Captured feedback" value={feedback.length} hint={`${downvotes} need${downvotes === 1 ? "s" : ""} work`} />
        <SummaryBox label="Company review" value={pendingCompany} hint="skills, SOPs, prompts" />
        <SummaryBox label="Instance review" value={pendingInstance} hint="Paperclip guardrails" />
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Suggestions</h2>
            <p className="mt-1 text-xs text-muted-foreground">AI suggestions, feedback candidates, and board directives stay separate in the audit trail.</p>
          </div>
          <div className="flex gap-1 rounded-lg border border-border bg-card p-1">
            {(["all", "company", "instance"] as const).map((value) => (
              <Button key={value} size="sm" variant={scope === value ? "secondary" : "ghost"} onClick={() => setScope(value)}>
                {value === "all" ? "All" : value === "company" ? "Company" : "Paperclip"}
              </Button>
            ))}
          </div>
        </div>
        {filteredSuggestions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No suggestions in this scope yet.
          </div>
        ) : filteredSuggestions.map((suggestion) => (
          <SuggestionCard
            key={suggestion.id}
            suggestion={suggestion}
            companyPrefix={selectedCompany.issuePrefix}
            canReview={canReviewCompanySuggestion(suggestion, boardAccessQuery.data)}
            onReview={(item, decision) => { setReviewState({ suggestion: item, decision }); setReviewNote(""); }}
          />
        ))}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Captured feedback</h2>
          <p className="mt-1 text-xs text-muted-foreground">This is the local destination for every vote, including Helpful votes and Needs work votes without a note.</p>
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {feedback.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No feedback has been captured for this company yet.</div>
          ) : feedback.map((trace) => <FeedbackRow key={trace.id} trace={trace} companyPrefix={selectedCompany.issuePrefix} />)}
        </div>
      </section>

      <ReviewDialog
        state={reviewState}
        note={reviewNote}
        setNote={setReviewNote}
        saving={reviewMutation.isPending}
        onClose={() => { setReviewState(null); setReviewNote(""); }}
        onSubmit={() => {
          if (!reviewState || !reviewNote.trim()) return;
          reviewMutation.mutate({ ...reviewState, note: reviewNote.trim() });
        }}
      />
    </div>
  );
}

export function InstanceImprovementSuggestions() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [reviewState, setReviewState] = useState<ReviewState>(null);
  const [reviewNote, setReviewNote] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "Improvements" }]);
  }, [setBreadcrumbs]);

  const suggestionsQuery = useQuery({
    queryKey: queryKeys.improvementSuggestions.instance,
    queryFn: () => improvementSuggestionsApi.listInstance(),
  });
  const reviewMutation = useMutation({
    mutationFn: ({ suggestion, decision, note }: { suggestion: ImprovementSuggestion; decision: "accept" | "reject"; note: string }) =>
      improvementSuggestionsApi.review(suggestion.companyId, suggestion.id, { decision, note }),
    onSuccess: async () => {
      setReviewState(null);
      setReviewNote("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.improvementSuggestions.instance });
    },
  });

  const suggestions = suggestionsQuery.data ?? [];
  const pending = suggestions.filter((item) => item.status === "pending_review").length;
  const companies = useMemo(() => new Set(suggestions.map((item) => item.companyId)).size, [suggestions]);

  if (suggestionsQuery.isLoading) return <PageSkeleton variant="list" />;
  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Paperclip improvements</h1>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Instance-wide suggestions from every company land here when the proposed fix belongs in Paperclip itself:
          root skills, orchestration code, QA gates, or workspace guardrails.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SummaryBox label="Pending instance review" value={pending} hint="requires instance admin" />
        <SummaryBox label="Companies represented" value={companies} hint="cross-company evidence" />
      </div>
      {(suggestionsQuery.error || reviewMutation.error) ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {(suggestionsQuery.error ?? reviewMutation.error) instanceof Error
            ? (suggestionsQuery.error ?? reviewMutation.error as Error).message
            : "Failed to load instance improvements."}
        </div>
      ) : null}
      <section className="space-y-3">
        {suggestions.length === 0 ? (
          <EmptyState icon={MessageSquareWarning} message="No Paperclip-level improvement suggestions yet." />
        ) : suggestions.map((suggestion: InstanceImprovementSuggestion) => (
          <SuggestionCard
            key={suggestion.id}
            suggestion={suggestion}
            companyPrefix={suggestion.companyIssuePrefix}
            companyName={suggestion.companyName}
            canReview
            onReview={(item, decision) => { setReviewState({ suggestion: item, decision }); setReviewNote(""); }}
          />
        ))}
      </section>
      <ReviewDialog
        state={reviewState}
        note={reviewNote}
        setNote={setReviewNote}
        saving={reviewMutation.isPending}
        onClose={() => { setReviewState(null); setReviewNote(""); }}
        onSubmit={() => {
          if (!reviewState || !reviewNote.trim()) return;
          reviewMutation.mutate({ ...reviewState, note: reviewNote.trim() });
        }}
      />
    </div>
  );
}

function SummaryBox({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}
