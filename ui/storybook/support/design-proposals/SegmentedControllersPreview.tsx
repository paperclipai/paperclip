import { useState, type ReactNode } from "react";
import { Columns3, List, Network, SquareKanban } from "lucide-react";
import { FilePreviewModeToggle, type FilePreviewMode } from "@/components/FilePreviewModeToggle";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface SegmentedControllersPreviewProps {
  width: "full" | "narrow";
  disableAgentActions: boolean;
  onWidthChange?: (width: SegmentedControllersPreviewProps["width"]) => void;
}
function Specimen({ title, source, children }: { title: string; source: string; children: ReactNode }) {
  return <section aria-label={title} className="min-w-0 space-y-4 border-t border-border pt-6">
    <div className="space-y-1"><h2 className="text-lg font-normal text-foreground">{title}</h2><p className="text-xs">{source}</p></div>
    <div className="overflow-x-auto p-2">{children}</div>
  </section>;
}
function PanelSwitch({ label, items, grid = false, disabled = false }: { label: string; items: string[]; grid?: boolean; disabled?: boolean }) {
  const [value, setValue] = useState(items[0]);
  return <Tabs value={value} onValueChange={setValue} className="gap-4">
    <TabsList aria-label={label} className={grid ? "grid w-full grid-cols-2" : undefined}>
      {items.map((item, index) => <TabsTrigger key={item} value={item} disabled={disabled && index === 1}>{item}</TabsTrigger>)}
    </TabsList>
    {items.map(item => <TabsContent key={item} value={item}><p className="text-xs">Selected panel: {item}. Fixture content only.</p></TabsContent>)}
  </Tabs>;
}
function LayoutSwitch({ kind }: { kind: "proposal" | "issues" | "agents" }) {
  const [selected, setSelected] = useState(0);
  const items = kind === "agents" ? [{ label: "List view", icon: List }, { label: "Org chart view", icon: Network }] : [{ label: "List view", icon: List }, { label: "Board view", icon: kind === "proposal" ? Columns3 : SquareKanban }];
  return <div className={kind === "proposal" ? "design-view-toggle" : "flex w-fit items-center overflow-hidden rounded-md border border-border"} role="group" aria-label={`${kind} layout`}>
    {items.map(({ label, icon: Icon }, index) => kind === "issues" ? <button key={label} aria-label={label} title={label} aria-pressed={selected === index} onClick={() => setSelected(index)} className={`flex h-8 w-8 items-center justify-center transition-colors ${selected === index ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}><Icon className="h-3.5 w-3.5" /></button> : <Button key={label} type="button" size={kind === "agents" ? "icon-sm" : "icon"} variant={kind === "agents" && selected === index ? "secondary" : "ghost"} className={kind === "proposal" ? "design-toolbar-button design-toolbar-icon" : `rounded-none ${index === 1 ? "border-l border-border" : ""}`} aria-label={label} title={label} aria-pressed={selected === index} onClick={() => setSelected(index)}><Icon className={kind === "agents" ? "h-3.5 w-3.5" : undefined} aria-hidden /></Button>)}
  </div>;
}
function InstructionSwitch() {
  const [mode, setMode] = useState("read");
  return <div className="flex w-fit items-center rounded-md border border-border p-0.5" role="group" aria-label="Instruction file view">
    {["read", "edit", "raw"].map(value => <Button key={value} type="button" size="sm" variant={mode === value ? "secondary" : "ghost"} className="capitalize" aria-pressed={mode === value} onClick={() => setMode(value)}>{value}</Button>)}
  </div>;
}
function FileSwitch() {
  const [mode, setMode] = useState<FilePreviewMode>("rendered");
  return <FilePreviewModeToggle mode={mode} onChange={setMode} label="File preview mode" />;
}
function ModelSwitch() {
  const [lane, setLane] = useState("primary");
  return <div className="flex w-full overflow-hidden rounded-md border border-border" role="radiogroup" aria-label="Model lane">
    {["primary", "custom"].map(value => <button key={value} type="button" role="radio" aria-checked={lane === value} className={`flex-1 px-2 py-1 text-xs capitalize transition-colors hover:bg-accent/40 ${lane === value ? "bg-accent text-foreground" : ""}`} onClick={() => setLane(value)}>{value === "primary" ? "Primary" : "Override"}</button>)}
  </div>;
}
export function SegmentedControllersPreview({ width, disableAgentActions, onWidthChange }: SegmentedControllersPreviewProps) {
  return <main data-testid="segmented-controllers-preview" className="min-h-dvh space-y-8 bg-background p-6 font-sans text-muted-foreground sm:p-10">
    <header className="space-y-3"><p className="text-xs">Design proposals · Components</p><h1 className="text-2xl font-semibold text-foreground">Segmented controllers</h1>
      <p className="max-w-3xl text-sm">Compare current connected choices: panel tabs, layout switches, file modes and model lanes. Each example keeps its existing styling and semantics; interactions affect local fixture state only.</p>
      <label className="flex w-fit items-center gap-3 text-xs">Container width<select aria-label="Segmented controller container width" className="rounded-md border border-border bg-background px-3 py-2 text-sm" value={width} onChange={event => onWidthChange?.(event.target.value as SegmentedControllersPreviewProps["width"])}><option value="full">Full</option><option value="narrow">Narrow</option></select></label>
    </header>
    <div className={`space-y-8 ${width === "narrow" ? "max-w-sm" : "max-w-none"}`}>
      <Specimen title="Audit activity scope" source="AuditFeed · production TabsList/TabsTrigger composition. The Agent Actions disabled state is controlled in Storybook."><PanelSwitch label="Activity scope" items={["Activity", "Agent Actions"]} disabled={disableAgentActions} /></Specimen>
      <Specimen title="Task layout · proposal" source="TaskListToolbar · Design Proposals and sandbox composition, using the shared design-view-toggle styling."><div className="design-page-toolbar" data-canonical-toolbar><LayoutSwitch kind="proposal" /></div></Specimen>
      <Specimen title="Task layout · production" source="IssuesList and LegacyIssuesList · inline production list/board composition with native pressed buttons."><LayoutSwitch kind="issues" /></Specimen>
      <Specimen title="Agent layout" source="Agents · production List / Org chart shared Button composition."><LayoutSwitch kind="agents" /></Specimen>
      <Specimen title="Instruction file mode" source="AgentDetail · production Read / Edit / Raw Button composition."><InstructionSwitch /></Specimen>
      <Specimen title="File preview mode" source="FilePreviewModeToggle · actual shared production component, Rendered / Raw."><FileSwitch /></Specimen>
      <Specimen title="Secret ownership" source="Secrets · production two-column TabsList composition. No secrets are read or created."><PanelSwitch label="Secret ownership" items={["Organization", "Each user"]} grid /></Specimen>
      <Specimen title="Secret value source" source="Secrets · same two-column composition with Managed value / External reference choices."><PanelSwitch label="Secret value source" items={["Managed value", "External reference"]} grid /></Specimen>
      <Specimen title="Goal content" source="GoalDetail · default production TabsList composition, including count labels."><PanelSwitch label="Goal content" items={["Sub-Goals (3)", "Projects (2)"]} /></Specimen>
      <Specimen title="Model lane" source="IssueProperties · production inline radio composition. Preserves existing click behavior; keyboard arrow navigation is a consolidation gap."><ModelSwitch /></Specimen>
    </div>
    <p className="max-w-3xl text-xs">Inline page controls are isolated compositions of their production primitives, not full production-page mounts. These examples establish a comparison surface, not backend or accessibility acceptance. No existing app controls have been restyled.</p>
  </main>;
}
