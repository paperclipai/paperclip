import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SidePanelTab } from "./SidePanelTab";
import type { SidePanelTabItem } from "./types";

interface SortableSidePanelTabProps {
  tab: SidePanelTabItem;
  active: boolean;
  showLeadingSeparator: boolean;
  onSelect: () => void;
  onClose: () => void;
  onAuxClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

function SortableSidePanelTab({ tab, active, showLeadingSeparator, onSelect, onClose, onAuxClick, onKeyDown }: SortableSidePanelTabProps) {
  const sortable = useSortable({ id: tab.id, disabled: tab.disabled });
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: DndCSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn("relative", sortable.isDragging && "z-20 opacity-80")}
    >
      {showLeadingSeparator ? (
        <span
          aria-hidden
          data-side-panel-tab-separator="true"
          className="pointer-events-none absolute inset-y-2 -left-0.5 w-px bg-border/60"
        />
      ) : null}
      <SidePanelTab
        id={tab.id}
        label={tab.label}
        ariaLabel={tab.ariaLabel}
        icon={tab.icon}
        status={tab.status}
        active={active}
        closable={tab.closable}
        disabled={tab.disabled}
        tabRef={sortable.setActivatorNodeRef}
        dragHandleProps={{
          ...sortable.attributes,
          ...sortable.listeners,
        } as ButtonHTMLAttributes<HTMLButtonElement>}
        onSelect={onSelect}
        onClose={onClose}
        onAuxClick={onAuxClick}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

export interface SidePanelTabsProps {
  tabs: SidePanelTabItem[];
  activeTabId: string | null;
  onActiveTabChange: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onReorderTabs?: (orderedTabIds: string[]) => void;
  onAddTab?: () => void;
  addControl?: ReactNode;
  addLabel?: string;
  className?: string;
}

export function SidePanelTabs({
  tabs,
  activeTabId,
  onActiveTabChange,
  onCloseTab,
  onReorderTabs,
  onAddTab,
  addControl,
  addLabel = "Open a new tab",
  className,
}: SidePanelTabsProps) {
  const [announcement, setAnnouncement] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const addControlRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  function findTabElement(tabId: string, selector: "wrapper" | "target") {
    const attribute = selector === "wrapper"
      ? "data-side-panel-tab-wrapper"
      : "data-side-panel-tab-target";
    return Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? [],
    ).find((element) => element.getAttribute(attribute) === tabId) ?? null;
  }

  useEffect(() => {
    if (!activeTabId) return;
    const element = findTabElement(activeTabId, "wrapper");
    const reducedMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest", inline: "nearest" });
    // `findTabElement` only reads the committed tab DOM for this active id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  function focusTab(tabId: string | null) {
    window.requestAnimationFrame(() => {
      if (!tabId) {
        addButtonRef.current?.focus();
        addControlRef.current?.querySelector<HTMLElement>("button, [href], input, [tabindex]:not([tabindex='-1'])")?.focus();
        return;
      }
      const tab = findTabElement(tabId, "target") as HTMLButtonElement | null;
      tab?.focus();
    });
  }

  function closeTab(tabId: string) {
    const index = tabIds.indexOf(tabId);
    const nextFocus = tabIds[index + 1] ?? tabIds[index - 1] ?? null;
    onCloseTab(tabId);
    setAnnouncement(nextFocus ? "Tab closed." : "Last tab closed. Choose something to open.");
    focusTab(nextFocus);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, tabId: string) {
    const index = tabIds.indexOf(tabId);
    if (index < 0) return;
    if (event.altKey && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      if (!onReorderTabs) return;
      event.preventDefault();
      const target = event.key === "ArrowLeft" ? index - 1 : index + 1;
      if (target < 0 || target >= tabIds.length) return;
      const ordered = [...tabIds];
      const [moved] = ordered.splice(index, 1);
      ordered.splice(target, 0, moved!);
      onReorderTabs(ordered);
      setAnnouncement(`Moved ${tabs[index]?.label ?? "tab"} to position ${target + 1} of ${tabs.length}.`);
      focusTab(tabId);
      return;
    }
    const targetIndex = event.key === "ArrowLeft"
      ? Math.max(0, index - 1)
      : event.key === "ArrowRight"
        ? Math.min(tabIds.length - 1, index + 1)
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabIds.length - 1
            : -1;
    if (targetIndex < 0 || targetIndex === index) return;
    event.preventDefault();
    const targetId = tabIds[targetIndex]!;
    onActiveTabChange(targetId);
    focusTab(targetId);
  }

  function handleDragEnd(event: DragEndEvent) {
    if (!onReorderTabs || !event.over || event.active.id === event.over.id) return;
    const from = tabIds.indexOf(String(event.active.id));
    const to = tabIds.indexOf(String(event.over.id));
    if (from < 0 || to < 0) return;
    const ordered = [...tabIds];
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved!);
    onReorderTabs(ordered);
    setAnnouncement(`Moved ${tabs[from]?.label ?? "tab"} to position ${to + 1} of ${tabs.length}.`);
  }

  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-1", className)}>
      <div
        ref={scrollRef}
        role="tablist"
        aria-orientation="horizontal"
        className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
            <div className="flex min-w-max items-center gap-1 py-1">
              {tabs.map((tab, index) => (
                <SortableSidePanelTab
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeTabId}
                  showLeadingSeparator={
                    index > 0
                    && tab.id !== activeTabId
                    && tabs[index - 1]?.id !== activeTabId
                  }
                  onSelect={() => onActiveTabChange(tab.id)}
                  onClose={() => closeTab(tab.id)}
                  onAuxClick={(event) => {
                    if (event.button !== 1 || tab.closable === false) return;
                    event.preventDefault();
                    closeTab(tab.id);
                  }}
                  onKeyDown={(event) => handleKeyDown(event, tab.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
      {addControl ? <div ref={addControlRef} className="shrink-0">{addControl}</div> : (onAddTab ? (
        <Button
          ref={addButtonRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onAddTab}
          aria-label={addLabel}
          title={addLabel}
          className="h-(--side-panel-tab-height) w-(--side-panel-tab-height) shrink-0 rounded-(--side-panel-control-radius) text-muted-foreground hover:text-foreground focus-visible:text-foreground"
        >
          <Plus aria-hidden />
        </Button>
      ) : null)}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    </div>
  );
}
