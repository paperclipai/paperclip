import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LabHistoryRecord, SurfaceData } from "../../kit";

const PLAN_BODY = [
  "Three positioning pillars anchor the brand: heritage craft, everyday wear, and a playful retail voice.",
  "Production runs six weeks: two weeks of art direction, three of photography and retouching, one for the deck.",
  "External photographer budget is $18,000, inside the Q4 brand line. Everything else uses the in-house team.",
];
const PLAN_BULLETS = ["Pillar 1 — Heritage craft", "Pillar 2 — Everyday wear", "Pillar 3 — Playful retail voice"];

function HistoryRow({ entry }: { entry: LabHistoryRecord }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{entry.line}</p>
        <p className="truncate text-muted-foreground">{entry.title}</p>
        <p className="text-xs text-muted-foreground">
          {entry.task} · {entry.ageLabel}
        </p>
      </div>
    </div>
  );
}

export function PanelBody({ record, history }: SurfaceData["panel"]) {
  const [tab, setTab] = useState<"review" | "history">("review");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-1">
          {(["review", "history"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={cn(
                "rounded-md px-2.5 py-1 text-sm font-medium capitalize transition-colors",
                tab === value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value}
            </button>
          ))}
        </div>
        <Button type="button" variant="ghost" size="xs">
          Open in {record.task}
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Button>
      </div>

      {tab === "review" ? (
        <>
          <div className="flex-1 space-y-4 px-4 py-4">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">{record.target?.label ?? "Document"}</p>
              <h2 className="mt-1 text-lg font-semibold text-foreground">{record.taskTitle}</h2>
            </div>
            {PLAN_BODY.map((paragraph) => (
              <p key={paragraph} className="text-sm leading-relaxed text-foreground">
                {paragraph}
              </p>
            ))}
            <ul className="flex flex-col gap-1.5 text-sm text-foreground">
              {PLAN_BULLETS.map((bullet) => (
                <li key={bullet} className="flex items-center gap-2">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/60" />
                  {bullet}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border bg-background px-4 py-3">
            <Button type="button" variant="ghost" size="sm">
              Reject
            </Button>
            <Button type="button" variant="outline" size="sm">
              Revise…
            </Button>
            <Button type="button" size="sm">
              Approve
            </Button>
          </div>
        </>
      ) : (
        <div className="flex-1">
          {history.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
