import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText, ShieldCheck } from "lucide-react";
import { Link } from "@/lib/router";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi, type ToolGatewayAuditRow } from "@/api/tools";
import { EmptyState } from "@/components/EmptyState";
import { ToolsPageHeader, LoadingState, ErrorState, RelativeTime, DecisionBadge } from "./shared";

const OUTCOME_FILTERS = [
  { value: "__all", label: "All outcomes" },
  { value: "allowed", label: "Allowed", match: ["call_allowed", "call_completed"] },
  { value: "denied", label: "Denied", match: ["call_denied"] },
  { value: "failed", label: "Failed", match: ["call_failed"] },
  { value: "approval", label: "Approval requested", match: ["approval_requested"] },
  { value: "deferred", label: "Deferred", match: ["call_deferred"] },
] as const;

const WINDOW_FILTERS = [
  { value: "1h", label: "Last 1h", ms: 60 * 60 * 1000 },
  { value: "24h", label: "Last 24h", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "__all", label: "All time", ms: null },
] as const;

function detailString(details: Record<string, unknown> | null, key: string): string | undefined {
  const v = details?.[key];
  return typeof v === "string" ? v : undefined;
}

/** Map a gateway audit action onto the canonical decision palette. */
function actionDecision(action: string): string {
  if (action.endsWith("denied")) return "deny";
  if (action.endsWith("failed")) return "block";
  if (action.endsWith("deferred")) return "defer";
  if (action.includes("approval")) return "require_approval";
  if (action.endsWith("allowed") || action.endsWith("completed")) return "allow";
  return action.replace("tool_gateway.", "");
}

function AuditRow({ row }: { row: ToolGatewayAuditRow }) {
  const tool = detailString(row.details, "tool") ?? detailString(row.details, "toolName") ?? "—";
  const reason = detailString(row.details, "reasonCode") ?? row.action.replace("tool_gateway.", "");
  const issueId = detailString(row.details, "issueId");
  const runId = detailString(row.details, "runId");
  const agentId = detailString(row.details, "agentId") ?? row.actorId ?? undefined;
  return (
    <tr className="align-top">
      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground whitespace-nowrap">
        <RelativeTime value={row.createdAt} />
      </td>
      <td className="px-3 py-2.5">
        <DecisionBadge decision={actionDecision(row.action)} />
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-foreground">{tool}</td>
      <td className="px-3 py-2.5 text-xs text-muted-foreground">
        {row.actorType ?? "—"}
        {runId ? <span className="block font-mono text-[11px]">run {runId.slice(0, 8)}</span> : null}
      </td>
      <td className="px-3 py-2.5 text-xs text-muted-foreground">{reason}</td>
      <td className="px-4 py-2.5 text-right text-xs whitespace-nowrap">
        <span className="flex items-center justify-end gap-2">
          {issueId ? (
            <Link to={`/issues/${issueId}`} className="text-primary hover:underline">
              issue
            </Link>
          ) : null}
          {runId && agentId ? (
            <Link to={`/agents/${agentId}/runs/${runId}`} className="text-primary hover:underline">
              run →
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </span>
      </td>
    </tr>
  );
}

export function AuditTab({ companyId }: { companyId: string }) {
  const [limit, setLimit] = useState(100);
  const [outcome, setOutcome] = useState<string>("__all");
  const [windowKey, setWindowKey] = useState<string>("24h");
  const [query, setQuery] = useState("");

  const audit = useQuery({
    queryKey: queryKeys.tools.audit(companyId, limit),
    queryFn: () => toolsApi.listAudit(companyId, limit),
  });

  const filtered = useMemo(() => {
    let rows = audit.data ?? [];
    const f = OUTCOME_FILTERS.find((o) => o.value === outcome);
    if (f && "match" in f) {
      rows = rows.filter((r) => f.match.some((m) => r.action.includes(m)));
    }
    const w = WINDOW_FILTERS.find((o) => o.value === windowKey);
    if (w && w.ms !== null) {
      const cutoff = Date.now() - w.ms;
      rows = rows.filter((r) => {
        const ts = new Date(r.createdAt).getTime();
        return !Number.isFinite(ts) || ts >= cutoff;
      });
    }
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => JSON.stringify(r.details ?? {}).toLowerCase().includes(q) || r.action.includes(q));
    }
    return rows;
  }, [audit.data, outcome, windowKey, query]);

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title="Audit"
        description="Every governed tool-call decision — allow, deny, approval, defer, failure — with run and issue links. Values are redacted; audit never stores secrets or raw arguments."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={outcome} onValueChange={setOutcome}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OUTCOME_FILTERS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={windowKey} onValueChange={setWindowKey}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOW_FILTERS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[50, 100, 250, 500].map((n) => (
              <SelectItem key={n} value={String(n)}>
                Last {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Filter by tool, reason, agent…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          server-authoritative
        </span>
      </div>

      {audit.isLoading ? (
        <LoadingState />
      ) : audit.error ? (
        <ErrorState error={audit.error} onRetry={() => audit.refetch()} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          message="No matching audit events"
          description="Governed tool calls appear here as soon as agents start using the gateway."
        />
      ) : (
        <Card>
          <CardContent className="px-0 py-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Time</th>
                  <th className="px-3 py-2.5 font-medium">Outcome</th>
                  <th className="px-3 py-2.5 font-medium">Tool</th>
                  <th className="px-3 py-2.5 font-medium">Actor</th>
                  <th className="px-3 py-2.5 font-medium">Reason</th>
                  <th className="px-4 py-2.5 text-right font-medium">Run</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((row) => (
                  <AuditRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        The audit log is the source of truth for what the gateway decided. An agent's transcript is a UI
        rendering of its own view, not the authority — this table is server-authoritative.
      </p>
    </div>
  );
}
