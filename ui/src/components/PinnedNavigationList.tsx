import { useTranslation } from "@/i18n";
import type { ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, PinOff } from "lucide-react";
import { SidebarNavItem } from "./SidebarNavItem";
import { cn } from "@/lib/utils";

export interface PinnedNavigationItem { key: string; to: string; label: string; icon: ReactNode }

function PinnedItem({ item, rail, onUnpin }: { item: PinnedNavigationItem; rail: boolean; onUnpin: (key: string) => void }) {
  const { t } = useTranslation("navigation");
  const sortable = useSortable({ id: item.key, disabled: rail, transition: null });
  return <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform) }}
    className={cn("group/coordinator-pin relative select-none", !sortable.isDragging && "motion-safe:transition-transform", sortable.isDragging && "z-10 opacity-80")}
    onDragStart={event => event.preventDefault()}>
    <SidebarNavItem to={item.to} label={item.label} iconNode={item.icon} className={cn("design-sidebar-item group-hover/coordinator-pin:bg-sidebar-accent", !rail && "pr-16")} />
    {!rail && <button type="button" aria-label={t("coordinator.unpin", { label: item.label })} title={t("coordinator.unpin", { label: item.label })}
      onMouseDown={event => event.stopPropagation()} onClick={() => onUnpin(item.key)}
      className="absolute right-10 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover/coordinator-pin:opacity-100 group-focus-within/coordinator-pin:opacity-100 pointer-coarse:opacity-100"><PinOff className="size-3.5" /></button>}
    {!rail && <button ref={sortable.setActivatorNodeRef} type="button" {...sortable.attributes} {...sortable.listeners}
      aria-label={t("coordinator.reorderPinned", { label: item.label })} title={t("coordinator.dragToReorder", { label: item.label })}
      className="absolute right-3 top-1/2 flex size-7 -translate-y-1/2 touch-none cursor-grab items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity active:cursor-grabbing hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover/coordinator-pin:opacity-100 group-focus-within/coordinator-pin:opacity-100 pointer-coarse:opacity-100"><GripVertical className="size-3.5" /></button>}
  </div>;
}

export function PinnedNavigationList({ items, rail, onReorder, onUnpin }: {
  items: PinnedNavigationItem[]; rail: boolean; onReorder: (keys: string[]) => void; onUnpin: (key: string) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function move({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const keys = items.map(item => item.key);
    const from = keys.indexOf(String(active.id)), to = keys.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onReorder(arrayMove(keys, from, to));
  }
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={move}>
    <SortableContext items={items.map(item => item.key)} strategy={verticalListSortingStrategy}>
      {items.map(item => <PinnedItem key={item.key} item={item} rail={rail} onUnpin={onUnpin} />)}
    </SortableContext>
  </DndContext>;
}
