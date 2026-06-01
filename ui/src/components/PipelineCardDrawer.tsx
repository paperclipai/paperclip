import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, ExternalLink, Trash2, Send } from "lucide-react";
import {
  pipelineApi,
  type PipelineCard,
  type PipelineColumn,
} from "../api/pipeline";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, relativeTime } from "../lib/utils";

const money = (n: number) =>
  !n ? "—" : n >= 1_000_000 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`;

export function PipelineCardDrawer({
  card,
  columns,
  onClose,
  onMove,
}: {
  card: PipelineCard;
  columns: PipelineColumn[];
  onClose: () => void;
  onMove: (stageId: string) => void;
}) {
  const qc = useQueryClient();
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);

  const comments = useQuery({ queryKey: ["agnb", "deal-comments", card.id], queryFn: () => pipelineApi.comments(card.id) });
  const tasks = useQuery({ queryKey: ["agnb", "deal-tasks", card.id], queryFn: () => pipelineApi.tasks(card.id) });
  const activity = useQuery({ queryKey: ["agnb", "deal-activity", card.id], queryFn: () => pipelineApi.activity(card.id) });
  const details = useQuery({ queryKey: ["agnb", "deal-details", card.id], queryFn: () => pipelineApi.details(card.id) });

  const addComment = async () => {
    if (!comment.trim()) return;
    setPosting(true);
    try {
      await pipelineApi.addComment(card.id, comment.trim());
      setComment("");
      qc.invalidateQueries({ queryKey: ["agnb", "deal-comments", card.id] });
      qc.invalidateQueries({ queryKey: ["agnb", "deal-activity", card.id] });
    } catch (e) { alert(e instanceof Error ? e.message : "Failed"); } finally { setPosting(false); }
  };
  const delComment = async (id: string) => {
    await pipelineApi.deleteComment(id).catch(() => {});
    qc.invalidateQueries({ queryKey: ["agnb", "deal-comments", card.id] });
  };
  const toggleTask = async (taskId: string, done: boolean) => {
    await pipelineApi.toggleTask(taskId, done ? "COMPLETED" : "NOT_STARTED").catch(() => {});
    qc.invalidateQueries({ queryKey: ["agnb", "deal-tasks", card.id] });
  };

  const taskList = tasks.data ?? [];
  const doneCount = taskList.filter((t) => t.status === "COMPLETED").length;

  return (
    <div className="fixed inset-0 z-[90] flex justify-end bg-black/40" onClick={onClose}>
      <div className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-border bg-background" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 border-b border-border bg-background p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">in {card.stageLabel}</div>
              <h2 className="text-base font-semibold">{card.name}</h2>
              <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                <span>{card.ownerName}</span>
                {card.amount > 0 && <span className="font-mono">{money(card.amount)}</span>}
                {(card.probability ?? 0) > 0 && <span>{card.probability}%</span>}
              </div>
            </div>
            <button onClick={onClose}><X className="h-4 w-4 text-muted-foreground" /></button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <select
              value=""
              onChange={(e) => e.target.value && onMove(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
            >
              <option value="">Move to…</option>
              {columns.filter((c) => c.label !== card.stageLabel).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <a href={card.hubspotUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ExternalLink className="h-3 w-3" /> HubSpot
            </a>
          </div>
        </div>

        <div className="flex-1 space-y-4 p-4">
          {card.description && <p className="text-sm">{card.description}</p>}
          {card.nextStep && <p className="rounded-md bg-muted/40 p-2 text-xs">⤳ {card.nextStep}</p>}

          {/* Metadata */}
          <Meta rows={[
            ["Priority", card.priority], ["Source", card.source], ["Lifecycle", card.lifecycleStage],
            ["Created", card.createdAt ? relativeTime(card.createdAt) : null],
            ["Close", card.closeAt ? relativeTime(card.closeAt) : null],
            ["Last contacted", card.lastContactedAt ? relativeTime(card.lastContactedAt) : null],
            ["Notes", card.numNotes ? String(card.numNotes) : null],
            ["Lost reason", card.closedLostReason], ["Won reason", card.closedWonReason],
          ]} />

          {card.company?.name && (
            <Section title="Company">
              <div className="text-sm">{card.company.name}{card.company.domain ? ` · ${card.company.domain}` : ""}</div>
              {card.company.industry && <div className="text-xs text-muted-foreground">{card.company.industry}{card.company.employees ? ` · ${card.company.employees} emp` : ""}</div>}
            </Section>
          )}

          {(details.data?.lineItems?.length ?? 0) > 0 && (
            <Section title="Products">
              {details.data!.lineItems.map((li) => <div key={li.id} className="flex justify-between text-sm"><span>{li.name} ×{li.quantity}</span><span className="font-mono">{money(li.amount)}</span></div>)}
            </Section>
          )}
          {(details.data?.quotes?.length ?? 0) > 0 && (
            <Section title="Quotes">
              {details.data!.quotes.map((q) => <div key={q.id} className="flex justify-between text-sm"><span>{q.title}</span><Badge variant="outline">{q.status}</Badge></div>)}
            </Section>
          )}
          {(details.data?.tickets?.length ?? 0) > 0 && (
            <Section title="Tickets">
              {details.data!.tickets.map((t) => <div key={t.id} className="flex justify-between text-sm"><span>{t.subject}</span><span className="text-xs text-muted-foreground">{t.priority ?? t.stage}</span></div>)}
            </Section>
          )}

          {(card.contacts?.length ?? 0) > 0 && (
            <Section title="Members">
              {card.contacts!.map((c) => <div key={c.id} className="text-sm">{c.name}{c.jobtitle ? <span className="text-xs text-muted-foreground"> · {c.jobtitle}</span> : null}{c.email && <a href={`mailto:${c.email}`} className="ml-1 text-xs text-muted-foreground">{c.email}</a>}</div>)}
            </Section>
          )}

          {/* Checklist */}
          {taskList.length > 0 && (
            <Section title={`Checklist (${doneCount}/${taskList.length})`}>
              {taskList.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={t.status === "COMPLETED"} onChange={(e) => toggleTask(t.id, e.target.checked)} />
                  <span className={cn(t.status === "COMPLETED" && "text-muted-foreground line-through")}>{t.subject}</span>
                </label>
              ))}
            </Section>
          )}

          {/* Activity */}
          <Section title={`Activity (${activity.data?.length ?? 0})`}>
            {(activity.data ?? []).map((a) => (
              <div key={a.id} className="text-xs">
                <span className="text-muted-foreground">{a.kind === "move" ? "→" : a.kind === "engagement" ? (a.subkind ?? "•") : "💬"} {a.by} · {relativeTime(a.at)}</span>
                <div className="whitespace-pre-wrap">{a.body}</div>
              </div>
            ))}
            {(activity.data?.length ?? 0) === 0 && <p className="text-xs text-muted-foreground">no activity</p>}
          </Section>

          {/* Comments */}
          <Section title={`Comments (${comments.data?.length ?? 0})`}>
            {(comments.data ?? []).map((c) => (
              <div key={c.id} className="flex items-start justify-between gap-2 text-sm">
                <div><span className="text-xs text-muted-foreground">{c.author} · {relativeTime(c.created_at)}</span><div className="whitespace-pre-wrap">{c.body}</div></div>
                <button onClick={() => delComment(c.id)}><Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" /></button>
              </div>
            ))}
          </Section>
        </div>

        {/* Comment composer */}
        <div className="sticky bottom-0 border-t border-border bg-background p-3">
          <div className="flex gap-2">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addComment(); }}
              placeholder="Add a comment… ⌘↵ to send"
              rows={2}
              className="flex-1 rounded-md border border-border bg-background p-2 text-sm"
            />
            <Button size="sm" onClick={addComment} disabled={posting || !comment.trim()}><Send className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Meta({ rows }: { rows: Array<[string, string | null | undefined]> }) {
  const filled = rows.filter(([, v]) => v);
  if (!filled.length) return null;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
      {filled.map(([k, v]) => <div key={k}><span className="text-muted-foreground">{k}: </span>{v}</div>)}
    </div>
  );
}
