import { useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import type { Agent, IssueWorkMode } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ComposerRunSettingsPicker } from "@/components/task-chat/ComposerRunSettingsPicker";
import { ComposerAddMenu, ComposerModeChip } from "@/components/task-chat/ComposerAddMenu";
import { nextWorkMode } from "@/lib/work-mode-meta";
import { DEFAULT_COMPOSER_RUN_SETTINGS, mergeComposerRunSettings, type ComposerRunSettings } from "@/components/task-chat/composer-run-settings";
import { cn } from "@/lib/utils";
import { composerAgentAppearance, composerAgents } from "./fixtures";

const agents = new Map(composerAgents.map((fixture) => [fixture.id, {
  id: fixture.id, companyId: "storybook", name: fixture.name, role: fixture.role,
  appearance: composerAgentAppearance(fixture.id),
  adapterType: fixture.adapterType,
  adapterConfig: {
    ...(fixture.defaultModel ? { model: fixture.defaultModel } : {}),
    ...(fixture.provider === "OpenRouter" ? { provider: "openrouter" } : {}),
  },
  defaultEnvironmentId: null,
} as Agent]));
const options = composerAgents.map((item) => ({
  id: `agent:${item.id}`, label: item.name,
  searchText: `${item.name} ${item.role} ${item.harness} ${item.provider ?? ""}`,
}));

export interface LiveStoryProps {
  agentId?: string;
  initialModel?: string;
  initialEffort?: string;
  initialFast?: boolean;
  initialPanel?: "closed" | "settings" | "models" | "agents";
  initialSearch?: string;
  initialAssigneeSearch?: string;
  initialMode?: IssueWorkMode;
  mobile?: boolean;
  compact?: boolean;
}

export function ComposerRunSettingsLiveStory({
  agentId = "codex", initialModel, initialEffort, initialFast = false,
  initialPanel = "closed", initialSearch = "", initialAssigneeSearch = "",
  initialMode = "standard",
  mobile = false, compact = false,
}: LiveStoryProps) {
  const [assignee, setAssignee] = useState(`agent:${agentId}`);
  const [settings, setSettings] = useState<ComposerRunSettings | null>(
    initialModel || initialEffort || initialFast
      ? { model: initialModel ?? null, effort: initialEffort ?? null, fast: initialFast, daybreak: false, daybreakOverride: "inherit" }
      : null,
  );
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<IssueWorkMode>(initialMode);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [sent, setSent] = useState<Array<{ body: string; agent: string; overrides: unknown }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedAgent = composerAgents.find((item) => `agent:${item.id}` === assignee) ?? null;
  const agent = agents.get(selectedAgent?.id ?? "codex");
  const overrides = selectedAgent
    ? mergeComposerRunSettings(null, selectedAgent.adapterType, settings ?? DEFAULT_COMPOSER_RUN_SETTINGS)
    : null;

  function send() {
    if (!draft.trim()) return;
    setSent((current) => [...current, { body: draft.trim(), agent: selectedAgent?.name ?? "No assignee", overrides }]);
    setDraft("");
  }

  return <div className="min-h-screen bg-background text-foreground">
    <div className={cn("mx-auto flex min-h-screen w-full flex-col px-4 py-6 sm:px-8", compact ? "max-w-md" : "max-w-4xl")}>
      <header className="flex items-center gap-3 border-b border-border pb-4">
        <AgentAvatar agent={agent} size={32} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">Agent conversation</span>
          <span className="block text-xs text-muted-foreground">Model and effort can be chosen for the next message</span>
        </span>
      </header>

      <main className="flex flex-1 flex-col justify-end gap-5 py-8">
        <div className="max-w-prose space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{selectedAgent?.name} · {selectedAgent?.role}</p>
          <p className="text-sm leading-relaxed">I can take the next step. Pick the model and effort you want me to use, then send your instructions.</p>
        </div>
        {sent.map((message, index) => <div key={index} className="ml-auto max-w-prose rounded-xl bg-secondary px-4 py-3">
          <p className="text-sm">{message.body}</p>
          <p className="mt-1 text-xs text-muted-foreground">To {message.agent} · {JSON.stringify(message.overrides ?? "agent default")}</p>
        </div>)}
      </main>

      <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
        <textarea aria-label="Message" placeholder={`Message ${selectedAgent?.name ?? "the task"} — describe what you want done…`}
          rows={2} value={draft} onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === ".") { event.preventDefault(); setMode(nextWorkMode); }
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
          }}
          className="block min-h-16 w-full resize-y bg-transparent text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground" />
        {attachments.length ? <div className="mt-2 flex flex-wrap gap-2">{attachments.map((name, index) => <button key={`${name}-${index}`} type="button" onClick={() => setAttachments((items) => items.filter((_, itemIndex) => itemIndex !== index))} className="rounded-md bg-muted px-2 py-1 text-xs">{name} ×</button>)}</div> : null}
        <div className={cn("mt-3 flex min-w-0 items-center gap-x-1.5 gap-y-3", mobile ? "flex-nowrap" : "flex-wrap")}>
          <div className="flex min-w-0 max-w-full items-center gap-1.5">
            <input ref={fileInputRef} type="file" className="hidden" onChange={(event) => { setAttachments((items) => [...items, ...Array.from(event.target.files ?? []).map((file) => file.name)]); event.target.value = ""; }} />
            <ComposerAddMenu mode={mode} onModeChange={setMode} onAttachFile={() => fileInputRef.current?.click()}
              onGoal={selectedAgent?.adapterType === "codex_local" ? () => setDraft((current) => /^\/goal(?:\s|$)/.test(current) ? current : `/goal ${current}`) : undefined} mobile={mobile} />
            <ComposerModeChip mode={mode} onRemove={() => setMode("standard")} mobile={mobile} />
          </div>
          <div className={cn("ml-auto flex min-w-0 max-w-full items-center gap-1.5", mobile && "flex-1 justify-end")}>
            <ComposerRunSettingsPicker companyId="storybook" assigneeValue={assignee} currentAssigneeValue={assignee}
              options={options} agents={agents} settings={settings} onSettingsChange={setSettings}
              onAssigneeChange={(value) => { setAssignee(value); setSettings(null); }} mobile={mobile}
              modelOptionsOverride={selectedAgent?.models ?? []}
              initialOpen={initialPanel !== "closed"} initialView={initialPanel === "closed" ? "settings" : initialPanel}
              initialModelSearch={initialSearch} initialAssigneeSearch={initialAssigneeSearch}
              renderAssigneeIdentity={(value, _label, placement) => value.startsWith("agent:")
                ? <AgentAvatar agent={agents.get(value.slice(6))} size={placement === "trigger" ? 16 : 24} /> : null} />
          <button type="button" aria-label="Send message" disabled={!draft.trim()} onClick={send}
            className="grid size-8 min-h-8 min-w-8 shrink-0 aspect-square place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40">
            <ArrowUp className="size-4" />
          </button>
          </div>
        </div>
      </div>
    </div>
  </div>;
}
