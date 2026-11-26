import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentCommentaryEntry, AgentCommentaryKind } from "@paperclipai/shared";
import { ArrowUpRight, ChevronLeft, ChevronRight, Lightbulb, MessageSquareWarning, Search } from "lucide-react";
import { agentCommentaryApi } from "@/api/agentCommentary";
import { agentsApi } from "@/api/agents";
import { AgentIdentity } from "@/components/AgentIdentity";
import { EmptyState } from "@/components/EmptyState";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useSearchParams } from "@/lib/router";
import { relativeTime } from "@/lib/utils";

const PAGE_SIZE = 50;
const ALL = "all";

function MessageKind({ kind }: { kind: AgentCommentaryKind }) {
  const Icon = kind === "suggestion" ? Lightbulb : MessageSquareWarning;
  return <Badge variant="outline" className="gap-1.5 font-normal"><Icon className="size-3" />{kind === "suggestion" ? "Suggestion" : "Complaint"}</Badge>;
}

function CommentaryRow({ entry, onOpen }: { entry: AgentCommentaryEntry; onOpen: (trigger: HTMLButtonElement) => void }) {
  return (
    <li>
      <button type="button" onClick={(event) => onOpen(event.currentTarget)} aria-label={`Read ${entry.kind} from ${entry.agent.name}`}
        className="group flex w-full flex-col gap-2 rounded-md px-3 py-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:grid md:grid-cols-12 md:items-start md:gap-4">
        <div className="flex items-center justify-between gap-3 md:col-span-2"><AgentIdentity agent={entry.agent} size="sm" /><span className="md:hidden"><MessageKind kind={entry.kind} /></span></div>
        <div className="hidden md:col-span-2 md:block"><MessageKind kind={entry.kind} /></div>
        <div className="flex min-w-0 flex-col gap-2 md:col-span-6">
          <p className="line-clamp-2 whitespace-pre-line break-words text-sm leading-relaxed text-foreground">{entry.preview.trim()}{entry.preview.length >= 280 ? "…" : ""}</p>
          {entry.task && <span className="truncate text-xs text-muted-foreground"><span className="font-mono">{entry.task.identifier ?? "Task"}</span> · {entry.task.title}</span>}
        </div>
        <time dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString()} className="font-mono text-xs text-muted-foreground md:col-span-2 md:text-right">{relativeTime(entry.createdAt)}</time>
      </button>
    </li>
  );
}

function CommentaryDetail({ companyId, id, onClose, triggerRef }: { companyId: string; id: string | null; onClose: () => void; triggerRef: RefObject<HTMLButtonElement | null> }) {
  const detail = useQuery({
    queryKey: queryKeys.agentCommentary.detail(companyId, id),
    queryFn: ({ signal }) => agentCommentaryApi.get(companyId, id!, signal),
    enabled: id !== null,
  });
  const entry = detail.data;
  return (
    <Dialog open={id !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-(--sz-85vh) flex-col gap-5 sm:max-w-3xl" onCloseAutoFocus={(event) => {
        if (triggerRef.current?.isConnected) {
          event.preventDefault();
          triggerRef.current.focus();
        }
      }}>
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle>{entry?.kind === "complaint" ? "Complaint" : entry ? "Suggestion" : "Commentary"}</DialogTitle>
          <DialogDescription>{entry ? `Submitted ${new Date(entry.createdAt).toLocaleString()}` : "Message details and source context."}</DialogDescription>
        </DialogHeader>
        {detail.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading message…</p> : detail.error ? (
          <div role="alert" className="flex flex-col items-start gap-3"><p className="text-sm text-destructive">{detail.error.message}</p><Button variant="outline" size="sm" onClick={() => void detail.refetch()}>Try again</Button></div>
        ) : entry ? <>
          <div className="flex shrink-0 flex-wrap items-center gap-3"><Link to={`/agents/${entry.agent.id}`}><AgentIdentity agent={entry.agent} size="sm" /></Link><MessageKind kind={entry.kind} /></div>
          <div className="min-h-0 overflow-y-auto overscroll-contain break-words pr-2"><MarkdownBody>{entry.body}</MarkdownBody></div>
          <div className="flex shrink-0 flex-wrap items-center gap-4 border-t border-border pt-4 text-sm">
            {entry.task && <Link to={`/issues/${entry.task.identifier ?? entry.task.id}`} className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"><span className="font-mono">{entry.task.identifier ?? "Source task"}</span><ArrowUpRight className="size-3.5" /></Link>}
            <Link to={`/agents/${entry.agent.id}/runs/${entry.runId}`} className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground">View run<ArrowUpRight className="size-3.5" /></Link>
          </div>
        </> : null}
      </DialogContent>
    </Dialog>
  );
}

