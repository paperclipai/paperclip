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

  useEffect(() => {
    setDrafts(buildDrafts(board));
  }, [board]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {BOARD_LANES.map((laneMeta) => {
        const cards = board.cards.filter((card) => card.lane === laneMeta.key);

        return (
          <section key={laneMeta.key} className="rounded-2xl border border-border bg-card/80 p-4">
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
                  <article key={card.todoIssueId} className="rounded-xl border border-border bg-background p-3">
                    <div className="space-y-1">
                      <div className="text-sm font-medium">{card.todoTitle}</div>
                      <div className="text-xs text-muted-foreground">{card.taskTitle}</div>
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
                        onClick={() =>
                          onSaveCard(card.todoIssueId, {
                            projectId: board.projectId,
                            reportDate: board.reportDate,
                            lane: draft.lane,
                            bucketLabel: draft.bucketLabel,
                            progressPercent: draft.progressPercent,
                            note: draft.note,
                          })
                        }
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
    </div>
  );
}
