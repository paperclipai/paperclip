import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowLeft, ArrowUp, Check, ChevronDown, Plus, RotateCcw, Search, X, Zap } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ComposerAddMenu, ComposerModeChip } from "@/components/task-chat/ComposerAddMenu";
import { nextWorkMode } from "@/lib/work-mode-meta";
import type { IssueWorkMode } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { composerAgentAppearance, composerAgents, effortChoices, effortLabels, fastModeAvailable, modelLabel, type ComposerAgent } from "./fixtures";
import "./picker.css";

export type ComposerModelPickerPreviewProps = {
  agentId?: string;
  initialModel?: string;
  initialEffort?: string;
  initialFast?: boolean;
  initialPanel?: "closed" | "settings" | "models" | "agents";
  initialSearch?: string;
  initialAssigneeSearch?: string;
  initialMode?: IssueWorkMode;
  compact?: boolean;
};

type SentMessage = { text: string; agent: string; model: string | null; effort: string | null; fast: boolean };

function AgentMark({ agent, size = 24 }: { agent: ComposerAgent; size?: 16 | 24 }) {
  return <AgentAvatar agent={{ id: agent.id, name: agent.name, appearance: composerAgentAppearance(agent.id) }} size={size} />;
}

function ModelRow({ option, selected, onSelect }: {
  option: { id: string; label: string; detail?: string };
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button type="button" role="option" aria-selected={selected} onClick={() => onSelect(option.id)}
      className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{option.label}</span>
        <span className="block truncate font-mono text-xs text-muted-foreground">{option.id}</span>
      </span>
      {option.detail ? <span className="shrink-0 text-xs text-muted-foreground">{option.detail}</span> : null}
      {selected ? <Check className="composer-picker-accent size-4 shrink-0" aria-hidden /> : null}
    </button>
  );
}

