import { useEffect, useState } from "react";
import { ErrorBoundary, Spinner, useHostContext, usePluginData } from "@paperclipai/plugin-sdk/ui";

interface CostSummary {
  companyId: string;
  spendCents: number;
  budgetCents: number;
  utilizationPercent: number;
}

interface CostByAgentRow {
  agentId: string;
  agentName: string | null;
  agentStatus: string | null;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

interface ClaudeQuotaWindow {
  usedPercent: number | null;
  resetsAt: string | null;
}

interface ClaudeSubscriptionQuota {
  configured: boolean;
  fiveHour: ClaudeQuotaWindow | null;
  weekly: ClaudeQuotaWindow | null;
  sevenDaySonnet: ClaudeQuotaWindow | null;
  sevenDayOpus: ClaudeQuotaWindow | null;
  error?: string;
}

const API_BASE = "/api";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Format utilization from API (0–1 or 0–100) as percentage. */
function formatUtilization(value: number | null): string {
  if (value == null) return "—";
  const pct = value <= 1 ? value * 100 : value;
  return `${Number(pct.toFixed(1))}%`;
}

function formatResetsAt(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

/**
 * Modal content shown when the "Claude quota" toolbar launcher is activated.
 * Displays company cost summary and per-agent usage including Claude subscription token usage.
 */
export function ClaudeUsageModal() {
  const context = useHostContext();
  const companyId = context.companyId;

  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [byAgent, setByAgent] = useState<CostByAgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { data: claudeQuota, loading: quotaLoading } = usePluginData<ClaudeSubscriptionQuota>("claude-quota", {});

  useEffect(() => {
    if (!companyId) {
      setError("No company context");
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [summaryRes, byAgentRes] = await Promise.all([
          fetchJson<CostSummary>(`/companies/${companyId}/costs/summary`),
          fetchJson<CostByAgentRow[]>(`/companies/${companyId}/costs/by-agent`),
        ]);
        if (cancelled) return;
        setSummary(summaryRes);
        setByAgent(byAgentRes);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load usage");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  return (
    <ErrorBoundary>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Usage and budget for this company. Includes Claude and other AI providers.
        </p>

        {(loading || quotaLoading) && (
          <div className="flex items-center justify-center py-8">
            <Spinner size="md" />
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !quotaLoading && !error && summary && (
          <>
            {claudeQuota && (
              <section aria-label="Claude subscription quota" className="rounded-lg border border-border bg-muted/30 p-4">
                <h3 className="text-sm font-medium text-foreground">Claude subscription quota</h3>
                {!claudeQuota.configured && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Set the OAuth access token in plugin settings to fetch 5hr and weekly quota from the Claude API (Settings → Plugins → Claude Quota).
                  </p>
                )}
                {claudeQuota.error && (
                  <div className="mt-2 space-y-1">
                    <p className="text-sm text-destructive">{claudeQuota.error}</p>
                    {(claudeQuota.error.includes("429") || claudeQuota.error.toLowerCase().includes("rate limit")) && (
                      <p className="text-xs text-muted-foreground">Close and reopen this modal to retry. Quota is cached for 1 minute to reduce rate limits.</p>
                    )}
                  </div>
                )}
                {claudeQuota.configured && !claudeQuota.error && (claudeQuota.fiveHour || claudeQuota.weekly || claudeQuota.sevenDaySonnet || claudeQuota.sevenDayOpus) && (
                  <div className="mt-2 space-y-3 text-sm">
                    {claudeQuota.fiveHour && (
                      <div>
                        <span className="text-muted-foreground">5-hour (rolling)</span>
                        <p className="font-medium">{formatUtilization(claudeQuota.fiveHour.usedPercent)} used</p>
                        {claudeQuota.fiveHour.resetsAt && (
                          <p className="text-xs text-muted-foreground">Resets {formatResetsAt(claudeQuota.fiveHour.resetsAt)}</p>
                        )}
                      </div>
                    )}
                    {claudeQuota.weekly && (
                      <div>
                        <span className="text-muted-foreground">Weekly</span>
                        <p className="font-medium">{formatUtilization(claudeQuota.weekly.usedPercent)} used</p>
                        {claudeQuota.weekly.resetsAt && (
                          <p className="text-xs text-muted-foreground">Resets {formatResetsAt(claudeQuota.weekly.resetsAt)}</p>
                        )}
                      </div>
                    )}
                    {claudeQuota.sevenDaySonnet && (
                      <div>
                        <span className="text-muted-foreground">Weekly (Sonnet)</span>
                        <p className="font-medium">{formatUtilization(claudeQuota.sevenDaySonnet.usedPercent)} used</p>
                        {claudeQuota.sevenDaySonnet.resetsAt && (
                          <p className="text-xs text-muted-foreground">Resets {formatResetsAt(claudeQuota.sevenDaySonnet.resetsAt)}</p>
                        )}
                      </div>
                    )}
                    {claudeQuota.sevenDayOpus && (
                      <div>
                        <span className="text-muted-foreground">Weekly (Opus)</span>
                        <p className="font-medium">{formatUtilization(claudeQuota.sevenDayOpus.usedPercent)} used</p>
                        {claudeQuota.sevenDayOpus.resetsAt && (
                          <p className="text-xs text-muted-foreground">Resets {formatResetsAt(claudeQuota.sevenDayOpus.resetsAt)}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            <section aria-label="Cost summary" className="rounded-lg border border-border bg-muted/30 p-4">
              <h3 className="text-sm font-medium text-foreground">This month</h3>
              <div className="mt-2 grid grid-cols-2 gap-4 text-sm md:grid-cols-3">
                <div>
                  <span className="text-muted-foreground">Spend</span>
                  <p className="font-medium">{formatCents(summary.spendCents)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Budget</span>
                  <p className="font-medium">
                    {summary.budgetCents > 0 ? formatCents(summary.budgetCents) : "Unlimited"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Utilization</span>
                  <p className="font-medium">
                    {summary.budgetCents > 0
                      ? `${summary.utilizationPercent}%`
                      : "—"}
                  </p>
                </div>
              </div>
            </section>

            <section aria-label="Per-agent usage" className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">By agent</h3>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full min-w-[32rem] text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="px-3 py-2 font-medium">Agent</th>
                      <th className="px-3 py-2 font-medium text-right">Cost</th>
                      <th className="px-3 py-2 font-medium text-right">Subscription runs</th>
                      <th className="px-3 py-2 font-medium text-right">Sub. input tokens</th>
                      <th className="px-3 py-2 font-medium text-right">Sub. output tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byAgent.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">
                          No usage this month
                        </td>
                      </tr>
                    ) : (
                      byAgent.map((row) => (
                        <tr key={row.agentId} className="border-b border-border/70 last:border-0">
                          <td className="px-3 py-2">
                            <span className="font-medium">{row.agentName ?? row.agentId}</span>
                            {row.agentStatus && (
                              <span className="ml-1 text-muted-foreground">({row.agentStatus})</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">{formatCents(row.costCents)}</td>
                          <td className="px-3 py-2 text-right">{row.subscriptionRunCount}</td>
                          <td className="px-3 py-2 text-right">{formatTokens(row.subscriptionInputTokens)}</td>
                          <td className="px-3 py-2 text-right">{formatTokens(row.subscriptionOutputTokens)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </ErrorBoundary>
  );
}
