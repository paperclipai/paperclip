import type { Rt2DailyWikiAnswer, Rt2DailyWikiPage } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";

export function Rt2DailyWikiPanel({
  page,
  answer,
  queryPending,
  onAsk,
}: {
  page: Rt2DailyWikiPage;
  answer: Rt2DailyWikiAnswer | null;
  queryPending: boolean;
  onAsk: (question: "오늘 뭐 했지?") => void;
}) {
  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card/80 p-4">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">오늘 위키</h3>
        {page.shortSummary.map((line) => (
          <p key={line} className="text-sm">
            {line}
          </p>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-background p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">{page.pageKey}</span>
          <Button size="sm" variant="outline" disabled={queryPending} onClick={() => onAsk("오늘 뭐 했지?")}>
            오늘 뭐 했지?
          </Button>
        </div>

        {answer ? (
          <div className="space-y-2">
            {answer.answerLines.map((line) => (
              <p key={line} className="text-sm">
                {line}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">질문 버튼을 눌러 오늘 기록을 다시 확인하세요.</p>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">History</h4>
        {page.history.map((entry) => (
          <div key={entry.actionId} className="rounded-lg border border-border px-3 py-2 text-sm">
            <div>{entry.summary}</div>
            <div className="text-[11px] text-muted-foreground">
              {entry.evidenceTag} · {new Date(entry.occurredAt).toISOString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
