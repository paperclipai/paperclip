import { useState, useCallback } from "react";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { tauriInvoke } from "@/api/tauri-client";
import { companiesApi } from "@/api/companies";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import {
  Building2,
  Bot,
  ClipboardList,
  Rocket,
  ArrowLeft,
  ArrowRight,
  Loader2,
  Check,
  Sparkles,
  Globe,
  Hammer,
  FileJson,
} from "lucide-react";

const ADAPTER_OPTIONS = [
  {
    value: "ollama_local",
    label: "Ollama (Free)",
    desc: "Free local models",
  },
  {
    value: "claude_local",
    label: "Claude Code",
    desc: "Anthropic CLI agent",
  },
  { value: "codex_local", label: "Codex", desc: "OpenAI CLI agent" },
  { value: "cursor_local", label: "Cursor", desc: "Cursor AI agent" },
  {
    value: "gemini_local",
    label: "Gemini CLI",
    desc: "Google CLI agent",
  },
  {
    value: "opencode_local",
    label: "OpenCode",
    desc: "Open-source agent",
  },
  {
    value: "process",
    label: "Process",
    desc: "Custom shell process",
  },
] as const;

function generatePrefix(name: string): string {
  const alpha = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return alpha.slice(0, Math.min(4, Math.max(3, alpha.length))).slice(0, 4);
}

const STEPS = [
  { icon: Building2, label: "Company" },
  { icon: Bot, label: "Agent" },
  { icon: ClipboardList, label: "Task" },
  { icon: Rocket, label: "Launch" },
] as const;

