import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronDown, Plus, RotateCcw, Search, X, Zap } from "lucide-react";
import type { Agent, IssueAssigneeAdapterOverrides } from "@paperclipai/shared";
import { agentsApi, type AdapterModel } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type { InlineEntityOption } from "@/components/InlineEntitySelector";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  composerCatalogProvider, composerEfforts, composerFastAvailable, DEFAULT_COMPOSER_RUN_SETTINGS,
  EFFORT_LABELS, readComposerRunSettings, supportsComposerModel,
  type ComposerRunSettings,
} from "./composer-run-settings";
import "./composer-run-settings.css";

interface Props {
  companyId: string;
  assigneeValue: string;
  currentAssigneeValue: string;
  options: InlineEntityOption[];
  agents: ReadonlyMap<string, Agent>;
  overrides?: IssueAssigneeAdapterOverrides | null;
  settings: ComposerRunSettings | null;
  onSettingsChange: (settings: ComposerRunSettings) => void;
  onAssigneeChange: (value: string) => void;
  disabled?: boolean;
  mobile?: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
  /** Storybook can supply a fixed catalog; the app loads it for the selected harness. */
  modelOptionsOverride?: readonly (AdapterModel & { detail?: string })[];
  renderAssigneeIdentity?: (value: string, label: string, placement: "trigger" | "option") => ReactNode;
  /** Initial presentation state for embedded examples; ordinary composers start closed. */
  initialOpen?: boolean;
  initialView?: "settings" | "agents" | "models";
  initialModelSearch?: string;
  initialAssigneeSearch?: string;
}

const HARNESS_LABELS: Record<string, string> = {
  claude_local: "Claude Code", codex_local: "Codex", opencode_local: "OpenCode",
  pi_local: "Pi", kimi_local: "Kimi Code", gemini_local: "Gemini CLI",
  cursor: "Cursor", cursor_cloud: "Cursor Cloud", grok_local: "Grok CLI",
  hermes_local: "Hermes CLI", paperclip_runner: "Paperclip Runner",
  process: "Process", http: "HTTP", openclaw_gateway: "OpenClaw Gateway",
  hermes_gateway: "Hermes Gateway",
};

function harnessLabel(agent: Agent | undefined): string {
  if (!agent) return "Choose an agent";
  const harness = HARNESS_LABELS[agent.adapterType] ?? agent.adapterType;
  const provider = composerCatalogProvider(agent);
  return provider === "openrouter" ? `${harness} · OpenRouter` : harness;
}

function unavailableModelReason(agent: Agent | undefined): string {
  if (!agent) return "Choose an agent to select its model and effort.";
  if (agent?.adapterType === "process") return "This agent runs a command. Its harness does not expose a model or effort setting.";
  if (agent?.adapterType === "http") return "This agent calls an HTTP endpoint. The destination service chooses its model.";
  return "This gateway chooses its model remotely; Paperclip has no per-task model setting for it.";
}

