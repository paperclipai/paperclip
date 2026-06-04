import { teamApi, type WorkItem } from "../api/agnbTeam";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "../lib/utils";

/** Shared work-item card with claim/done/reopen/block actions. */
export function AgnbWorkCard({ item, showAssignee, onChange }: { item: WorkItem; showAssignee?: boolean; onChange: () => void }) {
  const act = async (action: string, body?: Record<string, unknown>) => {
    try { await teamApi.workAction(item.id, action, body); onChange(); }
    catch (e) { alert(e instanceof Error ? e.message : "Failed"); }
  };
  const block = () => { const reason = prompt("Block reason:"); if (reason) act("block", { reason }); };

  return (
    <div className="rounded-md border border-border p-2.5 text-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{item.title ?? item.kind}</span>
        <Badge variant="outline">{item.status}</Badge>
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        {item.kind}{item.priority != null ? ` · P${item.priority}` : ""}
        {showAssignee && item.team_members?.name ? ` · ${item.team_members.name}` : ""}
        {item.sla_due_at ? ` · SLA ${relativeTime(item.sla_due_at)}` : ""}
      </div>
      {item.blocked_reason && <p className="mt-1 text-xs text-amber-600">⛔ {item.blocked_reason}</p>}
      <div className="mt-2 flex flex-wrap gap-1">
        {item.status === "queued" && <Button size="sm" variant="outline" onClick={() => act("claim")}>Claim</Button>}
        {item.status !== "done" && <Button size="sm" variant="outline" onClick={() => act("done")}>Done</Button>}
        {item.status === "done" && <Button size="sm" variant="outline" onClick={() => act("reopen")}>Reopen</Button>}
        {item.status !== "blocked" && item.status !== "done" && <Button size="sm" variant="outline" onClick={block}>Block</Button>}
      </div>
    </div>
  );
}