export function OnboardingWizard() {
  const queryClient = useQueryClient();
  const [path, setPath] = useState<"choose" | "pick_adapter" | "scratch" | "importing" | "import_json">("choose");
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [selectedAdapter, setSelectedAdapter] = useState<string>("");
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importJson, setImportJson] = useState("");
  const [importLabel, setImportLabel] = useState("");

  // Step 1: Company
  const [companyName, setCompanyName] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);

  // Step 2: Agent
  const [agentName, setAgentName] = useState("CEO");
  const [adapterType, setAdapterType] = useState("claude_local");
  const [agentId, setAgentId] = useState<string | null>(null);

  // Step 3: Task
  const [taskTitle, setTaskTitle] = useState(
    "Hire your first engineer and create a hiring plan",
  );
  const [taskDescription, setTaskDescription] = useState("");

  const handleNext = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (step === 0) {
        // Create company
        const prefix = generatePrefix(companyName);
        if (!companyName.trim()) {
          setError("Company name is required");
          setBusy(false);
          return;
        }
        const company = await companiesApi.create({
          name: companyName.trim(),
          issue_prefix: prefix || "COMP",
        });
        setCompanyId(company.id);
        try {
          localStorage.setItem("archonos.selectedCompanyId", company.id);
        } catch {
          /* ignore */
        }
        queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
        setStep(1);
      } else if (step === 1) {
        // Create agent
        if (!companyId) {
          setError("Company not created yet");
          setBusy(false);
          return;
        }
        if (!agentName.trim()) {
          setError("Agent name is required");
          setBusy(false);
          return;
        }
        const agent = await agentsApi.create(companyId, {
          name: agentName.trim(),
          role: "ceo",
          adapter_type: adapterType,
        });
        setAgentId(agent.id);
        setStep(2);
      } else if (step === 2) {
        // Just advance — task is staged for step 3
        if (!taskTitle.trim()) {
          setError("Task title is required");
          setBusy(false);
          return;
        }
        setStep(3);
      } else if (step === 3) {
        // Launch: create project + issue
        if (!companyId || !agentId) {
          setError("Missing company or agent");
          setBusy(false);
          return;
        }
        const project = await projectsApi.create(companyId, {
          name: "First Project",
        });
        await issuesApi.create(companyId, {
          title: taskTitle.trim(),
          description: taskDescription.trim() || undefined,
          assignee_agent_id: agentId,
          project_id: project.id,
        });
        queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
        window.location.href = "/issues";
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [
    step,
    companyName,
    companyId,
    agentName,
    adapterType,
    agentId,
    taskTitle,
    taskDescription,
    queryClient,
  ]);

  const canNext =
    (step === 0 && companyName.trim().length > 0) ||
    (step === 1 && agentName.trim().length > 0) ||
    (step === 2 && taskTitle.trim().length > 0) ||
    step === 3;

  const importMutation = useMutation({
    mutationFn: async (action: { type: "bundled"; template: string } | { type: "github"; url: string } | { type: "json"; data: string }) => {
      if (action.type === "bundled") return companiesApi.importBundled(action.template, (action as any).adapterType, (action as any).adapterConfig);
      if (action.type === "github") return companiesApi.importFromGithub(action.url);
      return companiesApi.importJson(action.data);
    },
    onSuccess: (company) => {
      try { localStorage.setItem("archonos.selectedCompanyId", company.id); } catch { /* ignore */ }
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      window.location.href = "/dashboard";
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
      setPath("choose");
    },
  });

  const handleImportBundled = () => {
    setError(null);
    setSelectedTemplate("creator_business_os");
    setPath("pick_adapter");
  };

  const handleImportGithub = () => {
    setError(null);
    setImportLabel("Importing Agency Agents from GitHub...");
    setPath("importing");
    importMutation.mutate({ type: "github", url: "https://github.com/paperclipai/companies/tree/main/agency-agents" });
  };

  const handleImportJson = () => {
    if (!importJson.trim()) {
      setError("Paste a company JSON export first");
      return;
    }
    setError(null);
    setImportLabel("Importing company...");
    setPath("importing");
    importMutation.mutate({ type: "json", data: importJson });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "var(--bg)" }}
    >
      <div
        className="w-full max-w-[560px] rounded-lg border p-8"
        style={{
          background: "var(--card-bg)",
          borderColor: "var(--card-border)",
          boxShadow: "var(--shadow-3)",
        }}
      >
        {/* Choice screen */}
        {path === "choose" && (
          <>
            <h2
              className="mb-1 text-center text-lg font-semibold"
              style={{ color: "var(--fg)" }}
            >
              Get started with ArchonOS
            </h2>
            <p
              className="mb-6 text-center text-sm"
              style={{ color: "var(--fg-muted)" }}
            >
              Choose a starting point for your agent company.
            </p>

            {error && (
              <p className="mb-4 text-center text-sm" style={{ color: "var(--destructive)" }}>
                {error}
              </p>
            )}

            <div className="flex flex-col gap-3">
              {/* Creator Business OS */}
              <button
                type="button"
                onClick={handleImportBundled}
                className="flex items-start gap-4 rounded-lg border p-4 text-left transition-colors hover:border-[var(--accent)]"
                style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}
              >
                <div
                  className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: "var(--accent-subtle)" }}
                >
                  <Sparkles size={20} style={{ color: "var(--accent)" }} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold" style={{ color: "var(--fg)" }}>
                      Creator Business OS
                    </span>
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                      style={{ background: "var(--accent-subtle)", color: "var(--accent)" }}
                    >
                      Recommended
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs" style={{ color: "var(--fg-muted)" }}>
                    Pre-built team for coaches, creators, marketers &amp; thought leaders. 22 agents, 5 departments, ready to go.
                  </p>
                </div>
              </button>

              {/* Agency Agents */}
              <button
                type="button"
                onClick={handleImportGithub}
                className="flex items-start gap-4 rounded-lg border p-4 text-left transition-colors hover:border-[var(--accent)]"
                style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}
              >
                <div
                  className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: "var(--bg-muted)" }}
                >
                  <Globe size={20} style={{ color: "var(--fg-secondary)" }} />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-semibold" style={{ color: "var(--fg)" }}>
                    Agency Agents (Open Source)
                  </span>
                  <p className="mt-0.5 text-xs" style={{ color: "var(--fg-muted)" }}>
                    Paperclip's reference agent team from the open-source community.
                  </p>
                </div>
              </button>

              {/* Start from Scratch */}
              <button
                type="button"
                onClick={() => { setError(null); setPath("scratch"); }}
                className="flex items-start gap-4 rounded-lg border p-4 text-left transition-colors hover:border-[var(--accent)]"
                style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}
              >
                <div
                  className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: "var(--bg-muted)" }}
                >
                  <Hammer size={20} style={{ color: "var(--fg-secondary)" }} />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-semibold" style={{ color: "var(--fg)" }}>
                    Start from Scratch
                  </span>
                  <p className="mt-0.5 text-xs" style={{ color: "var(--fg-muted)" }}>
                    Build your own company step by step.
                  </p>
                </div>
              </button>
            </div>

            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => { setError(null); setPath("import_json"); }}
                className="text-xs underline"
                style={{ color: "var(--fg-muted)" }}
              >
                Or import a company JSON file
              </button>
            </div>
          </>
        )}

        {/* Adapter picker for template imports */}
        {path === "pick_adapter" && (
          <div className="space-y-4">
            <button onClick={() => setPath("choose")} className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--fg-muted)" }}>
              <ArrowLeft size={14} /> Back
            </button>
            <h2 className="text-lg font-semibold">Choose your AI provider</h2>
            <p className="text-[13px]" style={{ color: "var(--fg-muted)" }}>
              All 22 agents will use whichever provider you pick. You can change individual agents later.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {ADAPTER_OPTIONS.filter(o => o.value !== "process").map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setSelectedAdapter(opt.value)}
                  className="rounded-lg border p-3 text-left transition-all"
                  style={{
                    borderColor: selectedAdapter === opt.value ? "var(--accent)" : "var(--card-border)",
                    background: selectedAdapter === opt.value ? "var(--accent-subtle)" : "var(--card-bg)",
                  }}
                >
                  <div className="text-[13px] font-medium">{opt.label}</div>
                  <div className="text-[11px]" style={{ color: "var(--fg-muted)" }}>{opt.desc}</div>
                </button>
              ))}
            </div>
            <div className="flex justify-end pt-2">
              <button
                onClick={() => {
                  setImportLabel("Setting up Creator Business OS with " + (ADAPTER_OPTIONS.find(o => o.value === selectedAdapter)?.label || selectedAdapter) + "...");
                  setPath("importing");
                  importMutation.mutate({
                    type: "bundled",
                    template: selectedTemplate,
                    adapterType: selectedAdapter || undefined,
                    adapterConfig: undefined,
                  } as any);
                }}
                disabled={!selectedAdapter}
                className="rounded-md px-4 py-2 text-[13px] font-medium disabled:opacity-40"
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
              >
                Set Up Company
              </button>
            </div>
          </div>
        )}

        {/* Loading state */}
        {path === "importing" && (
          <div className="flex flex-col items-center gap-4 py-16">
            <Loader2 className="h-8 w-8 animate-spin" style={{ color: "var(--accent)" }} />
            <p className="text-[15px] font-medium" style={{ color: "var(--fg)" }}>{importLabel || "Setting up your company..."}</p>
            <p className="text-[12px]" style={{ color: "var(--fg-muted)" }}>This only takes a moment</p>
          </div>
        )}

        {/* Import JSON */}
        {path === "import_json" && (
          <>
            <h2
              className="mb-1 text-center text-lg font-semibold"
              style={{ color: "var(--fg)" }}
            >
              Import Company JSON
            </h2>
            <p className="mb-6 text-center text-sm" style={{ color: "var(--fg-muted)" }}>
              Paste the contents of a company export JSON file.
            </p>
            <textarea
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
              rows={10}
              placeholder='{"schema": "archonos/v3", "company": {...}, ...}'
              autoFocus
              className="w-full resize-none rounded-md border px-3 py-2 font-mono text-xs outline-none transition-colors focus:ring-2"
              style={{
                background: "var(--input-bg)",
                borderColor: "var(--input-border)",
                color: "var(--fg)",
                // @ts-expect-error CSS custom property
                "--tw-ring-color": "var(--accent)",
              }}
            />
            {error && (
              <p className="mt-2 text-center text-sm" style={{ color: "var(--destructive)" }}>
                {error}
              </p>
            )}
            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                onClick={() => { setError(null); setPath("choose"); }}
                className="flex items-center gap-1 rounded-md px-3 py-2 text-sm transition-colors"
                style={{ color: "var(--fg-secondary)" }}
              >
                <ArrowLeft size={14} />
                Back
              </button>
              <button
                type="button"
                onClick={handleImportJson}
                className="flex items-center gap-1 rounded-md px-4 py-2 text-sm font-medium transition-colors"
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
              >
                <FileJson size={14} />
                Import
              </button>
            </div>
          </>
        )}

        {/* Existing 4-step wizard */}
        {path === "scratch" && (
          <>
            {/* Step indicator */}
            <div className="mb-8 flex items-center justify-center gap-2">
              {STEPS.map((s, i) => {
                const Icon = s.icon;
                const isActive = i === step;
                const isDone = i < step;
                return (
                  <div key={s.label} className="flex items-center gap-2">
                    {i > 0 && (
                      <div
                        className="h-px w-8"
                        style={{
                          background: isDone
                            ? "var(--accent)"
                            : "var(--border)",
                        }}
                      />
                    )}
                    <div
                      className="flex h-8 w-8 items-center justify-center rounded-full transition-colors"
                      style={{
                        background: isActive
                          ? "var(--accent)"
                          : isDone
                            ? "var(--accent-subtle)"
                            : "var(--bg-muted)",
                        color: isActive
                          ? "var(--accent-fg)"
                          : isDone
                            ? "var(--accent)"
                            : "var(--fg-muted)",
                      }}
                    >
                      {isDone ? <Check size={14} /> : <Icon size={14} />}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Title */}
            <h2
              className="mb-1 text-center text-lg font-semibold"
              style={{ color: "var(--fg)" }}
            >
              {step === 0 && "Name your organization"}
              {step === 1 && "Create your first agent"}
              {step === 2 && "Define the first task"}
              {step === 3 && "Ready to launch"}
            </h2>
            <p
              className="mb-6 text-center text-sm"
              style={{ color: "var(--fg-muted)" }}
            >
              {step === 0 && "This will be the top-level workspace for your agents."}
              {step === 1 && "Choose an AI adapter and give your CEO agent a name."}
              {step === 2 && "What should your agent work on first?"}
              {step === 3 &&
                "We'll create a project and assign the task to your agent."}
            </p>

            {/* Step content */}
            <div className="min-h-[180px]">
              {step === 0 && (
                <div>
                  <label
                    className="mb-1 block text-sm font-medium"
                    style={{ color: "var(--fg-secondary)" }}
                  >
                    Company name
                  </label>
                  <input
                    type="text"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="Acme Corp"
                    autoFocus
                    className="w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors focus:ring-2"
                    style={{
                      background: "var(--input-bg)",
                      borderColor: "var(--input-border)",
                      color: "var(--fg)",
                      // @ts-expect-error CSS custom property
                      "--tw-ring-color": "var(--accent)",
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canNext) handleNext();
                    }}
                  />
                  {companyName.trim() && (
                    <p
                      className="mt-2 text-xs"
                      style={{ color: "var(--fg-muted)" }}
                    >
                      Issue prefix:{" "}
                      <span className="font-mono font-semibold">
                        {generatePrefix(companyName) || "COMP"}
                      </span>
                    </p>
                  )}
                </div>
              )}

              {step === 1 && (
                <div>
                  <label
                    className="mb-1 block text-sm font-medium"
                    style={{ color: "var(--fg-secondary)" }}
                  >
                    Agent name
                  </label>
                  <input
                    type="text"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    placeholder="CEO"
                    autoFocus
                    className="mb-4 w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors focus:ring-2"
                    style={{
                      background: "var(--input-bg)",
                      borderColor: "var(--input-border)",
                      color: "var(--fg)",
                      // @ts-expect-error CSS custom property
                      "--tw-ring-color": "var(--accent)",
                    }}
                  />
                  <label
                    className="mb-2 block text-sm font-medium"
                    style={{ color: "var(--fg-secondary)" }}
                  >
                    Adapter
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {ADAPTER_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setAdapterType(opt.value)}
                        className="rounded-md border px-3 py-2 text-left transition-colors"
                        style={{
                          background:
                            adapterType === opt.value
                              ? "var(--accent-subtle)"
                              : "var(--bg-muted)",
                          borderColor:
                            adapterType === opt.value
                              ? "var(--accent)"
                              : "var(--border)",
                        }}
                      >
                        <div
                          className="flex items-center gap-1.5 text-sm font-medium"
                          style={{
                            color:
                              adapterType === opt.value
                                ? "var(--accent)"
                                : "var(--fg)",
                          }}
                        >
                          {opt.label}
                          {opt.value === "ollama_local" && (
                            <span className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold" style={{ background: "var(--success-subtle)", color: "var(--success)" }}>
                              FREE
                            </span>
                          )}
                        </div>
                        <div
                          className="text-xs"
                          style={{ color: "var(--fg-muted)" }}
                        >
                          {opt.desc}
                        </div>
                      </button>
                    ))}
                  </div>
                  {adapterType && (
                    <AuthStatusBanner adapterType={adapterType} />
                  )}
                </div>
              )}

              {step === 2 && (
                <div>
                  <label
                    className="mb-1 block text-sm font-medium"
                    style={{ color: "var(--fg-secondary)" }}
                  >
                    Task title
                  </label>
                  <input
                    type="text"
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                    placeholder="Hire your first engineer..."
                    autoFocus
                    className="mb-4 w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors focus:ring-2"
                    style={{
                      background: "var(--input-bg)",
                      borderColor: "var(--input-border)",
                      color: "var(--fg)",
                      // @ts-expect-error CSS custom property
                      "--tw-ring-color": "var(--accent)",
                    }}
                  />
                  <label
                    className="mb-1 block text-sm font-medium"
                    style={{ color: "var(--fg-secondary)" }}
                  >
                    Description{" "}
                    <span style={{ color: "var(--fg-muted)" }}>(optional)</span>
                  </label>
                  <textarea
                    value={taskDescription}
                    onChange={(e) => setTaskDescription(e.target.value)}
                    rows={4}
                    placeholder="Add details about the task..."
                    className="w-full resize-none rounded-md border px-3 py-2 text-sm outline-none transition-colors focus:ring-2"
                    style={{
                      background: "var(--input-bg)",
                      borderColor: "var(--input-border)",
                      color: "var(--fg)",
                      // @ts-expect-error CSS custom property
                      "--tw-ring-color": "var(--accent)",
                    }}
                  />
                </div>
              )}

              {step === 3 && (
                <div
                  className="flex flex-col items-center justify-center gap-4 py-4"
                  style={{ color: "var(--fg-secondary)" }}
                >
                  <Rocket size={48} style={{ color: "var(--accent)" }} />
                  <div className="space-y-1 text-center text-sm">
                    <p>
                      <span className="font-semibold">{companyName}</span> will be
                      created with agent{" "}
                      <span className="font-semibold">{agentName}</span>.
                    </p>
                    <p>
                      Task:{" "}
                      <span className="font-medium italic">&ldquo;{taskTitle}&rdquo;</span>
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Error */}
            {error && (
              <p
                className="mt-2 text-center text-sm"
                style={{ color: "var(--destructive)" }}
              >
                {error}
              </p>
            )}

            {/* Navigation */}
            <div className="mt-6 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  if (step === 0) {
                    setPath("choose");
                  } else {
                    setStep((s) => Math.max(0, s - 1));
                  }
                }}
                disabled={busy}
                className="flex items-center gap-1 rounded-md px-3 py-2 text-sm transition-colors disabled:opacity-30"
                style={{ color: "var(--fg-secondary)" }}
              >
                <ArrowLeft size={14} />
                Back
              </button>
              <button
                type="button"
                onClick={handleNext}
                disabled={!canNext || busy}
                className="flex items-center gap-1 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
                style={{
                  background: "var(--accent)",
                  color: "var(--accent-fg)",
                }}
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                {step === 3 ? "Launch" : "Next"}
                {step < 3 && <ArrowRight size={14} />}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function getAuthLabel(adapterType: string, status: { logged_in: boolean; subscription_type: string | null }) {
  if (adapterType === "ollama_local") {
    return status.logged_in ? "Ready \u00B7 Free \u00B7 Local" : "Setup needed";
  }
  return status.logged_in
    ? `Connected${status.subscription_type ? ` (${status.subscription_type})` : ""}`
    : "Not logged in";
}

