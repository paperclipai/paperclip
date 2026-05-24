import { useQuery } from "@tanstack/react-query";
import { costsApi } from "../api/costs";
import type { AgentTokenUsageRow } from "@paperclipai/shared";
import { useState } from "react";
import { cn } from "../lib/utils";
import { ChevronUp, ChevronDown } from "lucide-react";

type SortKey = "agentName" | "netUsageTokens" | "pctOfCap";
type SortDir = "asc" | "desc";

function sortRows(rows: AgentTokenUsageRow[], key: SortKey, dir: SortDir): AgentTokenUsageRow[] {
  return [...rows].sort((a, b) => {
    let av: string | number | null;
    let bv: string | number | null;
    if (key === "agentName") {
      av = a.agentName;
      bv = b.agentName;
    } else if (key === "netUsageTokens") {
      av = a.netUsageTokens;
      bv = b.netUsageTokens;
    } else {
      av = a.pctOfCap ?? -1;
      bv = b.pctOfCap ?? -1;
    }
    if (av === bv) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp = av < bv ? -1 : 1;
    return dir === "asc" ? cmp : -cmp;
  });
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  const cls = cn("inline-block ml-1", active ? "opacity-100" : "opacity-30");
  return dir === "asc" && active
    ? <ChevronUp className={cn(cls, "h-3 w-3")} />
    : <ChevronDown className={cn(cls, "h-3 w-3")} />;
}

interface Props {
  companyId: string;
}

export function TokenUsageWidget({ companyId }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("agentName");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const { data, isLoading } = useQuery({
    queryKey: ["token-usage", companyId],
    queryFn: () => costsApi.tokenUsage(companyId),
    enabled: !!companyId,
  });

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "agentName" ? "asc" : "desc");
    }
  }

  const rows = data ? sortRows(data, sortKey, sortDir) : [];

  function rowClass(row: AgentTokenUsageRow) {
    if (row.hardStopped) return "bg-red-50 dark:bg-red-950/40";
    if (row.warningFired) return "bg-amber-50 dark:bg-amber-950/40";
    return "";
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        Token Usage — {data?.[0]?.month ?? "Current Month"}
      </h3>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agents found.</p>
      ) : (
        <div className="border border-border overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th
                  className="px-3 py-2 text-left font-medium cursor-pointer select-none whitespace-nowrap"
                  onClick={() => handleSort("agentName")}
                >
                  Agent <SortIcon active={sortKey === "agentName"} dir={sortDir} />
                </th>
                <th
                  className="px-3 py-2 text-right font-medium cursor-pointer select-none whitespace-nowrap"
                  onClick={() => handleSort("netUsageTokens")}
                >
                  Tokens Used <SortIcon active={sortKey === "netUsageTokens"} dir={sortDir} />
                </th>
                <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Cap</th>
                <th
                  className="px-3 py-2 text-right font-medium cursor-pointer select-none whitespace-nowrap"
                  onClick={() => handleSort("pctOfCap")}
                >
                  % of Cap <SortIcon active={sortKey === "pctOfCap"} dir={sortDir} />
                </th>
                <th className="px-3 py-2 text-center font-medium whitespace-nowrap">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.agentId} className={cn("hover:bg-accent/30 transition-colors", rowClass(row))}>
                  <td className="px-3 py-2 font-medium truncate max-w-[140px]">{row.agentName}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.netUsageTokens.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {row.capTokens !== null ? row.capTokens.toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.pctOfCap !== null ? `${row.pctOfCap.toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {row.hardStopped ? (
                      <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300">
                        Hard stop
                      </span>
                    ) : row.warningFired ? (
                      <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
                        Warning
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
