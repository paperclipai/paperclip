import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileText, Plus } from "lucide-react";
import type { AttentionItem } from "@paperclipai/shared";
import { PROPERTIES_PANE_HEADER_SLOT_ID } from "@/components/PropertiesPanel";
import { SidePanelLauncher, SidePanelTabs, type SidePanelLauncherItem, type SidePanelLauncherSection, type SidePanelTabItem, type SidePanelTabRecord } from "@/components/side-panel";
import { Button } from "@/components/ui/button";
import { needsYouArtifact, needsYouArtifactId, needsYouArtifactLabel, type NeedsYouArtifact } from "./CoordinatorReviewPanel";

/**
 * A Needs You side-panel tab: what one pending card is deciding on (a plan,
 * an approval, attachments), or an artifact the card mentions (PAP-775).
 * Every tab belongs to its card, so it shows the card's own actions and
 * closes when the card leaves.
 */
export interface NeedsYouReviewPayload {
  kind: "review";
  itemId: string;
  /** A mentioned artifact; absent for the card's own artifact. */
  artifact?: NeedsYouArtifact;
}

/** The card's own artifact keeps `review:<card>`; a mentioned one adds its own id. */
export function needsYouReviewTabId(item: AttentionItem, artifact?: NeedsYouArtifact | null) {
  const own = needsYouArtifact(item);
  if (!artifact || (own && needsYouArtifactId(own, item) === needsYouArtifactId(artifact, item))) return `review:${item.id}`;
  return `review:${item.id}:${needsYouArtifactId(artifact, item)}`;
}

/** The artifact a tab shows: the mentioned one, else the card's own. */
export function needsYouTabArtifact(item: AttentionItem, payload: NeedsYouReviewPayload) {
  return payload.artifact ?? needsYouArtifact(item);
}

function documentLabel(item: AttentionItem, artifact?: NeedsYouArtifact | null) {
  const shown = artifact ?? needsYouArtifact(item);
  return shown ? needsYouArtifactLabel(shown) : "Document";
}

/** "NEE-39 plan": the artifact and its task, where several are listed or open. */
export function needsYouReviewTabLabel(item: AttentionItem, artifact?: NeedsYouArtifact | null) {
  const task = item.relatedIssue?.identifier;
  const label = documentLabel(item, artifact);
  return task ? `${task} ${label.toLocaleLowerCase()}` : item.subject.title ? `${label}: ${item.subject.title}` : label;
}

export function needsYouReviewTab(item: AttentionItem, artifact?: NeedsYouArtifact | null): SidePanelTabRecord<NeedsYouReviewPayload> {
  const id = needsYouReviewTabId(item, artifact);
  const mentioned = id !== needsYouReviewTabId(item) ? artifact ?? undefined : undefined;
  return { id, type: documentLabel(item, artifact), label: needsYouReviewTabLabel(item, artifact), ariaLabel: needsYouReviewTabLabel(item, artifact), closable: true, payload: { kind: "review", itemId: item.id, artifact: mentioned } };
}

/**
 * Focus (PAP-770): the Needs You side panel uses the task-detail panel's
 * chrome: a tab per opened document, a + launcher listing the other
 * documents waiting on you, and the frame's own expand and close controls.
 * The page owns the tab state, so a card and its tab stay in step.
 */
export function CoordinatorNeedsYouSidePanel({ tabs, activeTabId, items, reviewable, onSelectTab, onCloseTab, onReorderTabs, onOpenItem, renderReview }: {
  tabs: SidePanelTabRecord<NeedsYouReviewPayload>[];
  activeTabId: string | null;
  /** Every pending card, so a tab for a mentioned artifact finds its card. */
  items: AttentionItem[];
  reviewable: AttentionItem[];
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onReorderTabs: (ordered: string[]) => void;
  onOpenItem: (item: AttentionItem) => void;
  renderReview: (item: AttentionItem, tab: SidePanelTabRecord<NeedsYouReviewPayload>) => ReactNode;
}) {
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById(PROPERTIES_PANE_HEADER_SLOT_ID)); }, []);
  const byId = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);
  // A tab says "Plan" until a second plan opens; then each names its task.
  const visualTabs = useMemo<SidePanelTabItem[]>(() => tabs.map(tab => ({
    id: tab.id, type: tab.type, ariaLabel: tab.ariaLabel, closable: true, icon: <FileText />,
    label: tabs.filter(other => other.type === tab.type).length > 1 ? tab.label : tab.type,
  })), [tabs]);
  const sections = useMemo<SidePanelLauncherSection[]>(() => [{
    id: "waiting",
    label: "Waiting on you",
    items: reviewable.map((item): SidePanelLauncherItem => ({
      id: item.id,
      label: needsYouReviewTabLabel(item),
      description: item.relatedIssue?.title ?? undefined,
      searchText: [item.relatedIssue?.identifier, item.relatedIssue?.title, item.subject.title].filter(Boolean).join(" "),
      icon: <FileText />,
      alreadyOpen: tabs.some(tab => tab.id === needsYouReviewTabId(item)),
    })),
  }], [reviewable, tabs]);
  const select = (entry: SidePanelLauncherItem) => {
    const item = byId.get(entry.id);
    if (item) onOpenItem(item);
  };
  const launcher = <SidePanelLauncher sections={sections} onSelect={select} presentation="popover" open={launcherOpen} onOpenChange={setLauncherOpen}
    emptyMessage="Nothing else is waiting on you."
    trigger={<Button type="button" variant="ghost" size="icon-sm" className="h-(--side-panel-tab-height) w-(--side-panel-tab-height) shrink-0 rounded-md text-muted-foreground hover:text-foreground focus-visible:text-foreground" aria-label="Open a new tab"><Plus aria-hidden /></Button>} />;
  const header = <SidePanelTabs tabs={visualTabs} activeTabId={activeTabId} onActiveTabChange={onSelectTab} onCloseTab={onCloseTab}
    onReorderTabs={onReorderTabs} addControl={launcher} appearance="streamlined-task" />;
  const active = tabs.find(tab => tab.id === activeTabId) ?? null;
  const item = active ? byId.get(active.payload.itemId) ?? null : null;
  return <div className="flex min-h-full flex-col" data-coordinator-side-panel>
    {slot ? createPortal(header, slot) : header}
    {!active ? <SidePanelLauncher sections={sections} onSelect={select} emptyMessage="Nothing else is waiting on you." />
      : item ? renderReview(item, active)
      : <p className="text-sm text-muted-foreground">This is no longer waiting on you.</p>}
  </div>;
}
