import { useState } from "react";
import { History } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { activityApi } from "@/api/activity";
import { useCompany } from "@/context/CompanyContext";
import { cn } from "@/lib/utils";

type FilterTab = "all" | "agent" | "issue" | "approval" | "project";

const ACTION_COLORS: Record<string, string> = {
  "created": "var(--success)",
  "updated": "var(--accent)",
  "paused": "var(--warning)",
  "resumed": "var(--success)",
  "terminated": "var(--destructive)",
  "deleted": "var(--destructive)",
  "approved": "var(--success)",
  "rejected": "var(--destructive)",
  "archived": "var(--fg-muted)",
};

function getActionColor(action: string): string {
  for (const [key, color] of Object.entries(ACTION_COLORS)) {
    if (action.includes(key)) return color;
  }
  return "var(--fg-muted)";
}

export function Activity() {
  const [filter, setFilter] = useState<FilterTab>("all");
  const { selectedCompanyId } = useCompany();

  const entityType = filter === "all" ? undefined : filter;

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["activity", selectedCompanyId, entityType],
    queryFn: () => activityApi.list(selectedCompanyId!, entityType),
    enabled: !!selectedCompanyId,
  });

  if (isLoading) return <div className="p-8 text-center" style={{ color: "var(--fg-muted)" }}>Loading...</div>;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Activity</h1>
      </div>

      {/* Filter tabs */}
      <div className="mb-6 flex gap-0 border-b" style={{ borderColor: "var(--border)" }}>
        {(["all", "agent", "issue", "approval", "project"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={cn("relative px-4 py-2 pb-3 text-[13px] capitalize")}
            style={{ color: filter === tab ? "var(--fg)" : "var(--fg-muted)", fontWeight: filter === tab ? 500 : 400, background: "none", border: "none", fontFamily: "var(--font-body)" }}
          >
            {tab === "all" ? "All" : `${tab}s`}
            {filter === tab && <span className="absolute bottom-[-1px] left-0 right-0 h-[2px] rounded-t" style={{ background: "var(--accent)" }} />}
          </button>
        ))}
      </div>

      {/* Activity list */}
      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20" style={{ color: "var(--fg-muted)" }}>
          <History size={48} className="mb-4 opacity-30" />
          <p className="text-[15px] font-medium" style={{ color: "var(--fg-secondary)" }}>No activity yet</p>
          <p className="text-[13px]">Activity will appear here as you create and manage entities.</p>
        </div>
      ) : (
        <div className="rounded-lg border" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
          {entries.map((entry, i) => (
            <div
              key={entry.id}
              className={cn("flex items-center gap-4 px-5 py-3 text-[13px]", i < entries.length - 1 && "border-b")}
              style={{ borderColor: "var(--border-subtle)" }}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: getActionColor(entry.action) }} />
              <span className="w-24 shrink-0 capitalize" style={{ color: "var(--fg-secondary)" }}>
                {entry.action.split(".").pop()?.replace("_", " ")}
              </span>
              <span className="rounded px-1.5 py-0.5 text-[11px] font-medium" style={{ background: "var(--bg-muted)", color: "var(--fg-muted)" }}>
                {entry.entity_type}
              </span>
              <span className="flex-1 truncate" style={{ color: "var(--fg-secondary)" }}>
                {entry.entity_id ? entry.entity_id.substring(0, 8) + "..." : "\u2014"}
              </span>
              <span className="shrink-0 text-[11px]" style={{ color: "var(--fg-muted)" }}>
                {new Date(entry.created_at).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
