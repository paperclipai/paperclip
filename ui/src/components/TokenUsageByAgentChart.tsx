import type { CostByAgent } from "@paperclipai/shared";
import { formatTokens } from "../lib/utils";

const TOKEN_COLORS = {
  input: "#3b82f6",
  cached: "#8b5cf6",
  output: "#10b981",
} as const;

export function TokenUsageByAgentChart({ agents }: { agents: CostByAgent[] }) {
  if (agents.length === 0) {
    return <p className="text-xs text-muted-foreground">No token usage yet.</p>;
  }

  const sorted = agents
    .map((a) => ({
      ...a,
      total: a.inputTokens + a.cachedInputTokens + a.outputTokens,
    }))
    .sort((a, b) => b.total - a.total);

  const maxTotal = Math.max(...sorted.map((a) => a.total), 1);

  return (
    <div className="space-y-2">
      {sorted.map((agent) => {
        const widthPct = (agent.total / maxTotal) * 100;
        return (
          <div key={agent.agentId} className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate font-medium">
                {agent.agentName ?? agent.agentId}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatTokens(agent.total)}
              </span>
            </div>
            <div
              className="flex h-5 overflow-hidden rounded-sm"
              style={{ width: `${Math.max(widthPct, 2)}%` }}
              title={`Input: ${formatTokens(agent.inputTokens)} · Cached: ${formatTokens(agent.cachedInputTokens)} · Output: ${formatTokens(agent.outputTokens)}`}
            >
              {agent.inputTokens > 0 && (
                <div
                  style={{
                    flex: agent.inputTokens,
                    backgroundColor: TOKEN_COLORS.input,
                  }}
                />
              )}
              {agent.cachedInputTokens > 0 && (
                <div
                  style={{
                    flex: agent.cachedInputTokens,
                    backgroundColor: TOKEN_COLORS.cached,
                  }}
                />
              )}
              {agent.outputTokens > 0 && (
                <div
                  style={{
                    flex: agent.outputTokens,
                    backgroundColor: TOKEN_COLORS.output,
                  }}
                />
              )}
            </div>
          </div>
        );
      })}

      <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-2">
        <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <span
            className="h-1.5 w-1.5 rounded-full shrink-0"
            style={{ backgroundColor: TOKEN_COLORS.input }}
          />
          Input
        </span>
        <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <span
            className="h-1.5 w-1.5 rounded-full shrink-0"
            style={{ backgroundColor: TOKEN_COLORS.cached }}
          />
          Cached input
        </span>
        <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <span
            className="h-1.5 w-1.5 rounded-full shrink-0"
            style={{ backgroundColor: TOKEN_COLORS.output }}
          />
          Output
        </span>
      </div>
    </div>
  );
}
