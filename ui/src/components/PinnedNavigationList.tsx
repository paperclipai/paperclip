import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, PinOff } from "lucide-react";
import { RecentTaskNavItem } from "./RecentTaskNavItem";
import { SidebarNavItem } from "./SidebarNavItem";
import { cn } from "@/lib/utils";

export interface PinnedNavigationItem {
  key: string;
  to: string;
  label: string;
  icon: ReactNode;
  task?: { id: string; identifier: string | null; isUnreadForMe?: boolean };
}

/** Keep this row mounted when a pin is toggled so its controls retain focus. */
export function SortablePinnedRow({ id, label, disabled = false, className, handleClassName, handleIconClassName, children, ...props }: Omit<ComponentPropsWithoutRef<"div">, "id"> & {
  id: string; label: string; disabled?: boolean; handleClassName: string; handleIconClassName: string;
}) {
  const sortable = useSortable({ id, disabled, transition: null });
  return <div {...props} ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform) }}
    className={cn(className, !disabled && "select-none", !sortable.isDragging && "motion-safe:transition-transform", sortable.isDragging && "z-10 opacity-80")}
    onDragStart={disabled ? undefined : event => event.preventDefault()}>
    {children}
    {!disabled && <button ref={sortable.setActivatorNodeRef} type="button" {...sortable.attributes} {...sortable.listeners}
      aria-label={`Reorder pinned ${label}`} title={`Drag to reorder ${label}`}
      className={cn("absolute top-1/2 flex -translate-y-1/2 touch-none cursor-grab items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity active:cursor-grabbing hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:opacity-100", handleClassName)}>
      <GripVertical aria-hidden className={handleIconClassName} />
    </button>}
  </div>;
}

function PinnedItem({ item, onUnpin }: { item: PinnedNavigationItem; onUnpin: (key: string) => void }) {
  const link = { to: item.to, label: item.label, iconNode: item.icon, className: "design-sidebar-item design-sidebar-pinned-item group-hover/coordinator-pin:bg-sidebar-accent" };
  return <SortablePinnedRow id={item.key} label={item.label} className="group/coordinator-pin relative"
    handleClassName="right-3 size-7 group-hover/coordinator-pin:opacity-100 group-focus-within/coordinator-pin:opacity-100" handleIconClassName="size-3.5">
    {item.task ? <RecentTaskNavItem {...link} task={item.task} /> : <SidebarNavItem {...link} />}
    <button type="button" aria-label={`Unpin ${item.label}`} title={`Unpin ${item.label}`}
      onMouseDown={event => event.stopPropagation()} onClick={() => onUnpin(item.key)}
      className="absolute right-10 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover/coordinator-pin:opacity-100 group-focus-within/coordinator-pin:opacity-100 pointer-coarse:opacity-100"><PinOff className="size-3.5" /></button>
  </SortablePinnedRow>;
}

export function SortablePinnedList({ keys, onReorder, children }: {
  keys: string[]; onReorder?: (keys: string[]) => void; children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function move({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = keys.indexOf(String(active.id)), to = keys.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onReorder?.(arrayMove(keys, from, to));
  }
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={move}>
    <SortableContext items={keys} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  </DndContext>;
}

export function PinnedNavigationList({ items, onReorder, onUnpin }: {
  items: PinnedNavigationItem[]; onReorder: (keys: string[]) => void; onUnpin: (key: string) => void;
}) {
  return <SortablePinnedList keys={items.map(item => item.key)} onReorder={onReorder}>
    {items.map(item => <PinnedItem key={item.key} item={item} onUnpin={onUnpin} />)}
  </SortablePinnedList>;
}
