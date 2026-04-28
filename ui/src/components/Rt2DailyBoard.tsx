import { useEffect, useState } from "react";
import type { Rt2DailyBoard as Rt2DailyBoardData, Rt2DailyLane, UpsertRt2DailyReportCard } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";

const BOARD_LANES: Array<{ key: Rt2DailyLane; label: string }> = [
  { key: "today", label: "오늘 할 일" },
  { key: "support_1", label: "보조창 1" },
  { key: "support_2", label: "보조창 2" },
];

const BUCKET_OPTIONS = ["진행중", "내일 할 일", "아이디어", "미룬일"] as const;

type CardDraft = {
  lane: Rt2DailyLane;
  bucketLabel: string | null;
  progressPercent: number;
  note: string | null;
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

export function Rt2DailyBoard({
  board,
  pendingTodoIssueId,
  onSaveCard,
}: {
  board: Rt2DailyBoardData;
  pendingTodoIssueId: string | null;
  onSaveCard: (todoIssueId: string, data: UpsertRt2DailyReportCard) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, CardDraft>>(() => buildDrafts(board));
  const [draggingTodoIssueId, setDraggingTodoIssueId] = useState<string | null>(null);
  const [dropLane, setDropLane] = useState<Rt2DailyLane | null>(null);

  useEffect(() => {
    setDrafts(buildDrafts(board));
  }, [board]);

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

      <main className="grid gap-4 lg:grid-cols-3">
        {BOARD_LANES.map((laneMeta) => {
          const cards = board.cards.filter((card) => card.lane === laneMeta.key);

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
                  <div className="rounded-xl border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                    아직 카드가 없습니다.
                  </div>
                ) : null}

                {cards.map((card) => {
                  const draft = drafts[card.todoIssueId] ?? {
                    lane: card.lane,
                    bucketLabel: card.bucketLabel,
                    progressPercent: card.progressPercent,
                    note: card.note,
                  };

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
                      <div className="text-sm font-medium">{card.todoTitle}</div>
                      <div className="text-xs text-muted-foreground">{card.taskTitle}</div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1">
                      <StatusPill label={`${card.deliverableCount} 산출물`} tone={card.deliverableCount > 0 ? "ok" : "warn"} />
                      <StatusPill label={card.okrContextStatus === "connected" ? "OKR 연결" : "OKR 없음"} tone={card.okrContextStatus === "connected" ? "ok" : "warn"} />
                      <StatusPill label={card.qualityStatus === "reviewed" ? "검토됨" : card.qualityStatus === "pending_review" ? "검토 대기" : "품질 없음"} tone={card.qualityStatus === "reviewed" ? "ok" : "muted"} />
                    </div>

                    <div className="mt-3 space-y-2">
                      <label
                        className="block text-xs text-muted-foreground"
                        htmlFor={`${card.todoIssueId}-lane`}
                      >
                        위치
                      </label>
                      <select
                        id={`${card.todoIssueId}-lane`}
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

                      <label
                        className="block text-xs text-muted-foreground"
                        htmlFor={`${card.todoIssueId}-bucket`}
                      >
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

                      <label
                        className="block text-xs text-muted-foreground"
                        htmlFor={`${card.todoIssueId}-progress`}
                      >
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
                        {pendingTodoIssueId === card.todoIssueId ? "저장중" : "기억됨"}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${card.todoIssueId}-save`}
                        onClick={() => saveCard(card.todoIssueId, draft)}
                      >
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
      </main>

      <aside className="space-y-4 rounded-lg border border-border bg-card/80 p-4">
        <div>
          <h3 className="text-sm font-semibold">Jarvis 요약</h3>
          <div className="mt-2 space-y-2">
            {board.cockpit.aiSummary.map((line) => (
              <p key={line} className="text-sm">{line}</p>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Metric label="Gold" value={board.cockpit.summary.goldImpact} />
          <Metric label="XP" value={board.cockpit.summary.xpImpact} />
          <Metric label="제출 산출물" value={board.cockpit.summary.deliverablesSubmitted} />
          <Metric label="품질 상태" value={qualityLabel(board.cockpit.summary.qualityStatus)} />
        </div>
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">보완 필요</h4>
          {board.cockpit.gapFlags.length === 0 ? (
            <p className="rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
              현재 표시할 gap이 없습니다.
            </p>
          ) : (
            board.cockpit.gapFlags.map((gap) => (
              <div key={`${gap.todoIssueId}-${gap.kind}`} className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
                {gap.label}
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
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

function qualityLabel(value: "none" | "pending_review" | "reviewed") {
  if (value === "reviewed") return "검토됨";
  if (value === "pending_review") return "검토 대기";
  return "없음";
}