function getLoginButtonLabel(adapterType: string) {
  if (adapterType === "ollama_local") return "Download Gemma 4";
  const labels: Record<string, string> = {
    claude_local: "Login with Claude",
    codex_local: "Login with ChatGPT",
    cursor_local: "Login with Cursor",
    gemini_local: "Login with Gemini",
  };
  return labels[adapterType] || "Login";
}

function AuthStatusBanner({ adapterType }: { adapterType: string }) {
  const { data: authStatus } = useQuery({
    queryKey: ["adapter-auth", adapterType],
    queryFn: () => tauriInvoke<{ cli_installed: boolean; logged_in: boolean; subscription_type: string | null; email: string | null; error: string | null }>("check_adapter_auth", { adapterType }),
    enabled: !!adapterType,
  });

  const queryClient = useQueryClient();
  const loginMutation = useMutation({
    mutationFn: () => tauriInvoke<{ success: boolean; message: string }>("adapter_login", { adapterType }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["adapter-auth", adapterType] }),
  });

  if (!authStatus) return null;

  const adapterLabel = { claude_local: "Claude", codex_local: "Codex (ChatGPT)", cursor_local: "Cursor", gemini_local: "Gemini", opencode_local: "OpenCode", ollama_local: "Ollama", process: "Custom" }[adapterType] || adapterType;
  const isOllama = adapterType === "ollama_local";

  return (
    <div className="mt-3 rounded-lg border p-3" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
      {authStatus.logged_in ? (
        <div className="flex items-center gap-2 text-[13px]">
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--success)" }} />
          <span>{getAuthLabel(adapterType, authStatus)}</span>
          {isOllama ? (
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: "var(--success-subtle)", color: "var(--success)" }}>
              Free &middot; Local
            </span>
          ) : authStatus.subscription_type && (
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium capitalize" style={{ background: "var(--accent-subtle)", color: "var(--accent)" }}>
              {authStatus.subscription_type}
            </span>
          )}
        </div>
      ) : authStatus.cli_installed ? (
        <div className="flex items-center gap-2 text-[13px]">
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--warning)" }} />
          {loginMutation.isPending ? (
            <span style={{ color: "var(--fg-muted)" }}>{isOllama ? "Downloading model..." : "Complete login in your browser..."}</span>
          ) : (
            <>
              <span>{getAuthLabel(adapterType, authStatus)}</span>
              <button
                onClick={() => loginMutation.mutate()}
                className="rounded-md px-2.5 py-1 text-[12px] font-medium"
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
              >
                {getLoginButtonLabel(adapterType)}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[13px]">
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--destructive)" }} />
          {isOllama ? (
            <span>
              <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: "var(--accent)" }}>
                Download from ollama.com
              </a>
            </span>
          ) : (
            <span>{adapterLabel} CLI not installed</span>
          )}
        </div>
      )}
    </div>
  );
}
