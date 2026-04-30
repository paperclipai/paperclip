import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  Rt2BoardQualityStatus,
  Rt2CaptureDraftSummary,
  Rt2CaptureQueue,
  Rt2DailyBoard as Rt2DailyBoardData,
  Rt2DailyLane,
  Rt2DailyReportCard,
  Rt2DeliverableKind,
  UpsertRt2DailyReportCard,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { rt2DailyReportApi } from "@/api/rt2-daily-report";

const BOARD_LANES: Array<{ key: Rt2DailyLane; label: string }> = [
  { key: "todo", label: "할 일" },
  { key: "doing", label: "진행 중" },
  { key: "done", label: "완료" },
];

const BUCKET_OPTIONS = ["진행중", "내일 할 일", "아이디어", "미룬일"] as const;
const FILTERS = [
  { key: "today", label: "오늘 업무" },
  { key: "mine", label: "내 업무" },
  { key: "missing_deliverable", label: "산출물 누락" },
  { key: "approval_waiting", label: "승인 대기" },
  { key: "quality_issue", label: "품질 이슈" },
] as const;

const SORT_OPTIONS = [
  { key: "default", label: "기본 순서" },
  { key: "recent", label: "최근 수정순" },
  { key: "due_date", label: "마감일순" },
  { key: "needs_work", label: "보완 필요 먼저" },
  { key: "quality_issue", label: "품질 이슈 먼저" },
  { key: "gold_desc", label: "Gold 높은순" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];
type SortKey = (typeof SORT_OPTIONS)[number]["key"];
type QuickField = "title" | "lane" | "deliverable" | "basePrice" | "quality" | "okr";

type CardDraft = {
  lane: Rt2DailyLane;
  bucketLabel: string | null;
  progressPercent: number;
  note: string | null;
};

type QuickDraft = {
  title: string;
  deliverableTitle: string;
  deliverableType: Rt2DeliverableKind;
  deliverableRequired: boolean;
  basePrice: number;
  qualityStatus: Rt2BoardQualityStatus;
  goalId: string;
};

function buildDrafts(board: Rt2DailyBoardData): Record<string, CardDraft> {
  return Object.fromEntries(
    board.cards.map((card) => [
      card.todoIssueId,
      {
        lane: card.lane,
        bucketLabel: card.bucketLabel,
        progressPercent: card.progressPercent,
        note: card.note,
      },
    ]),
  );
}

function buildQuickDraft(card: Rt2DailyReportCard): QuickDraft {
  return {
    title: card.todoTitle,
    deliverableTitle: card.deliverableTitle ?? "",
    deliverableType: card.deliverableType ?? "document",
    deliverableRequired: card.deliverableRequired ?? true,
    basePrice: card.basePriceTotal,
    qualityStatus: card.qualityStatus,
    goalId: card.directGoalId ?? "",
  };
}

function buildQuickDrafts(board: Rt2DailyBoardData): Record<string, QuickDraft> {
  return Object.fromEntries(board.cards.map((card) => [card.todoIssueId, buildQuickDraft(card)]));
}

export function Rt2DailyBoard({
  board,
  pendingTodoIssueId,
  failedTodoIssueId = null,
  onSaveCard,
  captureQueue = null,
  pendingCaptureDraftId = null,
  onPromoteCaptureDraft,
  onFailCaptureDraft,
  onReviseCaptureDraft,
  onTransitionCaptureDraft,
}: {
  board: Rt2DailyBoardData;
  pendingTodoIssueId: string | null;
  failedTodoIssueId?: string | null;
  onSaveCard: (todoIssueId: string, data: UpsertRt2DailyReportCard) => void;
  captureQueue?: Rt2CaptureQueue | null;
  pendingCaptureDraftId?: string | null;
  onPromoteCaptureDraft?: (draftId: string) => void;
  onFailCaptureDraft?: (draftId: string, reason: string) => void;
  onReviseCaptureDraft?: (draftId: string, data: {
    snapshot: {
      taskTitle: string;
      todoTitle?: string;
      deliverableTitle: string;
      deliverableType?: Rt2DeliverableKind;
      basePrice?: number | null;
      taskMode?: "solo" | "collab";
      capacity?: number;
      qualityHint?: string | null;
      goalId?: string | null;
      okrCandidate?: string | null;
      sourceEvidenceNote?: string | null;
      operatorNote?: string | null;
    };
    changeSummary?: string;
  }) => void;
  onTransitionCaptureDraft?: (draftId: string, data: {
    action: "hold" | "reject" | "request_revision" | "mark_review_required";
    reason?: string;
  }) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, CardDraft>>(() => buildDrafts(board));
  const [quickDrafts, setQuickDrafts] = useState<Record<string, QuickDraft>>(() => buildQuickDrafts(board));
  const [editingTodoIssueId, setEditingTodoIssueId] = useState<string | null>(null);
  const [draggingTodoIssueId, setDraggingTodoIssueId] = useState<string | null>(null);
  const [dropLane, setDropLane] = useState<Rt2DailyLane | null>(null);
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(() => new Set());
  const [searchText, setSearchText] = useState("");
  const [sortMode, setSortMode] = useState<SortKey>("default");

  const traceGoalByTodoId = useMemo(() => {
    return new Map(
      board.cockpit.traceRows.map((trace) => [
        trace.todoIssueId,
        trace.goalPath.map((goal) => goal.title).join(" "),
      ]),
    );
  }, [board.cockpit.traceRows]);

  useEffect(() => {
    setDrafts(buildDrafts(board));
    setQuickDrafts((current) => {
      const next = { ...current };
      for (const card of board.cards) {
        if (!next[card.todoIssueId] || card.todoIssueId !== failedTodoIssueId) {
          next[card.todoIssueId] = buildQuickDraft(card);
        }
      }
      return next;
    });
  }, [board, failedTodoIssueId]);

  function saveCard(todoIssueId: string, draft: CardDraft) {
    onSaveCard(todoIssueId, {
      projectId: board.projectId,
      reportDate: board.reportDate,
      lane: draft.lane,
      bucketLabel: draft.bucketLabel,
      progressPercent: draft.progressPercent,
      note: draft.note,
    });
  }

  function moveCard(todoIssueId: string, lane: Rt2DailyLane) {
    const card = board.cards.find((candidate) => candidate.todoIssueId === todoIssueId);
    if (!card) return;

    const currentDraft = drafts[todoIssueId] ?? {
      lane: card.lane,
      bucketLabel: card.bucketLabel,
      progressPercent: card.progressPercent,
      note: card.note,
    };
    const nextDraft = { ...currentDraft, lane };

    setDrafts((current) => ({
      ...current,
      [todoIssueId]: nextDraft,
    }));
    saveCard(todoIssueId, nextDraft);
  }

  function toggleFilter(key: FilterKey) {
    setActiveFilters((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function updateQuickDraft(todoIssueId: string, patch: Partial<QuickDraft>) {
    setQuickDrafts((current) => ({
      ...current,
      [todoIssueId]: {
        ...(current[todoIssueId] ?? buildQuickDraft(board.cards.find((card) => card.todoIssueId === todoIssueId)!)),
        ...patch,
      },
    }));
  }

  async function saveQuickField(card: Rt2DailyReportCard, field: QuickField) {
    const draft = quickDrafts[card.todoIssueId] ?? buildQuickDraft(card);
    const context = { projectId: board.projectId, reportDate: board.reportDate };

    if (field === "title") {
      await rt2DailyReportApi.updateCardTitle(board.companyId, card.todoIssueId, { ...context, title: draft.title });
      return;
    }
    if (field === "lane") {
      saveCard(card.todoIssueId, drafts[card.todoIssueId] ?? buildDrafts({ ...board, cards: [card] })[card.todoIssueId]);
      return;
    }
    if (field === "deliverable" || field === "basePrice") {
      await rt2DailyReportApi.upsertCardDeliverable(board.companyId, card.todoIssueId, {
        ...context,
        title: draft.deliverableTitle || card.deliverableTitle || card.todoTitle,
        type: draft.deliverableType,
        required: draft.deliverableRequired,
        basePrice: Math.max(0, Math.trunc(draft.basePrice || 0)),
      });
      return;
    }
    if (field === "quality") {
      await rt2DailyReportApi.updateCardQuality(board.companyId, card.todoIssueId, {
        ...context,
        qualityStatus: draft.qualityStatus,
      });
      return;
    }
    await rt2DailyReportApi.updateCardOkr(board.companyId, card.todoIssueId, {
      ...context,
      goalId: draft.goalId || null,
    });
  }

  const viewCards = useMemo(() => {
    const filtered = board.cards.filter((card) => cardMatchesFilters(card, activeFilters, searchText, board, traceGoalByTodoId));
    return sortCards(filtered, sortMode);
  }, [activeFilters, board, searchText, sortMode, traceGoalByTodoId]);

  const hasActiveViewControl = activeFilters.size > 0 || searchText.trim().length > 0;

  return (
    <div className="grid min-h-[640px] gap-4 xl:grid-cols-[280px_minmax(0,1fr)_320px]">
      <aside className="space-y-4 rounded-lg border border-border bg-card/80 p-4">
        <div>
          <h3 className="text-sm font-semibold">일일보고 맥락</h3>
          <p className="mt-1 text-xs text-muted-foreground">{board.reportDate}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Metric label="Task" value={board.cockpit.summary.tasksWorked} />
          <Metric label="완료 To-Do" value={board.cockpit.summary.todosCompleted} />
          <Metric label="산출물" value={board.cockpit.summary.deliverablesDefined} />
          <Metric label="메모" value={board.cockpit.summary.effortNoteCount} />
        </div>
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">OKR/KPI 추적</h4>
          {board.cockpit.traceRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">오늘 연결된 작업이 없습니다.</p>
          ) : (
            board.cockpit.traceRows.map((trace) => (
              <div key={trace.todoIssueId} className="rounded-md border border-border bg-background px-3 py-2">
                <div className="truncate text-xs font-medium">{trace.todoTitle}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {trace.goalPath.length > 0
                    ? trace.goalPath.map((goal) => goal.title).join(" / ")
                    : `${trace.projectTitle} / OKR 없음`}
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      <main className="space-y-4">
        {captureQueue ? (
          <CaptureReviewInbox
            queue={captureQueue}
            pendingDraftId={pendingCaptureDraftId}
            onPromoteDraft={onPromoteCaptureDraft}
            onFailDraft={onFailCaptureDraft}
            onReviseDraft={onReviseCaptureDraft}
            onTransitionDraft={onTransitionCaptureDraft}
          />
        ) : null}
        <div className="rounded-lg border border-border bg-card/80 p-3">
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((filter) => (
              <button
                key={filter.key}
                type="button"
                aria-label={filter.label}
                aria-pressed={activeFilters.has(filter.key)}
                className={`h-8 rounded-md border px-3 text-xs font-medium ${
                  activeFilters.has(filter.key)
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground"
                }`}
                onClick={() => toggleFilter(filter.key)}
              >
                {filter.label}
              </button>
            ))}
            <input
              aria-label="업무 카드 검색"
              className="h-8 min-w-48 flex-1 rounded-md border border-border bg-background px-3 text-sm"
              value={searchText}
              onInput={(event) => setSearchText(event.currentTarget.value)}
            />
            <select
              aria-label="정렬"
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
              value={sortMode}
              onChange={(event) => setSortMode(event.currentTarget.value as SortKey)}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {viewCards.length === 0 && hasActiveViewControl ? (
            <p className="mt-2 text-xs text-muted-foreground">
              조건에 맞는 카드가 없습니다. 필터나 검색어를 줄이면 다른 업무 카드를 볼 수 있습니다.
            </p>
          ) : null}
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {BOARD_LANES.map((laneMeta) => {
            const cards = viewCards.filter((card) => card.lane === laneMeta.key);

            return (
              <section
                key={laneMeta.key}
                aria-label={`${laneMeta.label} lane`}
                className={`rounded-lg border p-4 transition-colors ${
                  dropLane === laneMeta.key
                    ? "border-primary/50 bg-primary/5"
                    : "border-border bg-card/80"
                }`}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (draggingTodoIssueId) setDropLane(laneMeta.key);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDropLane((current) => (current === laneMeta.key ? null : current));
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const todoIssueId = event.dataTransfer.getData("text/plain") || draggingTodoIssueId;
                  setDraggingTodoIssueId(null);
                  setDropLane(null);
                  if (todoIssueId) moveCard(todoIssueId, laneMeta.key);
                }}
              >
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">{laneMeta.label}</h3>
                    <p className="text-xs text-muted-foreground">{cards.length}개</p>
                  </div>
                </div>

                <div className="space-y-3">
                  {cards.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                      {hasActiveViewControl ? `${laneMeta.label}에 조건과 맞는 카드가 없습니다.` : "아직 카드가 없습니다."}
                    </div>
                  ) : null}

                  {cards.map((card) => {
                    const draft = drafts[card.todoIssueId] ?? {
                      lane: card.lane,
                      bucketLabel: card.bucketLabel,
                      progressPercent: card.progressPercent,
                      note: card.note,
                    };
                    const quickDraft = quickDrafts[card.todoIssueId] ?? buildQuickDraft(card);
                    const isEditing = editingTodoIssueId === card.todoIssueId;

                    return (
                      <article
                        key={card.todoIssueId}
                        className={`rounded-lg border border-border bg-background p-3 transition-shadow ${
                          draggingTodoIssueId === card.todoIssueId ? "opacity-60 ring-1 ring-primary/30" : "hover:shadow-sm"
                        }`}
                        draggable
                        aria-grabbed={draggingTodoIssueId === card.todoIssueId}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", card.todoIssueId);
                          setDraggingTodoIssueId(card.todoIssueId);
                        }}
                        onDragEnd={() => {
                          setDraggingTodoIssueId(null);
                          setDropLane(null);
                        }}
                      >
                        <div className="space-y-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-sm font-medium">{card.todoTitle}</div>
                              <div className="text-xs text-muted-foreground">{card.taskTitle}</div>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`${card.todoIssueId}-card-edit`}
                              onClick={() => setEditingTodoIssueId((current) => (current === card.todoIssueId ? null : card.todoIssueId))}
                            >
                              편집
                            </Button>
                          </div>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-1">
                          <StatusPill label="Task" tone="muted" />
                          <StatusPill label={`담당 ${card.assigneeDisplayName ?? card.assigneeUserId}`} tone="muted" />
                          <StatusPill label={card.deliverableTitle ?? `${card.deliverableCount} 산출물`} tone={card.deliverableCount > 0 ? "ok" : "warn"} />
                          <StatusPill label={okrLabel(card, traceGoalByTodoId) || (card.okrContextStatus === "connected" ? "OKR 연결" : "OKR 없음")} tone={card.okrContextStatus === "connected" ? "ok" : "warn"} />
                          <StatusPill label={card.basePriceTotal > 0 ? `${formatGold(card.basePriceTotal)} Gold` : "가격 미정"} tone={card.basePriceTotal > 0 ? "ok" : "muted"} />
                          <StatusPill label={qualityLabel(card.qualityStatus, card.qualityLabel)} tone={card.qualityStatus === "reviewed" ? "ok" : card.qualityStatus === "needs_work" ? "warn" : "muted"} />
                          {card.submittedDeliverableCount > 0 ? (
                            <StatusPill label={`${card.submittedDeliverableCount} 제출`} tone="ok" />
                          ) : null}
                          {card.status === "blocked" ? <StatusPill label="막힘" tone="warn" /> : null}
                        </div>

                        <CardEvidenceSummary card={card} traceGoal={traceGoalByTodoId.get(card.todoIssueId) ?? ""} />

                        {renderFieldFeedback(card.todoIssueId, pendingTodoIssueId, failedTodoIssueId)}

                        {isEditing ? (
                          <div className="mt-3 space-y-2 border-t border-border pt-3">
                            <FieldLabel htmlFor={`${card.todoIssueId}-title`} label="제목" />
                            <input
                              id={`${card.todoIssueId}-title`}
                              aria-label={`${card.todoIssueId}-title`}
                              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                              value={quickDraft.title}
                              onInput={(event) => updateQuickDraft(card.todoIssueId, { title: event.currentTarget.value })}
                            />

                            <FieldLabel htmlFor={`${card.todoIssueId}-lane`} label="리스트" />
                            <select
                              id={`${card.todoIssueId}-lane`}
                              aria-label={`${card.todoIssueId}-lane-edit`}
                              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                              value={draft.lane}
                              onChange={(event) => {
                                const nextLane = event.target.value as Rt2DailyLane;
                                setDrafts((current) => ({
                                  ...current,
                                  [card.todoIssueId]: { ...draft, lane: nextLane },
                                }));
                              }}
                            >
                              {BOARD_LANES.map((option) => (
                                <option key={option.key} value={option.key}>
                                  {option.label}
                                </option>
                              ))}
                            </select>

                            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_7rem]">
                              <div>
                                <FieldLabel htmlFor={`${card.todoIssueId}-deliverable`} label="산출물" />
                                <input
                                  id={`${card.todoIssueId}-deliverable`}
                                  aria-label={`${card.todoIssueId}-deliverable`}
                                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                                  value={quickDraft.deliverableTitle}
                                  onInput={(event) => updateQuickDraft(card.todoIssueId, { deliverableTitle: event.currentTarget.value })}
                                />
                              </div>
                              <div>
                                <FieldLabel htmlFor={`${card.todoIssueId}-base-price`} label="기준가" />
                                <input
                                  id={`${card.todoIssueId}-base-price`}
                                  aria-label={`${card.todoIssueId}-base-price`}
                                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                                  type="number"
                                  min={0}
                                  value={quickDraft.basePrice}
                                  onInput={(event) => updateQuickDraft(card.todoIssueId, { basePrice: Number(event.currentTarget.value) })}
                                />
                              </div>
                            </div>

                            <div className="grid gap-2 md:grid-cols-2">
                              <div>
                                <FieldLabel htmlFor={`${card.todoIssueId}-quality`} label="품질" />
                                <select
                                  id={`${card.todoIssueId}-quality`}
                                  aria-label={`${card.todoIssueId}-quality`}
                                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                                  value={quickDraft.qualityStatus}
                                  onChange={(event) => updateQuickDraft(card.todoIssueId, { qualityStatus: event.currentTarget.value as Rt2BoardQualityStatus })}
                                >
                                  <option value="none">없음</option>
                                  <option value="pending_review">검토 대기</option>
                                  <option value="reviewed">검토됨</option>
                                  <option value="needs_work">수정 필요</option>
                                </select>
                              </div>
                              <div>
                                <FieldLabel htmlFor={`${card.todoIssueId}-okr`} label="OKR" />
                                <input
                                  id={`${card.todoIssueId}-okr`}
                                  aria-label={`${card.todoIssueId}-okr`}
                                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                                  value={quickDraft.goalId}
                                  onInput={(event) => updateQuickDraft(card.todoIssueId, { goalId: event.currentTarget.value })}
                                />
                              </div>
                            </div>

                            <div className="grid grid-cols-3 gap-2">
                              <SaveFieldButton label="제목" onClick={() => void saveQuickField(card, "title")} />
                              <SaveFieldButton label="리스트" onClick={() => saveQuickField(card, "lane")} />
                              <SaveFieldButton label="산출물" onClick={() => void saveQuickField(card, "deliverable")} />
                              <SaveFieldButton label="기준가" onClick={() => void saveQuickField(card, "basePrice")} />
                              <SaveFieldButton label="품질" onClick={() => void saveQuickField(card, "quality")} />
                              <SaveFieldButton label="OKR" onClick={() => void saveQuickField(card, "okr")} />
                            </div>
                          </div>
                        ) : null}

                        <div className="mt-3 space-y-2">
                          <label className="block text-xs text-muted-foreground" htmlFor={`${card.todoIssueId}-compact-lane`}>
                            위치
                          </label>
                          <select
                            id={`${card.todoIssueId}-compact-lane`}
                            aria-label={`${card.todoIssueId}-lane`}
                            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                            value={draft.lane}
                            onChange={(event) => {
                              const nextLane = event.target.value as Rt2DailyLane;
                              setDrafts((current) => ({
                                ...current,
                                [card.todoIssueId]: { ...draft, lane: nextLane },
                              }));
                            }}
                          >
                            {BOARD_LANES.map((option) => (
                              <option key={option.key} value={option.key}>
                                {option.label}
                              </option>
                            ))}
                          </select>

                          <label className="block text-xs text-muted-foreground" htmlFor={`${card.todoIssueId}-bucket`}>
                            분류
                          </label>
                          <select
                            id={`${card.todoIssueId}-bucket`}
                            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                            value={draft.bucketLabel ?? ""}
                            onChange={(event) => {
                              const nextBucket = event.target.value.trim() || null;
                              setDrafts((current) => ({
                                ...current,
                                [card.todoIssueId]: { ...draft, bucketLabel: nextBucket },
                              }));
                            }}
                          >
                            <option value="">분류 없음</option>
                            {BUCKET_OPTIONS.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>

                          <label className="block text-xs text-muted-foreground" htmlFor={`${card.todoIssueId}-progress`}>
                            진행률 {draft.progressPercent}%
                          </label>
                          <input
                            id={`${card.todoIssueId}-progress`}
                            className="w-full"
                            type="range"
                            min={0}
                            max={100}
                            value={draft.progressPercent}
                            onChange={(event) => {
                              const nextProgress = Number(event.target.value);
                              setDrafts((current) => ({
                                ...current,
                                [card.todoIssueId]: { ...draft, progressPercent: nextProgress },
                              }));
                            }}
                          />

                          <textarea
                            className="min-h-20 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                            value={draft.note ?? ""}
                            onChange={(event) => {
                              const nextNote = event.target.value || null;
                              setDrafts((current) => ({
                                ...current,
                                [card.todoIssueId]: { ...draft, note: nextNote },
                              }));
                            }}
                          />
                        </div>

                        <div className="mt-3 flex items-center justify-between gap-3">
                          <span className="text-[11px] text-muted-foreground">
                            {pendingTodoIssueId === card.todoIssueId
                              ? "저장중"
                              : failedTodoIssueId === card.todoIssueId
                                ? "저장 실패"
                                : "저장됨"}
                          </span>
                          <Button size="sm" variant="outline" aria-label={`${card.todoIssueId}-save`} onClick={() => saveCard(card.todoIssueId, draft)}>
                            저장
                          </Button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </main>

      <SupportEvidenceRail board={board} />
    </div>
  );
}

function SupportEvidenceRail({ board }: { board: Rt2DailyBoardData }) {
  const cardsWithKnowledge = board.cards.filter((card) => card.note || card.deliverableCount > 0 || card.gapFlags.length > 0).length;
  const graphLinks = new Set([
    ...board.cockpit.traceRows.map((trace) => trace.taskIssueId),
    ...board.cockpit.traceRows.map((trace) => trace.todoIssueId),
  ]).size;
  const economyCards = board.cards.filter((card) => card.basePriceTotal > 0 || card.submittedDeliverableCount > 0).length;
  const qualityIssues = board.cards.filter(isQualityIssue).length;

  return (
    <aside className="space-y-4 rounded-lg border border-border bg-card/80 p-4" aria-label="보조 근거">
      <div>
        <h3 className="text-sm font-semibold">보조 근거</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Jarvis, 지식, 그래프, 경제 신호를 일일 업무 보드 맥락 안에서 확인합니다.
        </p>
      </div>

      <EvidenceSection title="Jarvis 추천">
        {board.cockpit.aiSummary.length === 0 ? (
          <EvidenceEmpty>오늘 카드에 연결된 Jarvis 추천이 없습니다.</EvidenceEmpty>
        ) : (
          board.cockpit.aiSummary.slice(0, 3).map((line) => <EvidenceLine key={line}>{line}</EvidenceLine>)
        )}
        {qualityIssues > 0 ? <EvidenceLine tone="warn">품질 이슈 {qualityIssues}개는 먼저 검토하는 것이 좋습니다.</EvidenceLine> : null}
      </EvidenceSection>

      <EvidenceSection title="지식 근거">
        <EvidenceLine>오늘 위키와 카드 메모에 연결된 업무 {cardsWithKnowledge}개</EvidenceLine>
        {board.cockpit.gapFlags.length === 0 ? (
          <EvidenceLine tone="ok">현재 보완 필요 근거가 없습니다.</EvidenceLine>
        ) : (
          board.cockpit.gapFlags.slice(0, 3).map((gap) => (
            <EvidenceLine key={`${gap.todoIssueId}-${gap.kind}`} tone="warn">
              {gap.label}
            </EvidenceLine>
          ))
        )}
      </EvidenceSection>

      <EvidenceSection title="그래프 연결">
        <EvidenceLine>OKR/KPI 추적 노드 {board.cockpit.traceRows.length}개</EvidenceLine>
        <EvidenceLine>업무/To-Do 연결 {graphLinks}개</EvidenceLine>
      </EvidenceSection>

      <EvidenceSection title="경제 근거">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Metric label="Gold" value={board.cockpit.summary.goldImpact} />
          <Metric label="XP" value={board.cockpit.summary.xpImpact} />
          <Metric label="제출 산출물" value={board.cockpit.summary.deliverablesSubmitted} />
          <Metric label="품질 상태" value={qualityLabel(board.cockpit.summary.qualityStatus)} />
        </div>
        <EvidenceLine>가격 또는 제출 근거가 있는 카드 {economyCards}개</EvidenceLine>
      </EvidenceSection>
    </aside>
  );
}

function CardEvidenceSummary({ card, traceGoal }: { card: Rt2DailyReportCard; traceGoal: string }) {
  const wikiText = card.note ? "메모 근거 있음" : card.deliverableCount > 0 ? "산출물 근거 있음" : "지식 근거 필요";
  const graphText = traceGoal || card.directGoalTitle || card.inheritedGoalTitle || "OKR 연결 필요";
  const economyText = card.basePriceTotal > 0
    ? `${formatGold(card.basePriceTotal)} Gold 근거`
    : "가격 근거 필요";

  return (
    <div className="mt-3 grid gap-1 rounded-md border border-border bg-muted/30 px-2 py-2 text-[11px] text-muted-foreground" aria-label={`${card.todoIssueId}-support-evidence`}>
      <div><span className="font-medium text-foreground">Jarvis 추천</span> {card.gapFlags.length > 0 ? "보완 필요 항목 확인" : "현재 흐름 유지"}</div>
      <div><span className="font-medium text-foreground">지식 근거</span> {wikiText}</div>
      <div><span className="font-medium text-foreground">그래프 연결</span> {graphText}</div>
      <div><span className="font-medium text-foreground">경제 근거</span> {economyText} · {qualityLabel(card.qualityStatus, card.qualityLabel)}</div>
    </div>
  );
}

function EvidenceSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function EvidenceLine({ children, tone = "muted" }: { children: ReactNode; tone?: "ok" | "warn" | "muted" }) {
  const toneClass =
    tone === "ok"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-border bg-background text-muted-foreground";
  return <p className={`rounded-md border px-3 py-2 text-sm ${toneClass}`}>{children}</p>;
}

function EvidenceEmpty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">{children}</p>;
}

function cardMatchesFilters(
  card: Rt2DailyReportCard,
  filters: Set<FilterKey>,
  searchText: string,
  board: Rt2DailyBoardData,
  traceGoalByTodoId: Map<string, string>,
) {
  if (filters.has("today") && !(card.reportDateMatchesBoard ?? card.reportDate === board.reportDate)) return false;
  if (filters.has("mine") && !(card.actorMatchesAssignee ?? card.assigneeUserId === board.userId)) return false;
  if (filters.has("missing_deliverable") && !(card.deliverableMissing ?? (card.deliverableCount === 0 || card.gapFlags.includes("missing_deliverable")))) return false;
  if (filters.has("approval_waiting") && !(card.approvalWaiting ?? (card.qualityStatus === "pending_review" || card.qualityStatus === "needs_work"))) return false;
  if (filters.has("quality_issue") && !(card.qualityStatus === "needs_work" || card.status === "blocked")) return false;

  const query = searchText.trim().toLocaleLowerCase();
  if (!query) return true;
  return cardSearchText(card, traceGoalByTodoId).toLocaleLowerCase().includes(query);
}

function CaptureReviewInbox({
  queue,
  pendingDraftId,
  onPromoteDraft,
  onFailDraft,
  onReviseDraft,
  onTransitionDraft,
}: {
  queue: Rt2CaptureQueue;
  pendingDraftId: string | null;
  onPromoteDraft?: (draftId: string) => void;
  onFailDraft?: (draftId: string, reason: string) => void;
  onReviseDraft?: Parameters<typeof Rt2DailyBoard>[0]["onReviseCaptureDraft"];
  onTransitionDraft?: Parameters<typeof Rt2DailyBoard>[0]["onTransitionCaptureDraft"];
}) {
  const activeDrafts = queue.drafts.filter((draft) =>
    draft.status === "review_required"
    || draft.status === "revised"
    || draft.status === "on_hold"
    || draft.status === "revision_requested"
    || draft.status === "rejected"
    || draft.status === "duplicate"
    || draft.status === "permission_blocked"
    || draft.status === "failed",
  );

  return (
    <section className="rounded-lg border border-border bg-card/80 p-4" aria-label="One-Liner 보드 검수함">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">One-Liner 보드 검수함</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            새 업무 기록과 모바일/native 입력을 보드에 올리기 전에 중복과 출처 근거를 확인합니다.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-md border border-border px-2 py-1">검수 필요 {queue.summary.reviewRequired}</span>
          <span className="rounded-md border border-border px-2 py-1">중복 의심 {queue.summary.duplicate}</span>
          <span className="rounded-md border border-border px-2 py-1">차단 {queue.summary.permissionBlocked}</span>
        </div>
      </div>

      {activeDrafts.length === 0 ? (
        <p className="mt-3 rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
          검수할 One-Liner 초안이 없습니다.
        </p>
      ) : (
        <div className="mt-3 grid gap-3">
          {activeDrafts.slice(0, 6).map((draft) => (
            <CaptureDraftCard
              key={draft.id}
              draft={draft}
              pending={pendingDraftId === draft.id}
              onPromoteDraft={onPromoteDraft}
              onFailDraft={onFailDraft}
              onReviseDraft={onReviseDraft}
              onTransitionDraft={onTransitionDraft}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CaptureDraftCard({
  draft,
  pending,
  onPromoteDraft,
  onFailDraft,
  onReviseDraft,
  onTransitionDraft,
}: {
  draft: Rt2CaptureDraftSummary;
  pending: boolean;
  onPromoteDraft?: (draftId: string) => void;
  onFailDraft?: (draftId: string, reason: string) => void;
  onReviseDraft?: Parameters<typeof Rt2DailyBoard>[0]["onReviseCaptureDraft"];
  onTransitionDraft?: Parameters<typeof Rt2DailyBoard>[0]["onTransitionCaptureDraft"];
}) {
  const parsed = normalizeParsedDraft(draft.latestRevision?.snapshot ?? draft.parsedDraft);
  const sourceEvidence = draft.sourceEvidence;
  const [isReopen, setIsReopen] = useState(false);
  const [revisionDraft, setRevisionDraft] = useState(() => ({
    taskTitle: parsed.taskTitle || draft.rawText,
    todoTitle: parsed.todoTitle,
    deliverableTitle: parsed.deliverableTitle,
    basePrice: parsed.basePrice ?? 0,
    qualityHint: parsed.qualityHint ?? "",
    okrCandidate: parsed.okrCandidate ?? "",
    operatorNote: parsed.operatorNote ?? "",
    changeSummary: "보드 검수에서 초안 수정",
  }));
  const canPromote = draft.status === "review_required" || draft.status === "revised" || draft.status === "revision_requested";
  const latestRevision = draft.latestRevision;

  function transition(action: "hold" | "reject" | "request_revision", reason: string) {
    if (onTransitionDraft) {
      onTransitionDraft(draft.id, { action, reason });
      return;
    }
    if (action === "hold") {
      onFailDraft?.(draft.id, reason);
    }
  }

  return (
    <article className="rounded-md border border-border bg-background px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium">{captureStatusLabel(draft.status)}</span>
            <span className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">{captureSourceLabel(draft.source)}</span>
            {draft.duplicateWarning ? (
              <span className="rounded-md border border-amber-300/70 px-2 py-1 text-xs text-amber-700 dark:text-amber-200">
                중복 의심
              </span>
            ) : null}
            {latestRevision ? (
              <span className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
                수정 이력 v{latestRevision.revisionNumber}
              </span>
            ) : null}
          </div>
          <h4 className="mt-2 truncate text-sm font-medium">{parsed.taskTitle || draft.rawText}</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            산출물 {parsed.deliverableTitle || "검토 필요"} · 기준가 {parsed.basePrice == null ? "검토 필요" : `${parsed.basePrice.toLocaleString()} Gold`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={pending || !canPromote || !onPromoteDraft}
            onClick={() => onPromoteDraft?.(draft.id)}
          >
            {pending ? "승인 중..." : "Task로 승인"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !onReviseDraft}
            onClick={() => setIsReopen((current) => !current)}
          >
            다시 열기
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || (!onFailDraft && !onTransitionDraft)}
            onClick={() => transition("hold", draft.status === "duplicate" ? "중복 초안으로 보류" : "보드 검수에서 보류")}
          >
            보류
          </Button>
        </div>
      </div>

      {isReopen ? (
        <div className="mt-3 space-y-2 rounded-md border border-border bg-muted/20 p-3" aria-label={`${draft.id}-revision-editor`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h5 className="text-xs font-semibold">초안 수정</h5>
            <span className="text-[11px] text-muted-foreground">
              {latestRevision ? `현재 수정 이력 v${latestRevision.revisionNumber}` : "수정 이력 없음"}
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">제목</span>
              <input
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                value={revisionDraft.taskTitle}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setRevisionDraft((current) => ({ ...current, taskTitle: value }));
                }}
              />
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">To-Do</span>
              <input
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                value={revisionDraft.todoTitle}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setRevisionDraft((current) => ({ ...current, todoTitle: value }));
                }}
              />
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">산출물</span>
              <input
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                value={revisionDraft.deliverableTitle}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setRevisionDraft((current) => ({ ...current, deliverableTitle: value }));
                }}
              />
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">기준가</span>
              <input
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                type="number"
                min={0}
                value={revisionDraft.basePrice}
                onInput={(event) => {
                  const value = Number(event.currentTarget.value);
                  setRevisionDraft((current) => ({ ...current, basePrice: value }));
                }}
              />
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">품질 힌트</span>
              <input
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                value={revisionDraft.qualityHint}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setRevisionDraft((current) => ({ ...current, qualityHint: value }));
                }}
              />
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">OKR/KPI 후보</span>
              <input
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                value={revisionDraft.okrCandidate}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setRevisionDraft((current) => ({ ...current, okrCandidate: value }));
                }}
              />
            </label>
          </div>
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">운영자 메모</span>
            <textarea
              className="min-h-16 rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={revisionDraft.operatorNote}
              onInput={(event) => {
                const value = event.currentTarget.value;
                setRevisionDraft((current) => ({ ...current, operatorNote: value }));
              }}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!onReviseDraft || !revisionDraft.taskTitle.trim() || !revisionDraft.deliverableTitle.trim()}
              onClick={() => onReviseDraft?.(draft.id, {
                snapshot: {
                  taskTitle: revisionDraft.taskTitle,
                  todoTitle: revisionDraft.todoTitle,
                  deliverableTitle: revisionDraft.deliverableTitle,
                  deliverableType: parsed.deliverableType,
                  basePrice: Math.max(0, Math.trunc(revisionDraft.basePrice || 0)),
                  taskMode: parsed.taskMode === "collab" ? "collab" : "solo",
                  capacity: parsed.capacity || 1,
                  qualityHint: revisionDraft.qualityHint || null,
                  okrCandidate: revisionDraft.okrCandidate || null,
                  operatorNote: revisionDraft.operatorNote || null,
                },
                changeSummary: revisionDraft.changeSummary,
              })}
            >
              수정 저장
            </Button>
            <Button size="sm" variant="outline" disabled={!onTransitionDraft} onClick={() => transition("request_revision", "추가 재검토 요청")}>
              재검토 요청
            </Button>
            <Button size="sm" variant="outline" disabled={!onTransitionDraft} onClick={() => transition("reject", "보드 검수에서 반려")}>
              반려
            </Button>
          </div>
          {latestRevision?.changeSummary ? (
            <p className="text-xs text-muted-foreground">최근 수정: {latestRevision.changeSummary}</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div className="rounded-md bg-muted/40 px-2 py-2">
          <span className="font-medium text-foreground">업무 유형</span> {parsed.taskMode || "solo"} · 처리 용량 {parsed.capacity || 1}
        </div>
        <div className="rounded-md bg-muted/40 px-2 py-2">
          <span className="font-medium text-foreground">To-Do</span> {parsed.todoTitle || "Task 제목과 동일"}
        </div>
        <div className="rounded-md bg-muted/40 px-2 py-2">
          <span className="font-medium text-foreground">출처 근거</span>{" "}
          {sourceEvidence?.eventId ?? draft.channel ?? draft.externalUserId ?? "보드 입력"}
        </div>
        <div className="rounded-md bg-muted/40 px-2 py-2">
          <span className="font-medium text-foreground">권한/서명</span>{" "}
          {draft.permissionStatus} · {sourceEvidence?.signingStatus ?? "unsigned"}
        </div>
      </div>

      {draft.duplicateWarning ? (
        <p className="mt-2 rounded-md border border-amber-300/70 bg-amber-50 px-2 py-2 text-xs text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-100">
          {draft.duplicateWarning}
        </p>
      ) : null}
      {draft.semanticContext.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          관련 지식 근거 {draft.semanticContext.length}개가 연결되어 있습니다.
        </p>
      ) : null}
    </article>
  );
}

function normalizeParsedDraft(value: Record<string, unknown>) {
  return {
    taskTitle: typeof value.taskTitle === "string" ? value.taskTitle : "",
    todoTitle: typeof value.todoTitle === "string" ? value.todoTitle : "",
    deliverableTitle: typeof value.deliverableTitle === "string" ? value.deliverableTitle : "",
    basePrice: typeof value.basePrice === "number" ? value.basePrice : null,
    taskMode: typeof value.taskMode === "string" ? value.taskMode : "solo",
    capacity: typeof value.capacity === "number" ? value.capacity : 1,
    deliverableType: value.deliverableType === "artifact" ? "artifact" as const : "document" as const,
    qualityHint: typeof value.qualityHint === "string" ? value.qualityHint : "",
    okrCandidate: typeof value.okrCandidate === "string" ? value.okrCandidate : "",
    operatorNote: typeof value.operatorNote === "string" ? value.operatorNote : "",
  };
}

function captureStatusLabel(status: Rt2CaptureDraftSummary["status"]) {
  switch (status) {
    case "review_required":
      return "검수 필요";
    case "revised":
      return "수정됨";
    case "on_hold":
      return "보류됨";
    case "revision_requested":
      return "재검토 요청";
    case "rejected":
      return "반려됨";
    case "duplicate":
      return "중복 의심";
    case "permission_blocked":
      return "권한 확인 필요";
    case "failed":
      return "처리 실패";
    case "promoted":
      return "보드에 추가됨";
    case "discarded":
      return "보류됨";
  }
}

function captureSourceLabel(source: Rt2CaptureDraftSummary["source"]) {
  switch (source) {
    case "web":
      return "Web";
    case "floating":
      return "빠른 기록";
    case "voice":
      return "음성";
    case "mobile":
      return "Mobile";
    case "native":
      return "Native";
    case "slack":
      return "Slack";
    case "teams":
      return "Teams";
    case "webhook":
      return "Webhook";
  }
}

function cardSearchText(card: Rt2DailyReportCard, traceGoalByTodoId: Map<string, string>) {
  return [
    card.searchText,
    ...(card.searchableLabels ?? []),
    card.todoTitle,
    card.taskTitle,
    card.assigneeUserId,
    card.assigneeDisplayName,
    card.deliverableTitle,
    qualityLabel(card.qualityStatus, card.qualityLabel),
    card.directGoalTitle,
    card.inheritedGoalTitle,
    traceGoalByTodoId.get(card.todoIssueId),
    card.status,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function sortCards(cards: Rt2DailyReportCard[], sortMode: SortKey) {
  const copy = [...cards];
  if (sortMode === "recent") {
    return copy.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }
  if (sortMode === "due_date") {
    return copy.sort((a, b) => dueTime(a) - dueTime(b));
  }
  if (sortMode === "needs_work") {
    return copy.sort((a, b) => Number(b.gapFlags.length > 0) - Number(a.gapFlags.length > 0));
  }
  if (sortMode === "quality_issue") {
    return copy.sort((a, b) => Number(isQualityIssue(b)) - Number(isQualityIssue(a)));
  }
  if (sortMode === "gold_desc") {
    return copy.sort((a, b) => b.basePriceTotal - a.basePriceTotal);
  }
  return copy;
}

function dueTime(card: Rt2DailyReportCard) {
  return card.dueDate ? new Date(card.dueDate).getTime() : Number.POSITIVE_INFINITY;
}

function isQualityIssue(card: Rt2DailyReportCard) {
  return card.qualityStatus === "needs_work" || card.status === "blocked";
}

function renderFieldFeedback(todoIssueId: string, pendingTodoIssueId: string | null, failedTodoIssueId: string | null) {
  const fields: Array<{ field: QuickField; label: string; failure?: string }> = [
    { field: "title", label: "제목" },
    { field: "lane", label: "리스트" },
    { field: "deliverable", label: "산출물" },
    { field: "basePrice", label: "기준가" },
    { field: "quality", label: "품질" },
    { field: "okr", label: "OKR", failure: "OKR 연결을 저장하지 못했습니다. 다시 시도해 주세요." },
  ];
  const state = pendingTodoIssueId === todoIssueId ? "저장중" : failedTodoIssueId === todoIssueId ? "저장 실패" : "저장됨";
  if (state === "저장됨") return null;

  return (
    <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
      {fields.map((item) => (
        <div key={item.field} className={state === "저장 실패" ? "text-destructive" : ""}>
          {item.label} {state}
          {state === "저장 실패" ? " · 다시 시도" : ""}
          {state === "저장 실패" && item.failure ? <div>{item.failure}</div> : null}
        </div>
      ))}
    </div>
  );
}

function SaveFieldButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick}>
      {label} 저장
    </Button>
  );
}

function FieldLabel({ htmlFor, label }: { htmlFor: string; label: string }) {
  return (
    <label className="block text-xs text-muted-foreground" htmlFor={htmlFor}>
      {label}
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold">{value}</div>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: "ok" | "warn" | "muted" }) {
  const className =
    tone === "ok"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-border bg-muted text-muted-foreground";
  return <span className={`rounded-md border px-2 py-0.5 text-[11px] ${className}`}>{label}</span>;
}

function okrLabel(card: Rt2DailyReportCard, traceGoalByTodoId: Map<string, string>) {
  return card.directGoalTitle ?? card.inheritedGoalTitle ?? traceGoalByTodoId.get(card.todoIssueId) ?? "";
}

function qualityLabel(value: Rt2BoardQualityStatus | "none" | "pending_review" | "reviewed", fallback?: string) {
  if (fallback) return fallback;
  if (value === "reviewed") return "검토됨";
  if (value === "pending_review") return "검토 대기";
  if (value === "needs_work") return "수정 필요";
  return "없음";
}

function formatGold(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}
