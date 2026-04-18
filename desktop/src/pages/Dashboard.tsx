import { Bot, FolderKanban, Settings, ArrowRight, Loader2 } from "lucide-react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { tauriInvoke } from "@/api/tauri-client";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

export function Dashboard() {
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();

  const { data: agents = [], isLoading: agentsLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues = [], isLoading: issuesLoading } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: healthStatus } = useQuery({
    queryKey: ["health"],
    queryFn: () => tauriInvoke<string>("health_check").then(() => "healthy" as const).catch(() => "degraded" as const),
    retry: false,
  });

  const { data: runStats } = useQuery({
    queryKey: ["run-stats", selectedCompanyId],
    queryFn: () => tauriInvoke<{ total: number; succeeded: number; failed: number; success_rate: number }>("get_run_stats", { companyId: selectedCompanyId!, days: 30 }),
    enabled: !!selectedCompanyId,
  });

  const loading = agentsLoading || issuesLoading;
  const hasData = agents.length > 0 || issues.length > 0;
  const systemReady = healthStatus === "healthy";

  return (
    <div className="mx-auto max-w-[720px]" style={{ animation: "fade-up 0.4s var(--ease-spring) both" }}>
      {/* Greeting */}
      <div className="mb-12">
        <div className="mb-4 flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg text-base font-bold"
            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
          >
            A
          </div>
        </div>
        <h1
          className="text-[28px] font-semibold leading-tight"
          style={{ letterSpacing: "-0.02em", color: "var(--fg)" }}
        >
          Welcome to ArchonOS
        </h1>
        <p className="mt-2 text-base leading-relaxed" style={{ color: "var(--fg-secondary)", maxWidth: 480 }}>
          Your command center for AI agents. Orchestrate, monitor, and manage autonomous teams from your desktop.
        </p>
      </div>

      {/* Status bar */}
      <div
        className="mb-8 flex items-center gap-6 rounded-lg border px-5 py-4"
        style={{
          background: "var(--card-bg)",
          borderColor: "var(--card-border)",
          animation: "fade-up 0.4s var(--ease-spring) 0.1s both",
        }}
      >
        <div className="flex items-center gap-2">
          <div
            className="h-2 w-2 rounded-full"
            style={{
              background: systemReady ? "var(--success)" : "var(--warning)",
              boxShadow: systemReady ? "0 0 0 3px var(--success-subtle)" : "0 0 0 3px var(--warning-subtle)",
            }}
          />
          <span className="text-[13px]" style={{ color: "var(--fg-secondary)" }}>
            <strong className="font-medium" style={{ color: "var(--fg)" }}>
              {systemReady ? "System ready" : "Connecting..."}
            </strong>
          </span>
        </div>
        <div className="h-5 w-px" style={{ background: "var(--border)" }} />
        <span className="text-[13px]" style={{ color: "var(--fg-secondary)" }}>SQLite connected</span>
        <div className="h-5 w-px" style={{ background: "var(--border)" }} />
        <AdapterStatusSummary />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin" style={{ color: "var(--fg-muted)" }} />
        </div>
      ) : hasData ? (
        /* Summary stats */
        <>
          <p
            className="mb-4 text-[13px] font-semibold uppercase tracking-[0.06em]"
            style={{ color: "var(--fg-muted)" }}
          >
            Overview
          </p>
          <div className="mb-8 grid grid-cols-2 gap-4" style={{ animation: "fade-up 0.4s var(--ease-spring) 0.15s both" }}>
            <button
              onClick={() => navigate("/agents")}
              className="group flex items-center gap-4 rounded-lg border px-5 py-4 text-left transition-all hover:shadow-sm"
              style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--card-border)"; }}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--accent-subtle)", color: "var(--accent)" }}>
                <Bot size={20} />
              </div>
              <div>
                <div className="text-2xl font-semibold" style={{ letterSpacing: "-0.02em" }}>{agents.length}</div>
                <div className="text-[12px]" style={{ color: "var(--fg-muted)" }}>
                  {agents.length === 1 ? "Agent" : "Agents"}
                </div>
              </div>
            </button>
            <button
              onClick={() => navigate("/issues")}
              className="group flex items-center gap-4 rounded-lg border px-5 py-4 text-left transition-all hover:shadow-sm"
              style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--card-border)"; }}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--success-subtle)", color: "var(--success)" }}>
                <FolderKanban size={20} />
              </div>
              <div>
                <div className="text-2xl font-semibold" style={{ letterSpacing: "-0.02em" }}>{issues.length}</div>
                <div className="text-[12px]" style={{ color: "var(--fg-muted)" }}>
                  {issues.length === 1 ? "Issue" : "Issues"}
                </div>
              </div>
            </button>
          </div>

          {runStats && runStats.total > 0 && (
            <div className="mb-8" style={{ animation: "fade-up 0.4s var(--ease-spring) 0.25s both" }}>
              <p className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--fg-muted)" }}>Run Performance (30d)</p>
              <div className="grid grid-cols-3 gap-4">
                <div className="rounded-lg border px-4 py-3" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
                  <div className="text-2xl font-semibold" style={{ fontFamily: "var(--font-mono)" }}>{runStats.total}</div>
                  <div className="text-[11px]" style={{ color: "var(--fg-muted)" }}>Total Runs</div>
                </div>
                <div className="rounded-lg border px-4 py-3" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
                  <div className="text-2xl font-semibold" style={{ fontFamily: "var(--font-mono)", color: "var(--success)" }}>
                    {Math.round(runStats.success_rate * 100)}%
                  </div>
                  <div className="text-[11px]" style={{ color: "var(--fg-muted)" }}>Success Rate</div>
                </div>
                <div className="rounded-lg border px-4 py-3" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
                  <div className="text-2xl font-semibold" style={{ fontFamily: "var(--font-mono)", color: "var(--destructive)" }}>{runStats.failed}</div>
                  <div className="text-[11px]" style={{ color: "var(--fg-muted)" }}>Failed</div>
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        /* Getting started cards */
        <>
          <p
            className="mb-4 text-[13px] font-semibold uppercase tracking-[0.06em]"
            style={{ color: "var(--fg-muted)" }}
          >
            Get started
          </p>
          <div className="flex flex-col gap-3">
            <GettingStartedCard
              icon={Bot}
              iconStyle={{ background: "var(--accent-subtle)", color: "var(--accent)" }}
              title="Add your first agent"
              description="Connect Claude, Codex, Cursor, or other AI agents"
              onClick={() => navigate("/agents")}
              delay="0.15s"
            />
            <GettingStartedCard
              icon={FolderKanban}
              iconStyle={{ background: "var(--success-subtle)", color: "var(--success)" }}
              title="Create a project"
              description="Organize work around repositories and goals"
              onClick={() => navigate("/projects")}
              delay="0.22s"
            />
            <GettingStartedCard
              icon={Settings}
              iconStyle={{ background: "var(--warning-subtle)", color: "var(--warning)" }}
              title="Explore settings"
              description="Configure adapters, budgets, and preferences"
              onClick={() => navigate("/settings")}
              delay="0.29s"
            />
          </div>
        </>
      )}

      <style>{`
        @keyframes fade-up {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

function AdapterStatusSummary() {
  const { data: claudeAuth } = useQuery({
    queryKey: ["adapter-auth", "claude_local"],
    queryFn: () => tauriInvoke<{ logged_in: boolean; subscription_type: string | null }>("check_adapter_auth", { adapterType: "claude_local" }),
    retry: false,
  });

  const { data: ollamaAuth } = useQuery({
    queryKey: ["adapter-auth", "ollama_local"],
    queryFn: () => tauriInvoke<{ logged_in: boolean; subscription_type: string | null }>("check_adapter_auth", { adapterType: "ollama_local" }),
    retry: false,
  });

  if (!claudeAuth && !ollamaAuth) return <span className="text-[13px]" style={{ color: "var(--fg-secondary)" }}>Checking adapters...</span>;

  const connected: string[] = [];
  if (claudeAuth?.logged_in) connected.push(`Claude${claudeAuth.subscription_type ? ` (${claudeAuth.subscription_type})` : ""}`);
  if (ollamaAuth?.logged_in) connected.push("Ollama (Free)");

  if (connected.length === 0) {
    return <span className="text-[13px]" style={{ color: "var(--fg-muted)" }}>No adapters connected</span>;
  }

  return <span className="text-[13px]" style={{ color: "var(--fg-secondary)" }}>{connected.join(" \u00B7 ")} connected</span>;
}

function GettingStartedCard({
  icon: Icon,
  iconStyle,
  title,
  description,
  onClick,
  delay,
}: {
  icon: typeof Bot;
  iconStyle: React.CSSProperties;
  title: string;
  description: string;
  onClick: () => void;
  delay: string;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-5 rounded-lg border px-6 py-5 text-left transition-all hover:shadow-sm"
      style={{
        background: "var(--card-bg)",
        borderColor: "var(--card-border)",
        animation: `fade-up 0.4s var(--ease-spring) ${delay} both`,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)";
        (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "var(--card-border)";
        (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
      }}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={iconStyle}>
        <Icon size={20} />
      </div>
      <div className="flex-1">
        <div className="text-sm font-medium" style={{ color: "var(--fg)" }}>{title}</div>
        <div className="text-[13px]" style={{ color: "var(--fg-muted)" }}>{description}</div>
      </div>
      <ArrowRight
        size={16}
        className="translate-x-[-4px] opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100"
        style={{ color: "var(--fg-muted)" }}
      />
    </button>
  );
}
