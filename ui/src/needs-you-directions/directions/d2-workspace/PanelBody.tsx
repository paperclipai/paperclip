import { useState } from "react";
import { cn } from "@/lib/utils";
import type { LabHistoryRecord, SurfaceData } from "../../kit";
import { WorkspaceDetail } from "./WorkspaceParts";

function HistoryRow({ entry }: { entry: LabHistoryRecord }) {
  return (
    <div className="border-b border-border px-5 py-3 text-sm last:border-b-0">
      <p className="font-medium text-foreground">{entry.line}</p>
      <p className="truncate text-muted-foreground">{entry.title}</p>
      <p className="text-xs text-muted-foreground">
        {entry.task} · {entry.ageLabel}
      </p>
    </div>
  );
}

export function PanelBody({ record, history }: SurfaceData["panel"]) {
  const [tab, setTab] = useState<"review" | "history">("review");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
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
      {tab === "review" ? (
        <div className="min-h-0 flex-1">
          <WorkspaceDetail record={record} featured />
        </div>
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
