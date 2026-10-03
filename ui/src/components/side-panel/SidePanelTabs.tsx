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
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SidePanelTab } from "./SidePanelTab";
import type { SidePanelTabItem } from "./types";

interface SortableSidePanelTabProps {
  tab: SidePanelTabItem;
  active: boolean;
  dragging: boolean;
  appearance: "default" | "streamlined-task";
  showLeadingSeparator: boolean;
  onSelect: () => void;
  onClose: () => void;
  onAuxClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

function SortableSidePanelTab({
  tab,
  active,
  dragging,
  appearance,
  showLeadingSeparator,
  onSelect,
  onClose,
  onAuxClick,
  onKeyDown,
}: SortableSidePanelTabProps) {
  const sortable = useSortable({ id: tab.id, disabled: tab.disabled });
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        // Tabs have different widths; applying the sortable scale stretches them during reordering.
        transform: DndCSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        appearance === "streamlined-task"
          ? "relative mx-0.75 flex w-max min-w-0 max-w-(--side-panel-streamlined-tab-max-width) shrink-0 items-center"
          : "relative",
        sortable.isDragging && (appearance === "streamlined-task" ? "opacity-0" : "z-20 opacity-80"),
      )}
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
        appearance={appearance}
        closable={tab.closable}
        disabled={tab.disabled}
        suppressTooltip={dragging}
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

function StreamlinedTabDragPreview({
  tab,
  active,
  width,
  labelIsTruncated,
}: {
  tab: SidePanelTabItem;
  active: boolean;
  width: number;
  labelIsTruncated: boolean;
}) {
  return (
    <div
      aria-hidden
      data-side-panel-tab-drag-preview={tab.id}
      style={{ width }}
      className={cn(
        "relative flex h-7 min-w-0 items-center rounded-md border border-transparent text-sm font-medium text-foreground shadow-sm",
        active ? "bg-(--side-panel-streamlined-tab-active-bg)" : "bg-(--side-panel-streamlined-tab-hover-bg)",
      )}
    >
      <span className={cn(
        "min-w-0 flex-auto overflow-hidden whitespace-nowrap pl-1.5",
        tab.closable === false ? "pr-1.5" : "pr-6",
        labelIsTruncated && "side-panel-tab-label-fade",
      )}>
        {tab.label}
      </span>
      {tab.closable === false ? null : (
        <span className="absolute right-0.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center text-muted-foreground">
          <X className="size-3.5" />
        </span>
      )}
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
  appearance?: "default" | "streamlined-task";
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
  appearance = "default",
  className,
}: SidePanelTabsProps) {
  const [announcement, setAnnouncement] = useState("");
  const [showEndFade, setShowEndFade] = useState(false);
  const [draggedTab, setDraggedTab] = useState<{ id: string; width: number; labelIsTruncated: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const addControlRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const draggedTabItem = draggedTab ? tabs.find((tab) => tab.id === draggedTab.id) : null;

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

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || appearance !== "streamlined-task") {
      setShowEndFade(false);
      return;
    }
    const updateEndFade = () => {
      const remainingScroll = element.scrollWidth - element.clientWidth - element.scrollLeft;
      setShowEndFade(remainingScroll > 1);
    };
    updateEndFade();
    element.addEventListener("scroll", updateEndFade, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateEndFade);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      element.removeEventListener("scroll", updateEndFade);
      observer?.disconnect();
    };
  }, [appearance, tabIds]);

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

  function handleDragStart(event: DragStartEvent) {
    if (appearance !== "streamlined-task") return;
    const id = String(event.active.id);
    const wrapper = findTabElement(id, "wrapper");
    if (!wrapper) return;
    setDraggedTab({
      id,
      width: wrapper.getBoundingClientRect().width,
      labelIsTruncated: wrapper.querySelector('[data-truncated="true"]') !== null,
    });
  }

  return (
    <div className={cn(
      "flex min-w-0 flex-1 items-center",
      appearance === "streamlined-task" ? "gap-0" : "gap-1",
      className,
    )}>
      <div
        ref={scrollRef}
        role="tablist"
        aria-orientation="horizontal"
        data-scroll-end-fade={appearance === "streamlined-task" && showEndFade ? "true" : undefined}
        className={cn(
          "side-panel-tabs-scroll min-w-0 flex-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          appearance === "streamlined-task"
            ? "overflow-x-auto overscroll-x-contain"
            : "overflow-x-auto",
        )}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={(event) => {
            handleDragEnd(event);
            setDraggedTab(null);
          }}
          onDragCancel={() => setDraggedTab(null)}
        >
          <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
            <div className={cn(
              "flex items-center",
              appearance === "streamlined-task"
                ? "w-max gap-0"
                : "min-w-max gap-1 py-1",
            )}>
              {tabs.map((tab, index) => (
                <SortableSidePanelTab
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeTabId}
                  dragging={draggedTab !== null}
                  appearance={appearance}
                  showLeadingSeparator={
                    appearance === "default"
                      && index > 0
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
          {appearance === "streamlined-task" && typeof document !== "undefined" ? createPortal(
            <DragOverlay adjustScale={false} className="pointer-events-none z-20">
              {draggedTab && draggedTabItem ? (
                <StreamlinedTabDragPreview
                  tab={draggedTabItem}
                  active={draggedTab.id === activeTabId}
                  width={draggedTab.width}
                  labelIsTruncated={draggedTab.labelIsTruncated}
                />
              ) : null}
            </DragOverlay>,
            document.body,
          ) : null}
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
          className={cn(
            "shrink-0 text-muted-foreground hover:text-foreground focus-visible:text-foreground",
            appearance === "streamlined-task"
              ? "h-(--side-panel-tab-height) w-(--side-panel-tab-height) rounded-md"
              : "h-(--side-panel-tab-height) w-(--side-panel-tab-height) rounded-(--side-panel-control-radius)",
          )}
        >
          <Plus aria-hidden />
        </Button>
      ) : null)}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    </div>
  );
}