function AnimatedPickerBody({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setHeight(content.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return <div className="composer-picker-auto-height" style={{ height: height ?? "auto" }} data-testid="picker-animated-body"><div ref={contentRef}>{children}</div></div>;
}

export function ComposerModelPickerPreview({
  agentId = "codex", initialModel, initialEffort, initialFast = false,
  initialPanel = "closed", initialSearch = "", initialAssigneeSearch = "", initialMode = "standard", compact = false,
}: ComposerModelPickerPreviewProps) {
  const [agent, setAgent] = useState<ComposerAgent>(composerAgents.find((item) => item.id === agentId) ?? composerAgents[0]);
  const [modelOverride, setModelOverride] = useState<string | null>(initialModel ?? null);
  const [effortOverride, setEffortOverride] = useState<string | null>(initialEffort ?? null);
  const [fast, setFast] = useState(initialFast);
  const [pickerOpen, setPickerOpen] = useState(initialPanel !== "closed");
  const [view, setView] = useState<"settings" | "models" | "agents">(initialPanel === "closed" ? "settings" : initialPanel);
  const [search, setSearch] = useState(initialSearch);
  const [assigneeSearch, setAssigneeSearch] = useState(initialAssigneeSearch);
  const [highlightedAssigneeIndex, setHighlightedAssigneeIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<IssueWorkMode>(initialMode);
  const [attachments, setAttachments] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [messages, setMessages] = useState<SentMessage[]>([]);
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const model = modelOverride ?? agent.defaultModel ?? "";
  const choices = effortChoices(agent, model);
  const effectiveEffort = effortOverride && choices.includes(effortOverride) ? effortOverride : null;
  const effortIndex = effectiveEffort ? choices.indexOf(effectiveEffort) + 1 : 0;
  const effortLabel = effectiveEffort ? effortLabels[effectiveEffort] ?? effectiveEffort : "Default";
  const fastAvailable = fastModeAvailable(agent, model);
  const modelAvailable = Boolean(agent.defaultModel || agent.models.length || agent.manualPattern);
  const query = search.trim();
  const filtered = agent.models.filter((option) =>
    `${option.label} ${option.id} ${option.detail ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  const filteredAssignees = composerAgents.filter((item) =>
    `${item.name} ${item.role} ${item.harness} ${item.provider ?? ""}`.toLowerCase().includes(assigneeSearch.trim().toLowerCase()),
  );
  const exactCatalogMatch = agent.models.some((option) => option.id.toLowerCase() === query.toLowerCase());
  const manualValid = query.length > 0 && !/\s/.test(query)
    && (agent.provider !== "OpenRouter" || query.startsWith("openrouter/"));

  function reset() {
    setModelOverride(null);
    setEffortOverride(null);
    setFast(false);
  }

  function chooseModel(next: string | null) {
    setModelOverride(next);
    setEffortOverride(null);
    setFast(false);
    setSearch("");
    setView("settings");
  }

  function chooseAgent(next: ComposerAgent) {
    setAgent(next);
    reset();
    setSearch("");
    setAssigneeSearch("");
    setHighlightedAssigneeIndex(0);
    setView("settings");
  }

  function send() {
    if (!draft.trim()) return;
    setMessages((current) => [...current, {
      text: draft.trim(), agent: agent.name, model: model || null,
      effort: effectiveEffort, fast: fast && fastAvailable,
    }]);
    setDraft("");
  }

  function handlePickerOpenChange(open: boolean) {
    setPickerOpen(open);
    if (!open) {
      setView("settings");
      setSearch("");
      setAssigneeSearch("");
      setHighlightedAssigneeIndex(0);
    }
  }

  const pickerTrigger = (
    <button type="button" aria-label="Select assignee, model and effort" className="flex h-8 min-w-0 max-w-64 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="composer-model-trigger">
      <AgentMark agent={agent} size={16} />
      <span className="max-w-20 shrink-0 truncate">{agent.name}</span>
      <span className="text-muted-foreground" aria-hidden>·</span>
      <span className="min-w-0 truncate text-muted-foreground">{modelAvailable ? modelLabel(agent, model) : "Default"}</span>
      {effectiveEffort ? <span className="hidden shrink-0 text-muted-foreground sm:inline">{effortLabel}</span> : null}
      <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );

  const mobileCloseButton = mobile ? <DialogClose asChild><button type="button" aria-label="Close picker" className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" aria-hidden /></button></DialogClose> : null;

  const pickerBody = (
    view === "settings" ? (
      <div className="p-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { setAssigneeSearch(""); setHighlightedAssigneeIndex(0); setView("agents"); }} aria-label="Choose assignee" className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <AgentMark agent={agent} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{agent.name}</span><span className="block truncate text-xs text-muted-foreground">{agent.harness}{agent.provider ? ` · ${agent.provider}` : ""}</span></span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
          {modelAvailable && !choices.length ? <button type="button" onClick={reset} aria-label="Reset to agent default" title="Reset to agent default" disabled={!modelOverride && !effortOverride && !fast} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"><RotateCcw className="size-4" aria-hidden /></button> : null}
          {mobileCloseButton}
        </div>
        {modelAvailable ? <button type="button" onClick={() => setView("models")} className="mt-3 flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Choose exact model">
          <span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">Model</span><span className="block truncate text-sm font-medium">{modelLabel(agent, model)}</span></span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button> : <div className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-testid="model-unavailable">{agent.noModelReason}</div>}
        {modelAvailable && choices.length ? (
          <div className="mt-3">
            <div className="flex items-center gap-2">
              {fastAvailable ? <button type="button" onClick={() => setFast((current) => !current)} aria-label="Fast mode" aria-pressed={fast} title="Fast mode · faster responses, higher usage" className={cn("grid size-8 shrink-0 place-items-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", fast ? "composer-picker-accent bg-accent" : "text-muted-foreground")}><Zap className="size-4" aria-hidden /></button> : <span className="size-8 shrink-0" aria-hidden />}
              <label htmlFor="composer-effort" className="composer-picker-accent min-w-0 flex-1 text-center text-sm font-medium" data-testid="selected-effort">{effortLabel}</label>
              <button type="button" onClick={reset} aria-label="Reset to agent default" title="Reset to agent default" disabled={!modelOverride && !effortOverride && !fast} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"><RotateCcw className="size-4" aria-hidden /></button>
            </div>
            <input id="composer-effort" type="range" min={0} max={choices.length} step={1} value={effortIndex}
              aria-label={agent.adapterType === "pi_local" ? "Thinking" : "Effort"} aria-valuetext={effortLabel} onChange={(event) => setEffortOverride(Number(event.target.value) === 0 ? null : choices[Number(event.target.value) - 1])}
              className="composer-effort-range mt-3 w-full" style={{ "--fill": `${(effortIndex / choices.length) * 100}%` } as CSSProperties} />
          </div>
        ) : null}
      </div>
    ) : view === "agents" ? (
      <div className="p-2" data-testid="composer-agent-menu">
        <div className="flex items-center gap-2 px-1 py-1.5"><button type="button" onClick={() => { setAssigneeSearch(""); setHighlightedAssigneeIndex(0); setView("settings"); }} aria-label="Back to selection" className="grid size-7 place-items-center rounded-md hover:bg-accent"><ArrowLeft className="size-4" aria-hidden /></button><div className="min-w-0 flex-1"><p className="text-xs font-semibold">Choose assignee</p><p className="truncate text-xs text-muted-foreground">Each agent keeps its configured harness.</p></div>{mobileCloseButton}</div>
        <div className="relative mt-2"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden /><input autoFocus type="search" value={assigneeSearch} onChange={(event) => { setAssigneeSearch(event.target.value); setHighlightedAssigneeIndex(0); }} onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setHighlightedAssigneeIndex((current) => filteredAssignees.length ? (current + (event.key === "ArrowDown" ? 1 : -1) + filteredAssignees.length) % filteredAssignees.length : 0); }
          if (event.key === "Enter" && filteredAssignees.length) { event.preventDefault(); chooseAgent(filteredAssignees[Math.min(highlightedAssigneeIndex, filteredAssignees.length - 1)]); }
        }} placeholder="Search assignees…" aria-label="Search assignees" aria-controls="composer-assignees" aria-activedescendant={filteredAssignees[highlightedAssigneeIndex] ? `composer-assignee-${filteredAssignees[highlightedAssigneeIndex].id}` : undefined} className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" /></div>
        <div id="composer-assignees" className="mt-2 max-h-60 overflow-y-auto" role="listbox" aria-label="Agents">
          {filteredAssignees.map((item, index) => <button type="button" role="option" id={`composer-assignee-${item.id}`} aria-selected={agent.id === item.id} key={item.id} onMouseEnter={() => setHighlightedAssigneeIndex(index)} onClick={() => chooseAgent(item)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left focus-visible:bg-accent focus-visible:outline-none", highlightedAssigneeIndex === index ? "bg-accent" : "hover:bg-accent")}>
            <AgentMark agent={item} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.name}</span><span className="block truncate text-xs text-muted-foreground">{item.role}</span></span>
            <span className="text-xs text-muted-foreground">{item.harness}</span>
            {agent.id === item.id ? <Check className="composer-picker-accent size-3.5" aria-hidden /> : null}
          </button>)}
          {!filteredAssignees.length ? <p className="px-2 py-2 text-xs text-muted-foreground">No matches.</p> : null}
        </div>
      </div>
    ) : (
      <div className="p-2">
        <div className="flex items-center gap-2 px-1 py-1.5"><button type="button" onClick={() => { setView("settings"); setSearch(""); }} aria-label="Back to selection" className="grid size-7 place-items-center rounded-md hover:bg-accent"><ArrowLeft className="size-4" aria-hidden /></button><div className="min-w-0 flex-1"><p className="text-xs font-semibold">Choose model</p><p className="truncate text-xs text-muted-foreground">{agent.harness}{agent.provider ? ` · ${agent.provider}` : ""}</p></div>{mobileCloseButton}</div>
        <div className="relative mt-2"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden /><input autoFocus type="search" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && manualValid && !exactCatalogMatch) chooseModel(query); }} placeholder="Search or paste a model ID" aria-label="Search or paste a model ID" className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" /></div>
        <div className="mt-2 max-h-60 overflow-y-auto" role="listbox" aria-label={`${agent.harness} models`}>
          {!query ? <button type="button" role="option" aria-selected={modelOverride === null} onClick={() => chooseModel(null)} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"><span className="min-w-0 flex-1"><span className="block text-sm font-medium">Use agent default</span><span className="block truncate text-xs text-muted-foreground">{modelLabel(agent, agent.defaultModel ?? "")}</span></span>{modelOverride === null ? <Check className="composer-picker-accent size-4" aria-hidden /> : null}</button> : null}
          {filtered.map((option) => <ModelRow key={option.id} option={option} selected={modelOverride === option.id} onSelect={(id) => chooseModel(id)} />)}
          {!filtered.length && query ? <p className="px-2.5 py-2 text-xs text-muted-foreground">No catalog match.</p> : null}
        </div>
        {query && !exactCatalogMatch ? <div className="mt-2 border-t border-border pt-2"><button type="button" disabled={!manualValid} onClick={() => chooseModel(query)} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"><Plus className="size-4 shrink-0" aria-hidden /><span className="min-w-0 flex-1 truncate">Use exact ID <span className="font-mono font-semibold">{query}</span></span></button>{!manualValid ? <p className="px-2.5 text-xs text-destructive">{agent.provider === "OpenRouter" ? "Use openrouter/provider/model with no spaces." : "Model IDs cannot contain spaces."}</p> : null}</div> : null}
        <p className="px-2.5 pb-1 pt-2 text-xs text-muted-foreground">{agent.manualPattern ? `Custom IDs: ${agent.manualPattern}. Provider access is checked when the run starts.` : "Only models for this harness are shown."}</p>
      </div>
    )
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className={cn("mx-auto flex min-h-screen w-full flex-col px-4 py-6 sm:px-8", compact ? "max-w-md" : "max-w-4xl")}>
        <header className="flex items-center gap-3 border-b border-border pb-4">
          <AgentAvatar agent={{ id: agent.id, name: agent.name, appearance: composerAgentAppearance(agent.id) }} size={32} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Agent conversation</span>
            <span className="block text-xs text-muted-foreground">Model and effort can be chosen for the next message</span>
          </span>
        </header>

        <main className="flex flex-1 flex-col justify-end gap-5 py-8">
          <div className="max-w-prose space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{agent.name} · {agent.role}</p>
            <p className="text-sm leading-relaxed">I can take the next step. Pick the model and effort you want me to use, then send your instructions.</p>
          </div>
          {messages.map((message, index) => (
            <div key={index} className="ml-auto max-w-prose rounded-xl bg-secondary px-4 py-3">
              <p className="text-sm">{message.text}</p>
              <p className="mt-1 text-xs text-muted-foreground">To {message.agent}{message.model ? ` · ${message.model}` : ""}{message.effort ? ` · ${effortLabels[message.effort] ?? message.effort}` : ""}{message.fast ? " · Fast" : ""}</p>
            </div>
          ))}
        </main>

        <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === ".") { event.preventDefault(); setMode(nextWorkMode); return; }
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
            }}
            placeholder={`Message ${agent.name} — describe what you want done…`}
            aria-label="Message" rows={2}
            className="block min-h-16 w-full resize-y bg-transparent text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground" />
          {attachments.length ? <div className="mt-2 flex flex-wrap gap-2">{attachments.map((name, index) => <button key={`${name}-${index}`} type="button" onClick={() => setAttachments((items) => items.filter((_, itemIndex) => itemIndex !== index))} className="rounded-md bg-muted px-2 py-1 text-xs">{name} ×</button>)}</div> : null}
          <div className={cn("mt-3 flex min-w-0 items-center gap-x-1.5 gap-y-3", mobile ? "flex-nowrap" : "flex-wrap")}>
            <div className="flex min-w-0 max-w-full items-center gap-1.5">
            <input ref={fileInputRef} type="file" className="hidden" onChange={(event) => { setAttachments((items) => [...items, ...Array.from(event.target.files ?? []).map((file) => file.name)]); event.target.value = ""; }} />
            <ComposerAddMenu mode={mode} onModeChange={setMode} onAttachFile={() => fileInputRef.current?.click()}
              onGoal={agent.adapterType === "codex_local" ? () => setDraft((current) => /^\/goal(?:\s|$)/.test(current) ? current : `/goal ${current}`) : undefined} mobile={mobile} />
            <ComposerModeChip mode={mode} onRemove={() => setMode("standard")} mobile={mobile} />
            </div>
            <div className={cn("ml-auto flex min-w-0 max-w-full items-center gap-1.5", mobile && "flex-1 justify-end")}>
            {mobile ? (
              <Dialog open={pickerOpen} onOpenChange={handlePickerOpenChange}>
                <DialogTrigger asChild>{pickerTrigger}</DialogTrigger>
                <DialogContent aria-describedby={undefined} showCloseButton={false} className="composer-picker-mobile-dialog top-1/2 -translate-y-1/2 gap-0 overflow-y-auto p-0" data-testid="composer-mobile-dialog">
                  <DialogTitle className="sr-only">Select assignee, model and effort</DialogTitle>
                  <AnimatedPickerBody>{pickerBody}</AnimatedPickerBody>
                </DialogContent>
              </Dialog>
            ) : (
              <Popover open={pickerOpen} onOpenChange={handlePickerOpenChange}>
                <PopoverTrigger asChild>{pickerTrigger}</PopoverTrigger>
                <PopoverContent side="top" align="end" sideOffset={8} className="w-80 max-w-full p-0 shadow-sm" data-testid="composer-model-popover">
                  <AnimatedPickerBody>{pickerBody}</AnimatedPickerBody>
                </PopoverContent>
              </Popover>
            )}
            <button type="button" onClick={send} disabled={!draft.trim()} aria-label="Send message" className="grid size-8 min-h-8 min-w-8 shrink-0 aspect-square place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"><ArrowUp className="size-4" aria-hidden /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
