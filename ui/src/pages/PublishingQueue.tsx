import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Approval } from "@paperclipai/shared";

function getPayloadString(payload: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!payload) return null;
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function statusChip(status: string): string {
  if (status === "published") return "bg-emerald-500/15 text-emerald-600 border-emerald-500/30";
  if (status === "scheduled") return "bg-blue-500/15 text-blue-600 border-blue-500/30";
  if (status === "approved") return "bg-amber-500/15 text-amber-700 border-amber-500/30";
  if (status === "paused") return "bg-muted text-muted-foreground border-border";
  return "bg-muted text-muted-foreground border-border";
}

type QueueRow = {
  id: string;
  title: string;
  issueKey: string;
  channel: string;
  status: string;
  approvedAt: string | null;
  pickedUpAt: string | null;
  scheduledFor: string | null;
  publishedAt: string | null;
  proofUrl: string | null;
};

type QueueFilter = "all" | "waiting" | "scheduled" | "published" | "unpicked";

function inFilter(row: QueueRow, filter: QueueFilter): boolean {
  if (filter === "all") return true;
  if (filter === "waiting") return row.status !== "published";
  if (filter === "scheduled") return row.status === "scheduled";
  if (filter === "published") return row.status === "published";
  if (filter === "unpicked") return row.status !== "published" && !row.pickedUpAt;
  return true;
}

export function PublishingQueue() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filter, setFilter] = useState<QueueFilter>("waiting");
  const [search, setSearch] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Publishing Queue" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const rows = useMemo<QueueRow[]>(() => {
    const approvals = (data ?? []).filter((a) => ["approved", "scheduled", "published", "paused", "recalled"].includes(a.status));
    return approvals
      .map((approval: Approval) => {
        const payload = (approval.payload ?? null) as Record<string, unknown> | null;
        return {
          id: approval.id,
          title: getPayloadString(payload, ["title", "summary"]) ?? approval.id,
          issueKey: getPayloadString(payload, ["issue", "issueKey"]) ?? "—",
          channel: getPayloadString(payload, ["channel", "category", "lane"]) ?? "—",
          status: approval.status,
          approvedAt: approval.decidedAt ? String(approval.decidedAt) : null,
          pickedUpAt: getPayloadString(payload, ["consumedAt", "claimedAt", "pickedUpAt", "katyaClaimedAt", "runStartedAt"]),
          scheduledFor: getPayloadString(payload, ["targetPublishAt", "scheduledAt", "scheduledFor", "publishAt"]),
          publishedAt: getPayloadString(payload, ["publishedAt", "postedAt"]),
          proofUrl: getPayloadString(payload, ["proofUrl", "publishedUrl", "postUrl", "url"]),
        };
      })
      .sort((a, b) => {
        const ax = a.scheduledFor ?? a.approvedAt ?? "";
        const bx = b.scheduledFor ?? b.approvedAt ?? "";
        return bx.localeCompare(ax);
      });
  }, [data]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (!inFilter(row, filter)) return false;
      if (!q) return true;
      return `${row.issueKey} ${row.title} ${row.channel} ${row.status}`.toLowerCase().includes(q);
    });
  }, [rows, filter, search]);

  const counts = useMemo(() => ({
    all: rows.length,
    waiting: rows.filter((r) => inFilter(r, "waiting")).length,
    scheduled: rows.filter((r) => inFilter(r, "scheduled")).length,
    published: rows.filter((r) => inFilter(r, "published")).length,
    unpicked: rows.filter((r) => inFilter(r, "unpicked")).length,
  }), [rows]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to view publishing queue.</div>;
  }

  if (isLoading) return <PageSkeleton />;

  if (isError) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">Failed to load publishing queue.</p>
        <button className="mt-2 text-xs underline" onClick={() => refetch()}>Retry</button>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Publishing Queue</h1>
        <p className="text-xs text-muted-foreground">Read-only tracking panel. No workflow changes.</p>
      </div>

      <div className="rounded-lg border border-border p-3 grid gap-2 md:grid-cols-3">
        <label className="text-xs">
          <span className="text-muted-foreground">Quick filter</span>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as QueueFilter)}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="waiting">Waiting to publish ({counts.waiting})</option>
            <option value="unpicked">Not picked up by Katya ({counts.unpicked})</option>
            <option value="scheduled">Scheduled ({counts.scheduled})</option>
            <option value="published">Published ({counts.published})</option>
            <option value="all">All ({counts.all})</option>
          </select>
        </label>

        <label className="text-xs md:col-span-2">
          <span className="text-muted-foreground">Search</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Issue, title, channel, status"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="min-w-[1100px] w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="text-left p-2">Issue</th>
              <th className="text-left p-2">Title</th>
              <th className="text-left p-2">Channel</th>
              <th className="text-left p-2">Status</th>
              <th className="text-left p-2">Approved</th>
              <th className="text-left p-2">Picked up</th>
              <th className="text-left p-2">Scheduled</th>
              <th className="text-left p-2">Published</th>
              <th className="text-left p-2">Proof</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.id} className="border-t border-border align-top">
                <td className="p-2 text-xs text-muted-foreground">{row.issueKey}</td>
                <td className="p-2">
                  <Link to={`/approvals/${row.id}`} className="hover:underline">
                    {row.title}
                  </Link>
                </td>
                <td className="p-2 text-xs">{row.channel}</td>
                <td className="p-2">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${statusChip(row.status)}`}>
                    {row.status}
                  </span>
                </td>
                <td className="p-2 text-xs text-muted-foreground">{row.approvedAt ?? "—"}</td>
                <td className="p-2 text-xs text-muted-foreground">{row.pickedUpAt ?? "—"}</td>
                <td className="p-2 text-xs text-muted-foreground">{row.scheduledFor ?? "—"}</td>
                <td className="p-2 text-xs text-muted-foreground">{row.publishedAt ?? "—"}</td>
                <td className="p-2 text-xs text-muted-foreground break-all">{row.proofUrl ?? "—"}</td>
              </tr>
            ))}
            {filteredRows.length === 0 && (
              <tr>
                <td colSpan={9} className="p-6 text-center text-sm text-muted-foreground">No rows match this filter yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
