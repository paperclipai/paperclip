import { useState, type ComponentProps, type ReactNode } from "react";
import type { FeedbackVoteValue } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { ClearErrorButton, PauseResumeButton, RunButton } from "@/components/AgentActionButtons";
import { DesignSidebar } from "@/components/DesignSidebar";
import { ArtifactUploadButton, ArtifactUploadContent } from "@/components/artifacts/ArtifactUploadControls";
import { ExpandRelationListButton } from "@/components/issue-properties/relation-controls";
import { FilePreviewModeToggle, type FilePreviewMode } from "@/components/FilePreviewModeToggle";
import { OutputFeedbackButtons } from "@/components/OutputFeedbackButtons";
import { StarToggle } from "@/components/StarToggle";
import { StatusIcon } from "@/components/StatusIcon";
import { TaskList } from "@/components/TaskList";
import { TaskListToolbar } from "@/components/TaskListToolbar";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { FlyoutAppearanceProvider } from "@/components/ui/flyout";
import { TaskChatBubbleActions } from "@/components/task-chat/TaskChatBubbleActions";
import { SidePanelToggleButton, SidePanelWindowControls } from "@/components/side-panel/SidePanelFrame";
import { SidePanelTabs } from "@/components/side-panel/SidePanelTabs";
import { defaultIssueFilterState } from "@/lib/issue-filters";
import type { TaskListView } from "@/lib/task-list-views";
import { storybookAgents, storybookIssueLabels, storybookProjects } from "../../fixtures/paperclipData";
import { DesignProposalAccess } from "./DesignProposalAccess";
import { reviewTaskItems } from "./task-list-data";
import { ButtonSpecimen as SampleButton } from "./ButtonSpecimen";
import { useButtonPreviewStates } from "./useButtonPreviewStates";

type ButtonProps = ComponentProps<typeof Button>;
export type ButtonVariant = NonNullable<ButtonProps["variant"]>;
export type ButtonSize = NonNullable<ButtonProps["size"]>;
// Exhaustive against the shipped Button API: adding a variant/size requires a
// label here, so the sandbox inventory includes new shared primitive options.
export const buttonVariants = {
  default: "Default", cta: "CTA", destructive: "Destructive", outline: "Outline",
  secondary: "Secondary", ghost: "Ghost", link: "Link",
} satisfies Record<ButtonVariant, string>;
export const buttonSizes = {
  default: "Default", xs: "Extra small", sm: "Small", lg: "Large",
  icon: "Icon", "icon-xs": "Icon extra small", "icon-sm": "Icon small", "icon-lg": "Icon large",
} satisfies Record<ButtonSize, string>;
export const buttonStates = { default: "Default", hover: "Hover", "focus-visible": "Keyboard focus", active: "Pressed", disabled: "Disabled", loading: "Loading" } as const;
export const buttonSurfaces = { background: "Main pane / menu", muted: "Left sidebar / raised card", "muted-alt": "Middle card", "background-alt": "Input surface" } as const;
const surfaceClasses = { background: "bg-background", muted: "bg-muted", "muted-alt": "bg-(--muted-alt)", "background-alt": "bg-(--background-alt)" };
export type ButtonPlaygroundSettings = {
  label: string;
  variant: ButtonVariant;
  size: ButtonSize;
  icon: "none" | "leading" | "trailing";
  state: keyof typeof buttonStates;
  surface: keyof typeof buttonSurfaces;
};
export const defaultButtonSettings: ButtonPlaygroundSettings = {
  label: "Create task", variant: "outline", size: "default", icon: "leading", state: "default", surface: "background",
};

function SampleGroup({ title, source, children }: { title: string; source: string; children: ReactNode }) {
  return <section className="min-w-0 space-y-4 border-t border-border pt-6" aria-label={title}>
    <div className="space-y-1">
      <h3 className="text-base font-normal text-foreground">{title}</h3>
      <p className="text-xs text-muted-foreground">{source}</p>
    </div>
    {children}
  </section>;
}

