import { useState, type ReactNode } from "react";
import { TabBar, TabFilters, type TabSize } from "@/components/TabBar";
import { ArtifactKindFilters } from "@/components/artifacts/ArtifactsToolbar";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import type { ArtifactKindFilter } from "@/api/artifacts";

export interface TabsPreviewProps {
  pattern: "all" | "standard" | "compact";
  width: "full" | "narrow";
  onWidthChange?: (width: TabsPreviewProps["width"]) => void;
}
function Specimen({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section aria-label={title} className="min-w-0 space-y-4 border-t border-border pt-6">
    <div className="space-y-1"><h2 className="text-lg font-normal text-foreground">{title}</h2><p className="text-xs text-muted-foreground">{description}</p></div>
    {children}
  </section>;
}

function ArtifactFilters() {
  const [kind, setKind] = useState<ArtifactKindFilter>("all");
  return <><ArtifactKindFilters kind={kind} onKindChange={setKind} /><output className="block text-xs" aria-live="polite">Artifact type: {kind}</output></>;
}

function CanonicalTabs({ size }: { size: TabSize }) {
  const [value, setValue] = useState("paperclip");
  const items = [{ value: "paperclip", label: "Paperclip" }, { value: "composio", label: "Composio" }, { value: "arcade", label: "Arcade" }, { value: "installed", label: "Installed" }];
  return <Tabs value={value} onValueChange={setValue}>
    <TabBar size={size} label={`${size} content tabs`} items={items} />
    {items.map(item => <TabsContent key={item.value} value={item.value}><p className="text-xs">Selected panel: {item.label}. Fixture content only.</p></TabsContent>)}
  </Tabs>;
}
function DisabledTabs() {
  const [value, setValue] = useState("available");
  return <TabFilters size="standard" label="Disabled choice example" value={value} onValueChange={setValue} items={[{ value: "available", label: "Available" }, { value: "restricted", label: "Restricted", disabled: true }]} />;
}

export function TabsPreview({ pattern, width, onWidthChange }: TabsPreviewProps) {
  return <main data-testid="tabs-preview" className="min-h-dvh space-y-8 bg-background p-6 font-sans text-muted-foreground sm:p-10">
    <header className="space-y-3">
      <p className="text-xs">Design proposals · Components</p><h1 className="text-2xl font-semibold text-foreground">Tabs</h1>
      <p className="max-w-3xl text-sm">Two canonical sizes with one filled selection treatment. Compact uses 12px type; Standard uses 14px type and the Paper reference geometry. Content tabs switch panels; collection filters use radio choices. Both support keyboard navigation.</p>
      <label className="flex w-fit items-center gap-3 text-xs">Container width<select aria-label="Tabs container width" className="rounded-md border border-border bg-background px-3 py-2 text-sm" value={width} onChange={event => onWidthChange?.(event.target.value as TabsPreviewProps["width"])}><option value="full">Full</option><option value="narrow">Narrow</option></select></label>
    </header>
    <div className={`w-full space-y-8 ${width === "narrow" ? "max-w-sm" : "max-w-none"}`} data-testid="tabs-specimens">
      {(pattern === "all" || pattern === "standard") && <Specimen title="Standard" description="14px · --text-sm · 32px tab height · 10px horizontal padding · 8px gap. Matches the Paper tab bar with muted inactive text and a rounded filled selection."><CanonicalTabs size="standard" /></Specimen>}
      {(pattern === "all" || pattern === "compact") && <Specimen title="Compact" description="12px · --text-xs · 24px tab height · the same filled selection behavior as Standard. Artifact filters below use the same shared styling."><CanonicalTabs size="compact" /><ArtifactFilters /></Specimen>}

    </div>
    <aside className="max-w-3xl space-y-3 border-t border-border pt-6 text-sm" aria-label="Tab usage">
      <h2 className="font-semibold text-foreground">One visual pattern, two sizes</h2>
      <p>Use Standard for page navigation and primary source choices. Use Compact for dense filters and metadata areas. TabBar composes inside Tabs with matching panels. TabFilters uses radio choices for collections; clicking an already selected choice keeps it selected.</p>
      <DisabledTabs />
      <p className="text-xs">Arrow keys, Home and End move between enabled choices. Disabled choices are skipped. Segmented controllers remain a separate component family. App examples use the same components as this reference.</p>
    </aside>
  </main>;
}