export function AgentCommentary({ companyId }: { companyId: string }) {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const agentId = params.get("agentId") ?? ALL;
  const kind = params.get("kind") === "suggestion" || params.get("kind") === "complaint" ? params.get("kind") as AgentCommentaryKind : undefined;
  const offset = Math.min(100_000, Math.max(0, Math.floor(Number(params.get("offset")) || 0)));
  const selectedId = params.get("entry") || null;
  const [search, setSearch] = useState(q);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const updateFilters = useCallback((patch: Record<string, string>) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("offset");
      next.delete("entry");
      for (const [key, value] of Object.entries(patch)) {
        if (!value || value === ALL) next.delete(key); else next.set(key, value);
      }
      return next;
    }, { replace: true });
  }, [setParams]);
  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    if (search === q) return;
    const timer = window.setTimeout(() => updateFilters({ q: search }), 250);
    return () => window.clearTimeout(timer);
  }, [search, q, updateFilters]);

  function selectEntry(id: string | null) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (id) next.set("entry", id); else next.delete("entry");
      return next;
    }, { replace: id === null });
  }
  const filters = { q: q || undefined, agentId: agentId === ALL ? undefined : agentId, kind, offset, limit: PAGE_SIZE };
  const messages = useQuery({ queryKey: queryKeys.agentCommentary.list(companyId, filters), queryFn: ({ signal }) => agentCommentaryApi.list(companyId, filters, signal) });
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
  const hasFilters = Boolean(q || agentId !== ALL || kind);
  const clearFilters = () => updateFilters({ q: "", agentId: "", kind: "" });

  return (
    <section className="flex flex-col gap-5" aria-label="Commentary">
      <div className="flex flex-col gap-1"><h2 className="text-lg font-semibold">Commentary</h2><p className="text-sm text-muted-foreground">Suggestions and complaints from your agents.</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-sm"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search commentary" placeholder="Search messages…" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" /></div>
        <Select value={agentId} onValueChange={(value) => updateFilters({ agentId: value })}><SelectTrigger aria-label="Filter by agent" className="min-w-40"><SelectValue placeholder="All agents" /></SelectTrigger><SelectContent><SelectItem value={ALL}>All agents</SelectItem>{agents.data?.map((agent) => <SelectItem key={agent.id} value={agent.id}><AgentIdentity agent={agent} size="xs" /></SelectItem>)}</SelectContent></Select>
        <Select value={kind ?? ALL} onValueChange={(value) => updateFilters({ kind: value })}><SelectTrigger aria-label="Filter by message type" className="min-w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={ALL}>All types</SelectItem><SelectItem value="suggestion">Suggestions</SelectItem><SelectItem value="complaint">Complaints</SelectItem></SelectContent></Select>
        {hasFilters && <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button>}
      </div>
      {agents.error && <p role="alert" className="text-sm text-destructive">Could not load agent filters. <button type="button" className="underline" onClick={() => void agents.refetch()}>Try again</button></p>}
      {messages.isPending ? <p role="status" className="py-12 text-center text-sm text-muted-foreground">Loading commentary…</p> : messages.error ? (
        <div role="alert" className="flex flex-col items-center gap-3 py-12"><p className="text-sm text-destructive">{messages.error.message}</p><Button variant="outline" size="sm" onClick={() => void messages.refetch()}>Try again</Button></div>
      ) : messages.data?.items.length === 0 ? (
        <EmptyState icon={Lightbulb} message={offset > 0 ? "No messages on this page." : hasFilters ? "No messages match these filters." : "No agent commentary yet."} description={offset > 0 ? "Return to the newest messages." : hasFilters ? "Try another agent, message type, or search." : "Suggestions and complaints will appear here when agents submit them."} action={offset > 0 ? "Back to latest" : hasFilters ? "Clear filters" : undefined} onAction={offset > 0 ? () => updateFilters({ offset: "" }) : hasFilters ? clearFilters : undefined} hideActionIcon />
      ) : messages.data ? <>
        <div>
          <div aria-hidden="true" className="hidden grid-cols-12 gap-4 border-b border-border px-3 pb-3 text-xs font-medium text-muted-foreground md:grid"><span className="col-span-2">Agent</span><span className="col-span-2">Type</span><span className="col-span-6">Message</span><span className="col-span-2 text-right">Submitted</span></div>
          <ul aria-label="Commentary messages" className="divide-y divide-border">{messages.data.items.map((entry) => <CommentaryRow key={entry.id} entry={entry} onOpen={(trigger) => { triggerRef.current = trigger; selectEntry(entry.id); }} />)}</ul>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <p role="status" className="font-mono text-xs text-muted-foreground">{offset + 1}–{offset + messages.data.items.length} of {messages.data.total} messages</p>
          <div className="flex gap-2"><Button variant="outline" size="sm" aria-label="Previous page" disabled={offset === 0} onClick={() => updateFilters({ offset: String(Math.max(0, offset - PAGE_SIZE)) })}><ChevronLeft className="size-4" />Previous</Button><Button variant="outline" size="sm" aria-label="Next page" disabled={offset + messages.data.items.length >= messages.data.total} onClick={() => updateFilters({ offset: String(offset + PAGE_SIZE) })}>Next<ChevronRight className="size-4" /></Button></div>
        </div>
      </> : null}
      <CommentaryDetail key={companyId} companyId={companyId} id={selectedId} onClose={() => selectEntry(null)} triggerRef={triggerRef} />
    </section>
  );
}
