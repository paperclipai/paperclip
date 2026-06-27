import { useEffect } from "react";
import { ArrowRight, Bot, Braces, CheckCircle2, Database, FileCode2, GitBranch, Network, SearchCode, ServerCog, ShieldCheck } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";

const mcpTools = [
  {
    name: "index_repository",
    purpose: "Build or refresh the code graph for a project before deeper discovery.",
  },
  {
    name: "search_graph",
    purpose: "Find symbols, modules, and relationships without broad grep sweeps.",
  },
  {
    name: "trace_path",
    purpose: "Follow call/data paths across files to explain how a behavior is wired.",
  },
  {
    name: "get_code_snippet",
    purpose: "Pull a focused source excerpt after graph discovery identifies the right node.",
  },
  {
    name: "query_graph",
    purpose: "Ask structured questions over the indexed repository graph.",
  },
  {
    name: "search_code",
    purpose: "Fallback text/code search through the MCP surface when graph lookup is too narrow.",
  },
];

const flow = [
  {
    label: "Agent session",
    detail: "Codex / Claude worker asks a code-discovery question.",
    icon: Bot,
  },
  {
    label: "MCP bridge",
    detail: "Configured server: codebase-memory-mcp.",
    icon: ServerCog,
  },
  {
    label: "Code graph",
    detail: "Repository symbols, snippets, and relationship paths are queried.",
    icon: Network,
  },
  {
    label: "Focused evidence",
    detail: "Agent receives targeted files/snippets instead of noisy whole-repo scans.",
    icon: FileCode2,
  },
];

const guardrails = [
  "Read-only discovery surface; it should not mutate repositories or secrets.",
  "Run index_repository before trusting graph answers for a newly changed project.",
  "Use graph discovery to choose files, then verify claims with source/tests before acting.",
  "Treat MCP output as navigation evidence, not final proof of runtime behavior.",
];

export function McpVisualizer() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Dashboard", href: "/dashboard" },
      { label: "MCP Visualizer" },
    ]);
  }, [setBreadcrumbs]);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <section className="overflow-hidden rounded-[2rem] border border-slate-900/10 bg-[radial-gradient(circle_at_18%_18%,rgba(59,130,246,0.2),transparent_36%),linear-gradient(135deg,#07111f,#111827_58%,#172554)] p-6 text-white shadow-2xl">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs uppercase tracking-[0.24em] text-blue-100">
              <Network className="h-3.5 w-3.5" /> micro.fincli.ai / MCP map
            </div>
            <h1 className="text-3xl font-semibold tracking-tight md:text-5xl">Codebase MCP visualizer</h1>
            <p className="mt-3 text-sm leading-6 text-slate-200 md:text-base">
              Visual map of the GitHub-installed <code className="rounded bg-white/10 px-1.5 py-0.5">codebase-memory-mcp</code> bridge that gives agents graph-aware code discovery before they edit or debug fincli/Paperclip/CPS systems.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
              <div className="text-3xl font-semibold">1</div>
              <div className="text-xs uppercase tracking-wide text-slate-300">server</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
              <div className="text-3xl font-semibold">6</div>
              <div className="text-xs uppercase tracking-wide text-slate-300">tools</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
              <div className="text-3xl font-semibold">RO</div>
              <div className="text-xs uppercase tracking-wide text-slate-300">posture</div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <article className="rounded-3xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-blue-500" />
            <h2 className="text-xl font-semibold">Discovery flow</h2>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-4">
            {flow.map((step, index) => {
              const Icon = step.icon;
              return (
                <div key={step.label} className="relative rounded-2xl border border-border bg-muted/40 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="rounded-xl bg-background p-2 text-blue-500 shadow-sm">
                      <Icon className="h-5 w-5" />
                    </div>
                    {index < flow.length - 1 ? <ArrowRight className="hidden h-4 w-4 text-muted-foreground md:block" /> : null}
                  </div>
                  <h3 className="mt-4 font-semibold">{step.label}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{step.detail}</p>
                </div>
              );
            })}
          </div>
        </article>

        <article className="rounded-3xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <ServerCog className="h-5 w-5 text-emerald-500" />
            <h2 className="text-xl font-semibold">Installed endpoint</h2>
          </div>
          <dl className="mt-5 space-y-4 text-sm">
            <div className="rounded-2xl bg-muted/50 p-4">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">MCP server</dt>
              <dd className="mt-1 font-mono text-sm">codebase-memory-mcp</dd>
            </div>
            <div className="rounded-2xl bg-muted/50 p-4">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Command</dt>
              <dd className="mt-1 break-all font-mono text-sm">/root/.local/bin/codebase-memory-mcp</dd>
            </div>
            <div className="rounded-2xl bg-muted/50 p-4">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Agent config</dt>
              <dd className="mt-1 break-all font-mono text-sm">/root/.codex/config.toml</dd>
            </div>
          </dl>
        </article>
      </section>

      <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <article className="rounded-3xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-amber-500" />
            <h2 className="text-xl font-semibold">Operating guardrails</h2>
          </div>
          <ul className="mt-5 space-y-3">
            {guardrails.map((guardrail) => (
              <li key={guardrail} className="flex gap-3 rounded-2xl bg-muted/50 p-3 text-sm leading-6">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <span>{guardrail}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="rounded-3xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <SearchCode className="h-5 w-5 text-purple-500" />
            <h2 className="text-xl font-semibold">Tool surface</h2>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {mcpTools.map((tool) => (
              <div key={tool.name} className="rounded-2xl border border-border bg-muted/35 p-4">
                <div className="flex items-center gap-2 font-mono text-sm font-semibold">
                  <Braces className="h-4 w-4 text-purple-500" /> {tool.name}
                </div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{tool.purpose}</p>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-cyan-500" />
          <h2 className="text-xl font-semibold">Why this belongs on micro.fincli.ai</h2>
        </div>
        <p className="mt-3 max-w-4xl text-sm leading-6 text-muted-foreground">
          The micro control surface should show not just experiments and approvals, but the agent infrastructure that feeds them. This MCP view makes code-discovery capability visible: which bridge is installed, what tools it exposes, how agents should use it, and where the safety boundary sits before a worker touches Paperclip, CPS, or micro execution code.
        </p>
      </section>
    </div>
  );
}