function AnimatedBody({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div className="composer-run-settings-height" style={{ height: height ?? "auto" }}><div ref={ref}>{children}</div></div>;
}

export function ComposerRunSettingsPicker({
  companyId, assigneeValue, currentAssigneeValue, options, agents, overrides,
  settings, onSettingsChange, onAssigneeChange, disabled = false, mobile: mobileProp, triggerRef, modelOptionsOverride, renderAssigneeIdentity,
  initialOpen = false, initialView = "settings", initialModelSearch = "", initialAssigneeSearch = "",
}: Props) {
  const [open, setOpen] = useState(initialOpen);
  const [view, setView] = useState<"settings" | "agents" | "models">(initialView);
  const [modelSearch, setModelSearch] = useState(initialModelSearch);
  const [assigneeSearch, setAssigneeSearch] = useState(initialAssigneeSearch);
  const [highlightedAssignee, setHighlightedAssignee] = useState(0);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 639px)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const mobile = mobileProp ?? narrow;
  const agentId = assigneeValue.startsWith("agent:") ? assigneeValue.slice(6) : "";
  const agent = agents.get(agentId);
  const modelSupported = supportsComposerModel(agent);
  const provider = composerCatalogProvider(agent);
  const { data: fetchedModels = [], isPending: modelsPending } = useQuery({
    queryKey: agent && modelSupported
      ? queryKeys.agents.adapterModels(companyId, agent.adapterType, agent.defaultEnvironmentId ?? null, provider)
      : ["agents", "composer-models", "none"],
    queryFn: () => agentsApi.adapterModels(companyId, agent!.adapterType, {
      environmentId: agent!.defaultEnvironmentId ?? null, provider,
    }),
    enabled: Boolean(agent && modelSupported && !modelOptionsOverride),
  });
  // The server resolves instance-declared models first and otherwise returns the
  // adapter's curated catalog. Do not replace a declared Codex list locally.
  const models: readonly (AdapterModel & { detail?: string })[] = modelOptionsOverride
    ?? fetchedModels;
  const catalogPending = modelsPending && !modelOptionsOverride;
  const base = assigneeValue === currentAssigneeValue
    ? readComposerRunSettings(overrides, agent?.adapterType)
    : DEFAULT_COMPOSER_RUN_SETTINGS;
  const selected = settings ?? base;
  const configuredModel = typeof agent?.adapterConfig.model === "string" ? agent.adapterConfig.model : "";
  const model = selected.model ?? configuredModel;
  const modelName = models.find((item) => item.id === model)?.label ?? model ?? "";
  const choices = composerEfforts(agent, model, models.map((item) => item.id));
  const effort = selected.effort && choices.includes(selected.effort) ? selected.effort : null;
  const effortIndex = effort ? choices.indexOf(effort) + 1 : 0;
  const effortLabel = effort ? EFFORT_LABELS[effort] ?? effort : "Default";
  const fastAvailable = composerFastAvailable(agent, model);
  const changed = Boolean(selected.model || selected.effort || selected.fast);
  const assigneeOptions = [{ id: "", label: "No assignee", searchText: "Unassigned" }, ...options.filter((item) => item.id !== "")];
  const filteredAgents = assigneeOptions.filter((item) => {
    const optionAgent = agents.get(item.id.startsWith("agent:") ? item.id.slice(6) : "");
    return `${item.label} ${item.searchText ?? ""} ${optionAgent?.role ?? ""} ${harnessLabel(optionAgent)}`
      .toLowerCase().includes(assigneeSearch.trim().toLowerCase());
  });
  const query = modelSearch.trim();
  const filteredModels = models.filter((item) =>
    `${item.label} ${item.id}`.toLowerCase().includes(query.toLowerCase()));
  const exactMatch = models.some((item) => item.id.toLowerCase() === query.toLowerCase());
  const needsProvider = agent && (["opencode_local", "pi_local", "kimi_local"].includes(agent.adapterType)
    || (agent.adapterType === "paperclip_runner" && provider === "opencode"));
  const manualValid = query.length > 0 && !/\s/.test(query)
    && (!needsProvider || /^[^/]+\/.+[^/]$/.test(query))
    && (provider !== "openrouter" || /^openrouter\/[^/]+\/.+[^/]$/.test(query));

  const previousAgentId = useRef(agentId);
  useEffect(() => {
    if (previousAgentId.current === agentId) return;
    previousAgentId.current = agentId;
    setView("settings");
    setModelSearch("");
    setAssigneeSearch("");
  }, [agentId]);

  const chooseAssignee = (value: string) => {
    if (value !== assigneeValue) {
      onAssigneeChange(value);
      onSettingsChange(DEFAULT_COMPOSER_RUN_SETTINGS);
    }
    setView("settings");
    setAssigneeSearch("");
  };
  const chooseModel = (value: string | null) => {
    onSettingsChange({ model: value, effort: null, fast: false });
    setView("settings");
    setModelSearch("");
  };
  const reset = () => onSettingsChange(DEFAULT_COMPOSER_RUN_SETTINGS);
  const closeButton = mobile ? <DialogClose asChild><button type="button" aria-label="Close picker" className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent"><X className="size-4" /></button></DialogClose> : null;
  const trigger = <button ref={triggerRef} type="button" disabled={disabled} aria-label="Select assignee, model and effort" data-testid="task-chat-composer-assignee"
    className="flex h-8 min-w-0 max-w-64 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
    {renderAssigneeIdentity?.(assigneeValue, agent?.name ?? "Unassigned", "trigger")}
    <span className="max-w-24 truncate">{assigneeOptions.find((item) => item.id === assigneeValue)?.label ?? "Unassigned"}</span>
    <span className="text-muted-foreground" aria-hidden>·</span><span className="min-w-0 truncate text-muted-foreground">{modelSupported ? modelName || "Harness default" : "Harness default"}</span>
    {effort ? <span className="hidden shrink-0 text-muted-foreground sm:inline">{effortLabel}</span> : null}
    <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
  </button>;

  const body = view === "settings" ? <div className="p-3">
    <div className="flex items-center gap-2">
      <button type="button" aria-label="Choose assignee" onClick={() => setView("agents")}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {renderAssigneeIdentity?.(assigneeValue, agent?.name ?? "Unassigned", "option") ?? <span className="grid size-6 shrink-0 place-items-center rounded-md bg-secondary text-xs font-semibold text-secondary-foreground">{agent?.name.slice(0, 1) ?? "?"}</span>}
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{agent?.name ?? options.find((item) => item.id === assigneeValue)?.label ?? "Unassigned"}</span><span className="block truncate text-xs text-muted-foreground">{harnessLabel(agent)}</span></span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {!choices.length && modelSupported ? <button type="button" aria-label="Reset to agent default" title="Reset to agent default" disabled={!changed} onClick={reset} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-40"><RotateCcw className="size-4" /></button> : null}
      {closeButton}
    </div>
    {modelSupported ? <>
      <button type="button" aria-label="Choose exact model" onClick={() => setView("models")} className="mt-3 flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">Model</span><span className="block truncate text-sm font-medium">{modelName || "Harness default"}</span></span><ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {choices.length ? <div className="mt-3">
        <div className="flex items-center gap-2">
          {fastAvailable ? <button type="button" aria-label="Fast mode" aria-pressed={selected.fast} title="Fast mode" onClick={() => onSettingsChange({ ...selected, fast: !selected.fast })} className={cn("grid size-8 shrink-0 place-items-center rounded-md hover:bg-accent", selected.fast ? "composer-run-settings-accent bg-accent" : "text-muted-foreground")}><Zap className="size-4" /></button> : <span className="size-8 shrink-0" aria-hidden />}
          <label htmlFor="composer-run-effort" data-testid="selected-effort" className="composer-run-settings-accent min-w-0 flex-1 text-center text-sm font-medium">{effortLabel}</label>
          <button type="button" aria-label="Reset to agent default" title="Reset to agent default" disabled={!changed} onClick={reset} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-40"><RotateCcw className="size-4" /></button>
        </div>
        <input id="composer-run-effort" type="range" min={0} max={choices.length} step={1} value={effortIndex} aria-label={agent?.adapterType === "pi_local" ? "Thinking" : "Effort"} aria-valuetext={effortLabel}
          onChange={(event) => onSettingsChange({ ...selected, effort: Number(event.target.value) === 0 ? null : choices[Number(event.target.value) - 1] })}
          className="composer-run-effort-range mt-3 w-full" style={{ "--fill": `${effortIndex / choices.length * 100}%` } as CSSProperties} />
      </div> : null}
    </> : <div className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-testid="model-unavailable">{unavailableModelReason(agent)}</div>}
  </div> : view === "agents" ? <div className="p-2">
    <div className="flex items-center gap-2 px-1 py-1.5"><button type="button" aria-label="Back to selection" onClick={() => setView("settings")} className="grid size-7 place-items-center rounded-md hover:bg-accent"><ArrowLeft className="size-4" /></button><span className="min-w-0 flex-1"><span className="block text-xs font-semibold">Choose assignee</span><span className="block truncate text-xs text-muted-foreground">Each agent keeps its configured harness.</span></span>{closeButton}</div>
    <div className="relative mt-2"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden /><input autoFocus type="search" aria-label="Search assignees" placeholder="Search assignees…" value={assigneeSearch} onChange={(event) => { setAssigneeSearch(event.target.value); setHighlightedAssignee(0); }} onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setHighlightedAssignee((current) => filteredAgents.length ? (current + (event.key === "ArrowDown" ? 1 : -1) + filteredAgents.length) % filteredAgents.length : 0); }
      if (event.key === "Enter" && filteredAgents.length) { event.preventDefault(); chooseAssignee(filteredAgents[Math.min(highlightedAssignee, filteredAgents.length - 1)]!.id); }
    }} className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" /></div>
    <div className="mt-2 max-h-60 overflow-y-auto" role="listbox" aria-label="Assignees">{filteredAgents.map((item, index) => <button key={item.id} type="button" role="option" aria-selected={item.id === assigneeValue} onMouseEnter={() => setHighlightedAssignee(index)} onClick={() => chooseAssignee(item.id)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left focus-visible:outline-none", highlightedAssignee === index ? "bg-accent" : "hover:bg-accent")}>{renderAssigneeIdentity?.(item.id, item.label, "option")}<span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.label}</span><span className="block truncate text-xs text-muted-foreground">{agents.get(item.id.startsWith("agent:") ? item.id.slice(6) : "")?.role ?? ""}</span></span><span className="truncate text-xs text-muted-foreground">{harnessLabel(agents.get(item.id.startsWith("agent:") ? item.id.slice(6) : ""))}</span>{item.id === assigneeValue ? <Check className="composer-run-settings-accent size-4" /> : null}</button>)}{!filteredAgents.length ? <p className="px-2 py-2 text-xs text-muted-foreground">No matches.</p> : null}</div>
  </div> : <div className="p-2">
    <div className="flex items-center gap-2 px-1 py-1.5"><button type="button" aria-label="Back to selection" onClick={() => setView("settings")} className="grid size-7 place-items-center rounded-md hover:bg-accent"><ArrowLeft className="size-4" /></button><span className="min-w-0 flex-1"><span className="block text-xs font-semibold">Choose model</span><span className="block truncate text-xs text-muted-foreground">{harnessLabel(agent)}</span></span>{closeButton}</div>
    <div className="relative mt-2"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden /><input autoFocus type="search" aria-label="Search or paste a model ID" placeholder="Search or paste a model ID" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && manualValid && !exactMatch) chooseModel(query); }} className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" /></div>
    <div className="mt-2 max-h-60 overflow-y-auto" role="listbox" aria-label="Models">
      {!query ? <button type="button" role="option" aria-selected={selected.model === null} onClick={() => chooseModel(null)} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-accent"><span className="min-w-0 flex-1"><span className="block text-sm font-medium">Use agent default</span><span className="block truncate text-xs text-muted-foreground">{models.find((item) => item.id === configuredModel)?.label || configuredModel || "Harness default"}</span></span>{selected.model === null ? <Check className="composer-run-settings-accent size-4" /> : null}</button> : null}
      {filteredModels.map((item) => <button type="button" role="option" aria-selected={selected.model === item.id} key={item.id} onClick={() => chooseModel(item.id)} className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"><span className="min-w-0 flex-1"><span className="block truncate font-medium">{item.label}</span><span className="block truncate font-mono text-xs text-muted-foreground">{item.id}</span></span>{item.detail || item.id === configuredModel ? <span className="shrink-0 text-xs text-muted-foreground">{item.detail ?? "Agent default"}</span> : null}{selected.model === item.id ? <Check className="composer-run-settings-accent size-4 shrink-0" /> : null}</button>)}
      {catalogPending ? <p className="px-2.5 py-2 text-xs text-muted-foreground">Loading models…</p> : null}
      {!catalogPending && !filteredModels.length && query ? <p className="px-2.5 py-2 text-xs text-muted-foreground">No catalog match.</p> : null}
    </div>
    {query && !exactMatch ? <div className="mt-2 border-t border-border pt-2"><button type="button" disabled={!manualValid} onClick={() => chooseModel(query)} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent disabled:opacity-40"><Plus className="size-4 shrink-0" aria-hidden /><span className="min-w-0 flex-1 truncate">Use exact ID <span className="font-mono font-semibold">{query}</span></span></button>{!manualValid ? <p className="px-2.5 text-xs text-destructive">{provider === "openrouter" ? "Use openrouter/provider/model with no spaces." : "Model IDs cannot contain spaces."}</p> : null}</div> : null}
    <p className="px-2.5 pb-1 pt-2 text-xs text-muted-foreground">{provider === "openrouter" ? "Custom IDs: openrouter/provider/model. Provider access is checked when the run starts." : "Custom model IDs can be pasted here. Provider access is checked when the run starts."}</p>
  </div>;

  const onOpenChange = (next: boolean) => { setOpen(next); if (!next) { setView("settings"); setModelSearch(""); setAssigneeSearch(""); } };
  return mobile ? <Dialog open={open} onOpenChange={onOpenChange}><DialogTrigger asChild>{trigger}</DialogTrigger><DialogContent aria-describedby={undefined} showCloseButton={false} className="composer-mobile-dialog top-(--pct-50) -translate-y-(--pct-50) gap-0 overflow-y-auto p-0" data-testid="composer-mobile-dialog"><DialogTitle className="sr-only">Select assignee, model and effort</DialogTitle><AnimatedBody>{body}</AnimatedBody></DialogContent></Dialog>
    : <Popover open={open} onOpenChange={onOpenChange}><PopoverTrigger asChild>{trigger}</PopoverTrigger><PopoverContent side="top" align="end" sideOffset={8} className="w-80 max-w-full p-0 shadow-sm" data-testid="composer-model-popover"><AnimatedBody>{body}</AnimatedBody></PopoverContent></Popover>;
}
