import { useState } from "react";
import { useParams, useNavigate } from "react-router";
import { ArrowLeft, Pause, Play, Trash2, Zap } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { agentsApi } from "@/api/agents";
import type { Agent, HeartbeatRun } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { tauriInvoke } from "@/api/tauri-client";
import { TranscriptViewer } from "@/components/agents/TranscriptViewer";

type Tab = "overview" | "configuration" | "runs" | "budget" | "instructions";

export function AgentDetail() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const queryClient = useQueryClient();

  const { data: agent, isLoading } = useQuery({
    queryKey: queryKeys.agents.detail(agentId!),
    queryFn: () => agentsApi.get(agentId!),
    enabled: !!agentId,
  });

  const { data: runs = [] } = useQuery({
    queryKey: queryKeys.agents.runs(agentId!),
    queryFn: () => agentsApi.listRuns(agentId!),
    enabled: !!agentId,
  });

  const pauseMutation = useMutation({
    mutationFn: () => agentsApi.pause(agentId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId!) }),
  });

  const resumeMutation = useMutation({
    mutationFn: () => agentsApi.resume(agentId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId!) }),
  });

  const terminateMutation = useMutation({
    mutationFn: () => agentsApi.terminate(agentId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId!) });
      navigate("/agents");
    },
  });

  const wakeMutation = useMutation({
    mutationFn: () => tauriInvoke<string>("wake_agent", { id: agentId!, source: "manual", reason: "Manual wake from UI" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runs(agentId!) });
    },
  });

  if (isLoading || !agent) return <div className="p-8 text-center" style={{ color: "var(--fg-muted)" }}>Loading...</div>;

  const statusStyle = getStatusStyle(agent.status);

  return (
    <div>
      {/* Back + header */}
      <button
        onClick={() => navigate("/agents")}
        className="mb-4 flex items-center gap-1.5 text-[13px] transition-colors"
        style={{ color: "var(--fg-muted)" }}
      >
        <ArrowLeft size={14} /> Back to Agents
      </button>

      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-lg text-xl font-semibold"
            style={{ background: statusStyle.bg, color: statusStyle.fg }}
          >
            {agent.name[0]}
          </div>
          <div>
            <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>
              {agent.name}
            </h1>
            <div className="flex items-center gap-2 text-[13px]" style={{ color: "var(--fg-muted)" }}>
              <span className="capitalize">{agent.role}</span>
              <span>·</span>
              <span>{getAdapterLabel(agent.adapter_type)}</span>
              <span>·</span>
              <span
                className="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
                style={{ background: statusStyle.bg, color: statusStyle.fg }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    background: statusStyle.fg,
                    animation: agent.status === "running" ? "pulse-dot 2s ease-in-out infinite" : undefined,
                  }}
                />
                {statusStyle.label}
              </span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <ActionButton icon={Zap} label="Wake" onClick={() => wakeMutation.mutate()} />
          {agent.status === "paused" ? (
            <ActionButton icon={Play} label="Resume" onClick={() => resumeMutation.mutate()} />
          ) : agent.status !== "terminated" ? (
            <ActionButton icon={Pause} label="Pause" onClick={() => pauseMutation.mutate()} />
          ) : null}
          <ActionButton icon={Trash2} label="Terminate" destructive onClick={() => terminateMutation.mutate()} />
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex gap-0 border-b" style={{ borderColor: "var(--border)" }}>
        {(["overview", "configuration", "runs", "budget", "instructions"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn("relative px-4 py-2 pb-3 text-[13px] capitalize transition-colors")}
            style={{
              color: activeTab === tab ? "var(--fg)" : "var(--fg-muted)",
              fontWeight: activeTab === tab ? 500 : 400,
              background: "none",
              border: "none",
              fontFamily: "var(--font-body)",
            }}
          >
            {tab}
            {activeTab === tab && (
              <span className="absolute bottom-[-1px] left-0 right-0 h-[2px] rounded-t" style={{ background: "var(--accent)" }} />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "overview" && <OverviewTab agent={agent} runs={runs} />}
      {activeTab === "configuration" && <ConfigurationTab agent={agent} />}
      {activeTab === "runs" && <RunsTab runs={runs} />}
      {activeTab === "budget" && <BudgetTab agent={agent} />}
      {activeTab === "instructions" && <InstructionsTab agentId={agentId!} />}
    </div>
  );
}

function OverviewTab({ agent, runs }: { agent: Agent; runs: HeartbeatRun[] }) {
  return (
    <div className="grid gap-6 max-w-2xl">
      <InfoSection title="Details">
        <InfoRow label="Name" value={agent.name} />
        <InfoRow label="Role" value={agent.role} />
        <InfoRow label="Title" value={agent.title || "\u2014"} />
        <InfoRow label="Adapter" value={getAdapterLabel(agent.adapter_type)} />
        <InfoRow label="Last heartbeat" value={agent.last_heartbeat_at ? new Date(agent.last_heartbeat_at).toLocaleString() : "Never"} />
        <InfoRow label="Created" value={new Date(agent.created_at).toLocaleDateString()} />
      </InfoSection>

      <InfoSection title="Recent Runs">
        {runs.length === 0 && (
          <p className="px-4 py-4 text-[13px]" style={{ color: "var(--fg-muted)" }}>No runs yet.</p>
        )}
        {runs.slice(0, 3).map((run) => (
          <div key={run.id} className="flex items-center justify-between py-2 px-4 text-[13px]">
            <div className="flex items-center gap-2">
              <span className={cn("h-1.5 w-1.5 rounded-full")} style={{ background: run.status === "succeeded" ? "var(--success)" : "var(--destructive)" }} />
              <span className="capitalize" style={{ color: "var(--fg-secondary)" }}>{run.invocation_source.replace("_", " ")}</span>
            </div>
            <div className="flex items-center gap-4" style={{ color: "var(--fg-muted)" }}>
              <span>{run.started_at ? new Date(run.started_at).toLocaleString() : "\u2014"}</span>
            </div>
          </div>
        ))}
      </InfoSection>
    </div>
  );
}

interface AdapterTestResult {
  available: boolean;
  version: string | null;
  command: string;
  error: string | null;
}

function ConfigurationTab({ agent }: { agent: Agent }) {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(agent.adapter_config); } catch { /* empty */ }

  const [testResult, setTestResult] = useState<AdapterTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await tauriInvoke<AdapterTestResult>("test_adapter", { adapterType: agent.adapter_type });
      setTestResult(result);
    } catch (err) {
      setTestResult({ available: false, version: null, command: agent.adapter_type, error: String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <AuthSection agent={agent} />
      <InfoSection title="Adapter Configuration">
        {Object.entries(config).map(([key, value]) => (
          <InfoRow key={key} label={key} value={String(value)} mono />
        ))}
        {Object.keys(config).length === 0 && (
          <p className="py-4 px-4 text-[13px]" style={{ color: "var(--fg-muted)" }}>No configuration set.</p>
        )}
      </InfoSection>

      <div className="mt-4">
        <button
          onClick={handleTestConnection}
          disabled={testing}
          className="rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50"
          style={{ borderColor: "var(--border)", color: "var(--fg-secondary)" }}
        >
          {testing ? "Testing..." : "Test Connection"}
        </button>
        {testResult && (
          <div className="mt-2 text-[13px]">
            {testResult.available ? (
              <span style={{ color: "var(--success)" }}>
                {"\u2713"} {testResult.command} available{testResult.version ? ` (${testResult.version})` : ""}
              </span>
            ) : (
              <span style={{ color: "var(--destructive)" }}>
                {"\u2717"} {testResult.error}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RunsTab({ runs }: { runs: HeartbeatRun[] }) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  return (
    <div>
      <div className="rounded-lg border" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
        {runs.length === 0 && (
          <div className="px-5 py-8 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>No runs yet.</div>
        )}
        {runs.map((run, i) => (
          <div key={run.id}>
            <div
              onClick={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
              className={cn("flex items-center gap-4 px-5 py-3 text-[13px] cursor-pointer transition-colors hover:bg-[var(--bg-subtle)]", i < runs.length - 1 && !expandedRunId && "border-b")}
              style={{ borderColor: "var(--border-subtle)" }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: run.status === "succeeded" ? "var(--success)" : run.status === "running" ? "var(--accent)" : "var(--destructive)" }} />
              <span className="w-20 capitalize" style={{ color: run.status === "succeeded" ? "var(--success)" : run.status === "running" ? "var(--accent)" : "var(--destructive)" }}>
                {run.status}
              </span>
              <span className="w-24" style={{ color: "var(--fg-secondary)" }}>{run.invocation_source.replace("_", " ")}</span>
              <span className="flex-1" style={{ color: "var(--fg-muted)" }}>{run.started_at ? new Date(run.started_at).toLocaleString() : "\u2014"}</span>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-secondary)" }}>
                {run.exit_code !== null ? `exit ${run.exit_code}` : "\u2014"}
              </span>
              <span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>{expandedRunId === run.id ? "\u25BC" : "\u25B6"}</span>
            </div>
            {expandedRunId === run.id && (
              <div className="border-b px-5 py-3" style={{ borderColor: "var(--border-subtle)" }}>
                <TranscriptViewer
                  runId={run.id}
                  initialStdout={run.stdout_excerpt || undefined}
                  isLive={run.status === "running"}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function BudgetTab({ agent }: { agent: Agent }) {
  const spent = agent.spent_monthly_cents / 100;
  const budget = agent.budget_monthly_cents / 100;
  const pct = budget > 0 ? Math.round((spent / budget) * 100) : 0;

  return (
    <div className="max-w-2xl">
      <InfoSection title="Monthly Budget">
        <div className="py-4 px-4">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-2xl font-semibold" style={{ fontFamily: "var(--font-mono)" }}>
              ${spent.toFixed(2)}
            </span>
            <span className="text-sm" style={{ color: "var(--fg-muted)" }}>
              of ${budget.toFixed(2)} ({pct}%)
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--bg-muted)" }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(pct, 100)}%`,
                background: pct > 80 ? "var(--warning)" : "var(--accent)",
              }}
            />
          </div>
        </div>
      </InfoSection>
    </div>
  );
}

function renderMarkdown(text: string): string {
  return text
    .replace(/^### (.+)$/gm, '<h3 style="font-size:16px;font-weight:600;margin:16px 0 8px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:18px;font-weight:600;margin:16px 0 8px">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:20px;font-weight:600;margin:16px 0 8px">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code style="background:var(--bg-muted);padding:1px 4px;border-radius:3px;font-family:var(--font-mono);font-size:12px">$1</code>')
    .replace(/^- (.+)$/gm, '<li style="margin-left:16px">$1</li>')
    .replace(/\n/g, '<br/>');
}

function InstructionsTab({ agentId }: { agentId: string }) {
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [subTab, setSubTab] = useState<"edit" | "preview">("edit");
  const queryClient = useQueryClient();

  const { data: instructions, isLoading } = useQuery({
    queryKey: ["agent-instructions", agentId],
    queryFn: () => tauriInvoke<string>("get_agent_instructions", { agentId }),
    enabled: !!agentId,
  });

  const { data: files = [] } = useQuery({
    queryKey: ["agent-instruction-files", agentId],
    queryFn: () => tauriInvoke<string[]>("list_instruction_files", { agentId }),
    enabled: !!agentId,
  });

  // Sync content from query
  if (instructions && !loaded) {
    setContent(instructions);
    setLoaded(true);
  }

  const saveMutation = useMutation({
    mutationFn: (body: string) => tauriInvoke("save_agent_instructions", { agentId, content: body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agent-instructions", agentId] }),
  });

  if (isLoading) return <div className="p-4 text-[13px]" style={{ color: "var(--fg-muted)" }}>Loading...</div>;

  return (
    <div className="max-w-2xl">
      <div className="mb-3 text-[13px]" style={{ color: "var(--fg-muted)" }}>
        Edit your agent's instruction file (AGENTS.md). These instructions are passed to the agent on every fresh session.
      </div>

      {/* File chips */}
      {files.length > 0 && (
        <div className="mb-3 flex gap-2 flex-wrap">
          {files.map(file => (
            <span key={file}
              className="rounded-md border px-2 py-1 text-[11px]"
              style={{ borderColor: "var(--border)", color: "var(--fg-secondary)" }}>
              {file}
            </span>
          ))}
        </div>
      )}

      {/* Sub-tabs: Edit / Preview */}
      <div className="mb-3 flex gap-0 border-b" style={{ borderColor: "var(--border)" }}>
        {(["edit", "preview"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setSubTab(tab)}
            className={cn("relative px-3 py-1.5 pb-2 text-[12px] capitalize")}
            style={{
              color: subTab === tab ? "var(--fg)" : "var(--fg-muted)",
              fontWeight: subTab === tab ? 500 : 400,
              background: "none",
              border: "none",
              fontFamily: "var(--font-body)",
            }}
          >
            {tab}
            {subTab === tab && (
              <span className="absolute bottom-[-1px] left-0 right-0 h-[2px] rounded-t" style={{ background: "var(--accent)" }} />
            )}
          </button>
        ))}
      </div>

      {subTab === "edit" ? (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={16}
          className="w-full rounded-lg border p-4 text-[13px] outline-none"
          style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-mono)", lineHeight: "1.6" }}
        />
      ) : (
        <div
          className="w-full rounded-lg border p-4 text-[13px]"
          style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", lineHeight: "1.6", minHeight: "384px" }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
        />
      )}

      <div className="mt-3 flex justify-end">
        <button
          onClick={() => saveMutation.mutate(content)}
          disabled={saveMutation.isPending}
          className="rounded-md px-4 py-2 text-[13px] font-medium disabled:opacity-40"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          {saveMutation.isPending ? "Saving..." : "Save Instructions"}
        </button>
      </div>
    </div>
  );
}

function AuthSection({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const { data: authStatus, isLoading: authLoading } = useQuery({
    queryKey: ["adapter-auth", agent.adapter_type],
    queryFn: () => tauriInvoke<{ adapter_type: string; cli_installed: boolean; logged_in: boolean; auth_method: string | null; email: string | null; subscription_type: string | null; api_key_configured: boolean }>("check_adapter_auth", { adapterType: agent.adapter_type }),
  });

  const loginMutation = useMutation({
    mutationFn: () => tauriInvoke<{ success: boolean; message: string }>("adapter_login", { adapterType: agent.adapter_type }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["adapter-auth"] }),
  });

  const logoutMutation = useMutation({
    mutationFn: () => tauriInvoke("adapter_logout", { adapterType: agent.adapter_type }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["adapter-auth"] }),
  });

  if (authLoading || !authStatus) return null;

  const isOllama = agent.adapter_type === "ollama_local";

  return (
    <div className="mb-4 rounded-lg border p-4" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
      <h4 className="mb-3 text-[13px] font-semibold">Authentication</h4>

      {authStatus.logged_in ? (
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--success)" }} />
          <span className="text-[13px]">
            {isOllama ? "Ready" : `Logged in${authStatus.email ? ` as ${authStatus.email}` : ""}`}
          </span>
          {isOllama ? (
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{ background: "var(--success-subtle)", color: "var(--success)" }}>
              Free &middot; Local
            </span>
          ) : authStatus.subscription_type && (
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium capitalize"
              style={{ background: "var(--accent-subtle)", color: "var(--accent)" }}>
              {authStatus.subscription_type}
            </span>
          )}
          {!isOllama && (
            <span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
              ({authStatus.api_key_configured ? "API key" : "subscription"})
            </span>
          )}
          {!isOllama && (
            <button onClick={() => logoutMutation.mutate()} className="ml-auto text-[11px]" style={{ color: "var(--fg-muted)" }}>
              Logout
            </button>
          )}
        </div>
      ) : authStatus.cli_installed ? (
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--warning)" }} />
          {loginMutation.isPending ? (
            <span className="text-[13px]" style={{ color: "var(--fg-muted)" }}>
              {isOllama ? "Setting up Ollama..." : "Complete login in your browser..."}
            </span>
          ) : (
            <>
              <span className="text-[13px]">{isOllama ? "No models downloaded" : "Not logged in"}</span>
              <button onClick={() => loginMutation.mutate()}
                className="rounded-md px-3 py-1.5 text-[12px] font-medium"
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}>
                {isOllama ? "Setup Ollama" : `Login with ${getAdapterLabel(agent.adapter_type)}`}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--destructive)" }} />
          <span className="text-[13px]">{isOllama ? "Ollama not installed" : "CLI not installed"}</span>
          <span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
            {isOllama ? (
              <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: "var(--accent)" }}>
                Download from ollama.com
              </a>
            ) : (
              `Install the ${getAdapterLabel(agent.adapter_type)} CLI to get started`
            )}
          </span>
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-[11px]" style={{ color: "var(--fg-muted)" }}>
          Advanced: Use API key instead
        </summary>
        <p className="mt-2 text-[11px]" style={{ color: "var(--fg-muted)" }}>
          API keys override login sessions. Set one in Settings &rarr; Secrets.
        </p>
      </details>
    </div>
  );
}

// -- Shared helpers --

function InfoSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--fg-muted)" }}>
        {title}
      </h3>
      <div className="rounded-lg border divide-y" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)", divideColor: "var(--border-subtle)" }}>
        {children}
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 text-[13px]">
      <span style={{ color: "var(--fg-muted)" }}>{label}</span>
      <span className={cn(mono && "font-mono")} style={{ color: "var(--fg)" }}>{value}</span>
    </div>
  );
}

function ActionButton({ icon: Icon, label, destructive, onClick }: { icon: typeof Pause; label: string; destructive?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors"
      style={{
        borderColor: destructive ? "var(--destructive)" : "var(--border)",
        color: destructive ? "var(--destructive)" : "var(--fg-secondary)",
      }}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

function getStatusStyle(status: string) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    running: { bg: "var(--accent-subtle)", fg: "var(--accent)", label: "Running" },
    active: { bg: "var(--success-subtle)", fg: "var(--success)", label: "Active" },
    idle: { bg: "var(--bg-muted)", fg: "var(--fg-muted)", label: "Idle" },
    paused: { bg: "var(--warning-subtle)", fg: "var(--warning)", label: "Paused" },
    error: { bg: "var(--destructive-subtle)", fg: "var(--destructive)", label: "Error" },
  };
  return map[status] || map.idle;
}

function getAdapterLabel(type: string) {
  const labels: Record<string, string> = {
    claude_local: "Claude", codex_local: "Codex", cursor_local: "Cursor",
    gemini_local: "Gemini", opencode_local: "OpenCode", ollama_local: "Ollama", process: "Process",
  };
  return labels[type] || type;
}
