import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { ChevronLeft, ChevronRight, CheckCircle2, ClipboardCheck } from "lucide-react";
import type {
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  RequestCheckboxConfirmationInteraction,
  RequestConfirmationInteraction,
  SuggestTasksInteraction,
} from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { IssueThreadInteractionCard } from "../components/IssueThreadInteractionCard";

type AcceptableInteraction =
  | SuggestTasksInteraction
  | RequestConfirmationInteraction
  | RequestCheckboxConfirmationInteraction;

export function ReviewQueue() {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [index, setIndex] = useState(0);

  const queryKey = ["pending-interactions", selectedCompanyId] as const;
  const { data: items = [], isLoading, refetch } = useQuery({
    queryKey,
    queryFn: () => issuesApi.listPendingInteractions(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchOnWindowFocus: true,
  });

  // Keep the cursor in range as answered items leave the queue.
  useEffect(() => {
    if (index > items.length - 1) setIndex(Math.max(0, items.length - 1));
  }, [items.length, index]);

  const current = items[index];

  const afterAnswer = useCallback(async () => {
    // Answered item drops out of "pending"; the next one slides into this slot.
    await refetch();
    queryClient.invalidateQueries({ queryKey: ["pending-interactions"] });
  }, [refetch, queryClient]);

  const onError = useCallback(
    (err: unknown) =>
      pushToast({
        title: "처리 실패",
        body: err instanceof Error ? err.message : "잠시 후 다시 시도하세요.",
        tone: "error",
      }),
    [pushToast],
  );

  const acceptMut = useMutation({
    mutationFn: (a: { issueId: string; interactionId: string; selectedClientKeys?: string[]; selectedOptionIds?: string[] }) =>
      issuesApi.acceptInteraction(a.issueId, a.interactionId, {
        selectedClientKeys: a.selectedClientKeys,
        selectedOptionIds: a.selectedOptionIds,
      }),
    onSuccess: afterAnswer,
    onError,
  });
  const rejectMut = useMutation({
    mutationFn: (a: { issueId: string; interactionId: string; reason?: string }) =>
      issuesApi.rejectInteraction(a.issueId, a.interactionId, a.reason),
    onSuccess: afterAnswer,
    onError,
  });
  const respondMut = useMutation({
    mutationFn: (a: { issueId: string; interactionId: string; answers: AskUserQuestionsAnswer[] }) =>
      issuesApi.respondToInteraction(a.issueId, a.interactionId, { answers: a.answers }),
    onSuccess: afterAnswer,
    onError,
  });
  const cancelMut = useMutation({
    mutationFn: (a: { issueId: string; interactionId: string }) =>
      issuesApi.cancelInteraction(a.issueId, a.interactionId),
    onSuccess: afterAnswer,
    onError,
  });

  const handleAccept = useCallback(
    async (interaction: AcceptableInteraction, selectedClientKeys?: string[], selectedOptionIds?: string[]) => {
      if (!current) return;
      await acceptMut.mutateAsync({ issueId: current.issue.id, interactionId: interaction.id, selectedClientKeys, selectedOptionIds });
    },
    [acceptMut, current],
  );
  const handleReject = useCallback(
    async (interaction: AcceptableInteraction, reason?: string) => {
      if (!current) return;
      await rejectMut.mutateAsync({ issueId: current.issue.id, interactionId: interaction.id, reason });
    },
    [rejectMut, current],
  );
  const handleRespond = useCallback(
    async (interaction: AskUserQuestionsInteraction, answers: AskUserQuestionsAnswer[]) => {
      if (!current) return;
      await respondMut.mutateAsync({ issueId: current.issue.id, interactionId: interaction.id, answers });
    },
    [respondMut, current],
  );
  const handleCancel = useCallback(
    async (interaction: AskUserQuestionsInteraction) => {
      if (!current) return;
      await cancelMut.mutateAsync({ issueId: current.issue.id, interactionId: interaction.id });
    },
    [cancelMut, current],
  );

  // Keyboard: ←/→ (or k/j) to move between items without touching the answer UI.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowRight" || e.key === "j") setIndex((i) => Math.min(items.length - 1, i + 1));
      else if (e.key === "ArrowLeft" || e.key === "k") setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length]);

  if (!selectedCompanyId) return null;

  return (
    <div className="mx-auto w-full max-w-3xl p-4 md:p-6">
      <div className="mb-4 flex items-center gap-2">
        <ClipboardCheck className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">Review</h1>
        {items.length > 0 && (
          <span className="text-sm text-muted-foreground">
            답변 대기 {items.length}건 · {index + 1} / {items.length}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          불러오는 중…
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-12 text-center">
          <CheckCircle2 className="h-10 w-10 text-emerald-500" />
          <p className="text-base font-medium">답변 대기 중인 항목이 없어요</p>
          <p className="text-sm text-muted-foreground">
            새 질문/결정이 올라오면 여기에서 한 번에 처리할 수 있어요.
          </p>
          <Link to="/issues" className="mt-2 text-sm text-primary hover:underline">
            태스크로 이동 →
          </Link>
        </div>
      ) : current ? (
        <>
          <div className="mb-3 flex items-center justify-between gap-2">
            <Link
              to={`/issues/${current.issue.id}`}
              className="truncate text-sm text-muted-foreground hover:text-foreground hover:underline"
              title={current.issue.title}
            >
              <span className="font-medium text-foreground">{current.issue.identifier}</span>{" "}
              {current.issue.title}
            </Link>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={index === 0}
                className="rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                title="이전 (←)"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setIndex((i) => Math.min(items.length - 1, i + 1))}
                disabled={index >= items.length - 1}
                className="rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                title="건너뛰기 / 다음 (→)"
              >
                건너뛰기
              </button>
              <button
                type="button"
                onClick={() => setIndex((i) => Math.min(items.length - 1, i + 1))}
                disabled={index >= items.length - 1}
                className="rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                title="다음 (→)"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          <IssueThreadInteractionCard
            key={current.interaction.id}
            interaction={current.interaction}
            onAcceptInteraction={handleAccept}
            onRejectInteraction={handleReject}
            onSubmitInteractionAnswers={handleRespond}
            onCancelInteraction={handleCancel}
          />
        </>
      ) : null}
    </div>
  );
}
