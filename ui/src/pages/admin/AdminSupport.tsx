import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { adminApi, type SupportTicket } from "@/api/admin";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Headphones, RefreshCw, Search, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/* ── Badge helpers ────────────────────────────────────────────── */
function TypeBadge({ type }: { type: SupportTicket["type"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide",
        type === "bug"
          ? "bg-red-500/15 text-red-400"
          : "bg-blue-500/15 text-blue-400",
      )}
    >
      {type === "bug" ? "Bug" : "Feature"}
    </span>
  );
}

function StatusBadge({ status }: { status: SupportTicket["status"] }) {
  const cls =
    status === "open"
      ? "bg-amber-500/15 text-amber-400"
      : status === "in-progress"
        ? "bg-blue-500/15 text-blue-400"
        : "bg-emerald-500/15 text-emerald-400";
  const label = status === "in-progress" ? "In Progress" : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide", cls)}>
      {label}
    </span>
  );
}

/* ── Ticket row with expandable detail ───────────────────────── */
function TicketRow({ ticket }: { ticket: SupportTicket }) {
  const [expanded, setExpanded] = useState(false);
  const [replyText, setReplyText] = useState("");
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const replyMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      adminApi.replyToTicket(id, body),
    onSuccess: () => {
      pushToast({ title: "Reply sent", tone: "success" });
      setReplyText("");
      queryClient.invalidateQueries({ queryKey: ["admin", "support"] });
    },
    onError: () => {
      pushToast({ title: "Failed to send reply", tone: "error" });
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: SupportTicket["status"] }) =>
      adminApi.updateTicketStatus(id, status),
    onSuccess: () => {
      pushToast({ title: "Status updated", tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["admin", "support"] });
    },
    onError: () => {
      pushToast({ title: "Failed to update status", tone: "error" });
    },
  });

  return (
    <>
      <tr
        className="border-b border-border last:border-0 hover:bg-accent/20 transition-colors cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-3 py-3 w-6">
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
        </td>
        <td className="px-3 py-3 text-sm font-medium truncate max-w-[200px]">{ticket.subject}</td>
        <td className="px-3 py-3"><TypeBadge type={ticket.type} /></td>
        <td className="px-3 py-3"><StatusBadge status={ticket.status} /></td>
        <td className="px-3 py-3 text-xs text-muted-foreground">{ticket.userEmail}</td>
        <td className="px-3 py-3 text-xs text-muted-foreground hidden lg:table-cell">{ticket.companyName ?? "—"}</td>
        <td className="px-3 py-3 text-xs text-muted-foreground whitespace-nowrap">
          {new Date(ticket.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-muted/20">
          <td colSpan={7} className="px-4 py-4">
            <div className="space-y-4 max-w-3xl">
              {/* Full body */}
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-1.5">Description</h4>
                <p className="text-sm text-foreground whitespace-pre-wrap">{ticket.body}</p>
              </div>

              {/* Comment thread */}
              {ticket.comments && ticket.comments.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground mb-2">Thread</h4>
                  <div className="space-y-2">
                    {ticket.comments.map((c) => (
                      <div
                        key={c.id}
                        className={cn(
                          "rounded-lg border p-3 text-sm",
                          c.isAdmin
                            ? "border-primary/20 bg-primary/5"
                            : "border-border bg-background",
                        )}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-medium">{c.authorName ?? c.authorEmail}</span>
                          {c.isAdmin && (
                            <span className="text-[10px] bg-primary/15 text-primary px-1.5 py-0.5 rounded font-semibold">Admin</span>
                          )}
                          <span className="ml-auto text-xs text-muted-foreground">
                            {new Date(c.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        <p className="text-muted-foreground whitespace-pre-wrap">{c.body}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions row */}
              <div className="flex flex-wrap items-start gap-4">
                {/* Reply */}
                <div className="flex-1 min-w-[260px] space-y-2">
                  <h4 className="text-xs font-semibold text-muted-foreground">Reply</h4>
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Write a reply..."
                    rows={3}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                  />
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={!replyText.trim() || replyMutation.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      replyMutation.mutate({ id: ticket.id, body: replyText });
                    }}
                  >
                    <Send className="h-3.5 w-3.5" />
                    Send Reply
                  </Button>
                </div>

                {/* Status change */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-muted-foreground">Status</h4>
                  <Select
                    value={ticket.status}
                    onValueChange={(val) => {
                      statusMutation.mutate({ id: ticket.id, status: val as SupportTicket["status"] });
                    }}
                  >
                    <SelectTrigger
                      className="w-[160px] text-xs"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent onClick={(e) => e.stopPropagation()}>
                      <SelectItem value="open">Open</SelectItem>
                      <SelectItem value="in-progress">In Progress</SelectItem>
                      <SelectItem value="resolved">Resolved</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ── Main component ───────────────────────────────────────────── */
export default function AdminSupport() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "bug" | "feature">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "in-progress" | "resolved">("all");

  useEffect(() => {
    setBreadcrumbs([
      { label: "IronWorks Admin" },
      { label: "Support" },
    ]);
  }, [setBreadcrumbs]);

  const { data: tickets = [], isLoading, refetch } = useQuery({
    queryKey: ["admin", "support"],
    queryFn: () => adminApi.getSupportTickets(),
    staleTime: 30_000,
  });

  const openCount = useMemo(() => tickets.filter((t) => t.status === "open").length, [tickets]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return tickets.filter((t) => {
      if (typeFilter !== "all" && t.type !== typeFilter) return false;
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (q && !t.subject.toLowerCase().includes(q) && !t.userEmail.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tickets, search, typeFilter, statusFilter]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <Headphones className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">
          Support
          {openCount > 0 && (
            <span className="ml-2 inline-flex items-center justify-center rounded-full bg-red-500/15 text-red-400 text-xs font-bold px-2 py-0.5">
              {openCount}
            </span>
          )}
        </h1>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto text-muted-foreground"
          onClick={() => refetch()}
          disabled={isLoading}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            className="pl-8 text-sm"
            placeholder="Search subject or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as typeof typeFilter)}>
          <SelectTrigger className="w-[120px] text-xs">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="bug">Bug</SelectItem>
            <SelectItem value="feature">Feature</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-[140px] text-xs">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="in-progress">In Progress</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="w-6 px-3 py-2" />
              <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Subject</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Type</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Status</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">User</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground hidden lg:table-cell">Company</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Created</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Loading...
                </td>
              </tr>
            )}
            {!isLoading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No tickets found
                </td>
              </tr>
            )}
            {filtered.map((ticket) => (
              <TicketRow key={ticket.id} ticket={ticket} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
