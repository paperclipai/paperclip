import { DollarSign, Zap, AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { costsApi } from "@/api/costs";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

export function Costs() {
  const { selectedCompanyId } = useCompany();
  const cid = selectedCompanyId!;

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: queryKeys.costs.summary(cid),
    queryFn: () => costsApi.getSummary(cid),
    enabled: !!selectedCompanyId,
  });

  const { data: byAgent = [] } = useQuery({
    queryKey: queryKeys.costs.byAgent(cid),
    queryFn: () => costsApi.byAgent(cid),
    enabled: !!selectedCompanyId,
  });

  const { data: byModel = [] } = useQuery({
    queryKey: queryKeys.costs.byModel(cid),
    queryFn: () => costsApi.byModel(cid),
    enabled: !!selectedCompanyId,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(cid),
    queryFn: () => agentsApi.list(cid),
    enabled: !!selectedCompanyId,
  });

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  if (summaryLoading) return <div className="p-8 text-center" style={{ color: "var(--fg-muted)" }}>Loading...</div>;

  const totalTokens = summary ? summary.total_input_tokens + summary.total_output_tokens : 0;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Costs</h1>
      </div>

      {/* Summary tiles */}
      <div className="mb-8 grid grid-cols-3 gap-4">
        <SummaryTile icon={DollarSign} label="Total Spend" value={`$${((summary?.total_cost_cents ?? 0) / 100).toFixed(2)}`} />
        <SummaryTile icon={Zap} label="Total Tokens" value={`${(totalTokens / 1000).toFixed(0)}K`} />
        <SummaryTile icon={AlertTriangle} label="Events" value={String(summary?.event_count ?? 0)} muted />
      </div>

      {/* By Agent */}
      <div className="mb-8">
        <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--fg-muted)" }}>By Agent</h3>
        <div className="rounded-lg border" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
          {byAgent.length === 0 && (
            <div className="px-4 py-8 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>No cost data yet.</div>
          )}
          {byAgent.map((entry, i) => {
            const agent = agentMap.get(entry.agent_id);
            const agentName = agent?.name ?? entry.agent_id;
            const tokens = entry.total_input_tokens + entry.total_output_tokens;
            return (
              <div
                key={entry.agent_id}
                className="flex items-center justify-between px-4 py-3 text-[13px]"
                style={{ borderBottom: i < byAgent.length - 1 ? "1px solid var(--border-subtle)" : undefined }}
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold" style={{ background: "var(--bg-muted)", color: "var(--fg-muted)" }}>
                    {agentName[0]}
                  </div>
                  <span className="font-medium">{agentName}</span>
                </div>
                <div className="flex items-center gap-8">
                  <span style={{ color: "var(--fg-muted)" }}>{(tokens / 1000).toFixed(0)}K tokens</span>
                  <span className="w-20 text-right font-medium" style={{ fontFamily: "var(--font-mono)" }}>
                    ${(entry.total_cost_cents / 100).toFixed(2)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* By Model */}
      <div>
        <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--fg-muted)" }}>By Model</h3>
        <div className="rounded-lg border" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
          {byModel.length === 0 && (
            <div className="px-4 py-8 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>No cost data yet.</div>
          )}
          {byModel.map((item, i) => (
            <div
              key={item.model}
              className="flex items-center justify-between px-4 py-3 text-[13px]"
              style={{ borderBottom: i < byModel.length - 1 ? "1px solid var(--border-subtle)" : undefined }}
            >
              <span className="font-medium" style={{ fontFamily: "var(--font-mono)" }}>{item.model}</span>
              <div className="flex items-center gap-8">
                <span style={{ color: "var(--fg-muted)" }}>{item.event_count} events</span>
                <span className="w-20 text-right font-medium" style={{ fontFamily: "var(--font-mono)" }}>
                  ${(item.total_cost_cents / 100).toFixed(2)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SummaryTile({ icon: Icon, label, value, muted }: { icon: typeof DollarSign; label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-lg border px-5 py-4" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
      <div className="mb-2 flex items-center gap-2">
        <Icon size={14} style={{ color: "var(--fg-muted)" }} />
        <span className="text-[12px] font-medium" style={{ color: "var(--fg-muted)" }}>{label}</span>
      </div>
      <div className="text-2xl font-semibold" style={{ fontFamily: "var(--font-mono)", color: muted ? "var(--fg-muted)" : "var(--fg)" }}>
        {value}
      </div>
    </div>
  );
}