export function ButtonSamples({ settings = defaultButtonSettings }: { settings?: ButtonPlaygroundSettings }) {
  const [action, setAction] = useState("No action yet");
  useButtonPreviewStates();
  const act = (name: string) => setAction(`${name} clicked · preview only`);
  return <div data-testid="proposal-button-samples" className="space-y-8 text-foreground">
    <SampleGroup title="Live specimen" source="Shared Button · current label, variant, size, icon and state controls">
      <div className={`flex flex-wrap items-center gap-4 rounded-lg border border-border p-6 ${surfaceClasses[settings.surface]}`}>
        <SampleButton settings={settings} onClick={() => act(settings.variant)} measure />
        <output className="text-xs text-muted-foreground" aria-live="polite">{action}</output>
      </div>
      <p className="text-xs text-muted-foreground">Surface: <code>--{settings.surface}</code>. Hover, keyboard focus and pressed previews reuse the compiled component state rules. Real pointer and keyboard interactions remain available; states without dedicated styling can look identical.</p>
      {settings.size.startsWith("icon") && <p className="text-xs text-muted-foreground">Icon-only sizes always retain an icon and use the label as their accessible name.</p>}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Implementation reference</summary>
        <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3"><code>{`import { Button } from "@/components/ui/button";\n\n<Button variant="${settings.variant}" size="${settings.size}"${settings.state === "disabled" || settings.state === "loading" ? " disabled" : ""}${settings.state === "loading" ? ' aria-busy="true"' : ""}${settings.size.startsWith("icon") ? ` aria-label=${JSON.stringify(settings.label)}` : ""}>\n  ${settings.state === "loading" ? "<Loader2 aria-hidden className=\"animate-spin\" />" : settings.size.startsWith("icon") || settings.icon === "leading" ? "<CirclePlus aria-hidden />" : ""}${!settings.size.startsWith("icon") ? ` ${settings.label}` : ""}${settings.icon === "trailing" && !settings.size.startsWith("icon") && settings.state !== "loading" ? " <CirclePlus aria-hidden />" : ""}\n</Button>`}</code></pre>
        <p className="mt-2">Forced interaction states belong to this preview. Use pointer interaction and keyboard focus in the app.</p>
      </details>
    </SampleGroup>
    <SampleGroup title="All button variants" source="ui/src/components/ui/button.tsx · every variant, in default, disabled and loading states">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm" data-testid="button-variant-matrix">
          <thead><tr className="border-b border-border text-xs text-muted-foreground">
            {["Variant", "Default", "Disabled", "Loading"].map(label => <th key={label} className="px-3 pb-3 font-normal">{label}</th>)}
          </tr></thead>
          <tbody>{Object.entries(buttonVariants).map(([variant, label]) => <tr key={variant} data-button-variant={variant} className="border-b border-border">
            <th className="px-3 py-4 text-xs font-normal text-muted-foreground">{label}<code className="mt-1 block">{variant}</code></th>
            {(["default", "disabled", "loading"] as const).map(state => <td key={state} className="px-3 py-4">
              <SampleButton settings={settings} variant={variant as ButtonVariant} state={state} onClick={() => act(variant)} />
            </td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </SampleGroup>
    <SampleGroup title="All button sizes" source="All eight shared sizes · current variant, state and icon controls">
      <div className="flex flex-wrap items-end gap-6" data-testid="button-size-matrix">
        {Object.entries(buttonSizes).map(([size, label]) => <div key={size} data-button-size={size} className="space-y-2">
          <SampleButton settings={settings} size={size as ButtonSize} onClick={() => act(size)} measure />
          <p className="text-xs text-muted-foreground">{label}<code className="block">{size}</code></p>
        </div>)}
      </div>
    </SampleGroup>
    <SandboxContexts onAction={act} />
  </div>;
}

function SandboxContexts({ onAction }: { onAction: (label: string) => void }) {
  const [view, setView] = useState<TaskListView>("all");
  const [query, setQuery] = useState("preview");
  const [layout, setLayout] = useState<"list" | "board">("list");
  const [expanded, setExpanded] = useState(true);
  const [filters, setFilters] = useState(defaultIssueFilterState);
  return <FlyoutAppearanceProvider><DesignProposalAccess>
    <div className="space-y-8">
      <SampleGroup title="Task toolbar" source="TaskListToolbar · view menu, clear search, layout toggles, expand/collapse, filters and New Task">
        <TaskListToolbar view={view} onViewChange={setView} query={query} onQueryChange={setQuery}
          layout={layout} onLayoutChange={setLayout} allExpanded={expanded} onToggleExpanded={() => setExpanded(value => !value)}
          onNewTask={() => onAction("New Task")} filters={{ state: filters, onChange: patch => setFilters(current => ({ ...current, ...patch })), activeFilterCount: filters.statuses.length,
            agents: storybookAgents, projects: storybookProjects, labels: storybookIssueLabels }} />
      </SampleGroup>
      <SampleGroup title="Task-list header and popover actions" source="TaskList · sort controls, Columns trigger and Reset defaults inside its menu">
        <TaskList items={reviewTaskItems.slice(0, 3)} />
      </SampleGroup>
      <SampleGroup title="Sidebar controls in context" source="DesignSidebar · organization, global search, New Task, account menu and feedback">
        <div className="flex h-96 w-(--sz-240px) overflow-hidden rounded-lg border border-border bg-muted">
          <DesignSidebar onNewTask={() => onAction("Sidebar New Task")} />
        </div>
      </SampleGroup>
      <SampleGroup title="App-shell controls" source="Shared SidePanel controls · proposal toggle stays quiet until hover/focus">
        <PanelButtons onAction={onAction} />
      </SampleGroup>
      <SampleGroup title="Agent, conversation and attachment controls" source="Shared controls used by sandbox agents, task conversations, property panes and attachments">
        <SharedContexts onAction={onAction} />
      </SampleGroup>
    </div>
  </DesignProposalAccess></FlyoutAppearanceProvider>;
}

function PanelButtons({ onAction }: { onAction: (label: string) => void }) {
  const [open, setOpen] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [tabs, setTabs] = useState([{ id: "properties", type: "properties", label: "Properties", closable: true }, { id: "tasks", type: "tasks", label: "Tasks", closable: true }]);
  const [active, setActive] = useState("properties");
  return <div className="space-y-4">
    <div className="flex items-center gap-2">
      <SidePanelToggleButton open={open} onToggle={() => setOpen(value => !value)} highlightWhenOpen={false} />
      <SidePanelWindowControls maximized={maximized} onMaximizedChange={setMaximized} closeControl="close" onToggle={() => { setOpen(false); onAction("Close side panel"); }} />
    </div>
    <div className="flex min-w-0 rounded-md border border-border">
      <SidePanelTabs tabs={tabs} activeTabId={active} onActiveTabChange={setActive}
        onCloseTab={id => setTabs(current => current.filter(tab => tab.id !== id))}
        onAddTab={() => { const id = `preview-${tabs.length}`; setTabs(current => [...current, { id, type: "preview", label: `Preview ${current.length + 1}`, closable: true }]); setActive(id); }}
        appearance="streamlined-task" />
    </div>
  </div>;
}

function SharedContexts({ onAction }: { onAction: (label: string) => void }) {
  const [paused, setPaused] = useState(false);
  const [vote, setVote] = useState<FeedbackVoteValue | null>(null);
  const [starred, setStarred] = useState(false);
  const [mode, setMode] = useState<FilePreviewMode>("rendered");
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState("todo");
  const [relationsExpanded, setRelationsExpanded] = useState(false);
  const [uploadVisible, setUploadVisible] = useState(true);
  return <div className="space-y-6">
    <ContextRow label="Agent actions" source="AgentActionButtons.tsx">
      <RunButton onClick={() => onAction("Run now")} />
      <PauseResumeButton isPaused={paused} onPause={() => setPaused(true)} onResume={() => setPaused(false)} />
      <PauseResumeButton isPaused={!paused} onPause={() => setPaused(true)} onResume={() => setPaused(false)} />
      <ClearErrorButton onClick={() => onAction("Clear error")} />
      <RunButton disabled onClick={() => {}} />
    </ContextRow>
    <ContextRow label="Response and output feedback" source="TaskChatBubbleActions.tsx · OutputFeedbackButtons.tsx">
      <TaskChatBubbleActions copyText="Synthetic agent response for button review." feedback={{ activeVote: vote, sharingPreference: "allowed", termsUrl: null, onVote: async value => setVote(value) }} />
      <OutputFeedbackButtons inline activeVote={vote} sharingPreference="allowed" onVote={async value => setVote(value)} />
    </ContextRow>
    <ContextRow label="Favorite · off / on / pending / error / row" source="StarToggle.tsx">
      <StarToggle size="button" resourceName="preview" starred={starred} onToggle={setStarred} />
      <StarToggle size="button" resourceName="selected preview" starred onToggle={value => onAction(`Star ${value}`)} />
      <StarToggle size="button" resourceName="pending preview" starred pending onToggle={() => {}} />
      <StarToggle size="button" resourceName="error preview" starred error onToggle={() => onAction("Retry star")} />
      <StarToggle size="row" resourceName="row preview" starred={starred} revealClassName="opacity-100" onToggle={setStarred} />
    </ContextRow>
    <ContextRow label="File display and switches" source="FilePreviewModeToggle.tsx · ui/toggle-switch.tsx">
      <FilePreviewModeToggle mode={mode} onChange={setMode} label="File display" />
      <ToggleSwitch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable preview" />
      <ToggleSwitch size="lg" checked={enabled} onCheckedChange={setEnabled} aria-label="Enable large preview" />
      <ToggleSwitch checked disabled onCheckedChange={() => {}} aria-label="Disabled preview" />
    </ContextRow>
    <ContextRow label="Task status picker" source="StatusIcon.tsx · task detail and properties">
      <StatusIcon status={status} onChange={setStatus} /><StatusIcon status={status} showLabel onChange={setStatus} />
    </ContextRow>
    <ContextRow label="Upload, retry and dismiss" source="artifacts/ArtifactUploadControls.tsx">
      <ArtifactUploadButton onUpload={files => onAction(`Selected ${files.length} files`)} />
      <ArtifactUploadContent entries={uploadVisible ? [{ id: "preview-upload", filename: "preview.txt", status: "error", error: "Synthetic upload failure" }] : []}
        onRetry={() => onAction("Retry upload")} onDismiss={() => setUploadVisible(false)} />
    </ContextRow>
    <ContextRow label="Expand related tasks" source="issue-properties/relation-controls.tsx">
      <ExpandRelationListButton hiddenCount={4} expanded={relationsExpanded} onClick={() => setRelationsExpanded(value => !value)} />
    </ContextRow>
    <ContextRow label="Link rendered through Button" source="ui/button.tsx · asChild">
      <Button variant="link" asChild><a href="#button-playground-top">Back to playground</a></Button>
    </ContextRow>
  </div>;
}

function ContextRow({ label, source, children }: { label: string; source: string; children: ReactNode }) {
  return <div className="space-y-3">
    <p className="text-sm text-foreground">{label}</p>
    <div className="flex flex-wrap items-center gap-3">{children}</div>
    <p className="text-xs text-muted-foreground">{source}</p>
  </div>;
}
