import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, PinOff } from "lucide-react";
import { RecentTaskNavItem } from "./RecentTaskNavItem";
import { SidebarNavItem } from "./SidebarNavItem";
import { cn } from "@/lib/utils";
import type { Project } from "@paperclipai/shared";
import { SidebarProjectTasks } from "./SidebarProjectTasks";

export type PinnedNavigationItem = { key: string; label: string } & (
  | { project: Pick<Project, "id" | "companyId" | "name"> }
  | { project?: never; to: string; icon: ReactNode; task?: { id: string; identifier: string | null; isUnreadForMe?: boolean } }
);

/** Keep this row mounted when a pin is toggled so its controls retain focus. */
export function SortablePinnedRow({ id, label, disabled = false, className, handleClassName, handleIconClassName, children, ...props }: Omit<ComponentPropsWithoutRef<"div">, "id" | "children"> & {
  id: string; label: string; disabled?: boolean; handleClassName: string; handleIconClassName: string;
  children: ReactNode | ((handle: ReactNode) => ReactNode);
}) {
  const sortable = useSortable({ id, disabled, transition: null });
  const handle = !disabled && <button ref={sortable.setActivatorNodeRef} type="button" {...sortable.attributes} {...sortable.listeners}
    aria-label={`Reorder pinned ${label}`} title={`Drag to reorder ${label}`}
    className={cn("absolute top-1/2 flex -translate-y-1/2 touch-none cursor-grab items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity active:cursor-grabbing hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:opacity-100", handleClassName)}>
    <GripVertical aria-hidden className={handleIconClassName} />
  </button>;
  return <div {...props} ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform) }}
    className={cn(className, !disabled && "select-none", !sortable.isDragging && "motion-safe:transition-transform", sortable.isDragging && "z-10 opacity-80")}
    onDragStart={disabled ? undefined : event => event.preventDefault()}>
    {typeof children === "function" ? children(handle) : <>{children}{handle}</>}
  </div>;
}

function PinnedItem({ item, userId, onUnpin }: { item: PinnedNavigationItem; userId?: string | null; onUnpin: (key: string) => void }) {
  const rowClassName = "design-sidebar-item design-sidebar-pinned-item";
  const row = (primary: ReactNode, handle: ReactNode) => <div className="design-sidebar-pinned-row relative">
    {primary}
    <button type="button" aria-label={`Unpin ${item.label}`} title={`Unpin ${item.label}`}
      onMouseDown={event => event.stopPropagation()} onClick={() => onUnpin(item.key)}
      className="absolute right-10 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:opacity-100"><PinOff className="size-3.5" /></button>
    {handle}
  </div>;
  return <SortablePinnedRow id={item.key} label={item.label} className="relative"
    handleClassName="right-3 size-7" handleIconClassName="size-3.5">
    {handle => {
      if (item.project) {
        return <SidebarProjectTasks project={item.project} userId={userId} className={rowClassName}
          renderRow={toggle => row(toggle, handle)} />;
      }
      const link = { to: item.to, label: item.label, iconNode: item.icon, className: rowClassName };
      return row(item.task ? <RecentTaskNavItem {...link} task={item.task} /> : <SidebarNavItem {...link} />, handle);
    }}
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

export function PinnedNavigationList({ items, userId, onReorder, onUnpin }: {
  items: PinnedNavigationItem[]; userId?: string | null; onReorder: (keys: string[]) => void; onUnpin: (key: string) => void;
}) {
  return <SortablePinnedList keys={items.map(item => item.key)} onReorder={onReorder}>
    {items.map(item => <PinnedItem key={item.key} item={item} userId={userId} onUnpin={onUnpin} />)}
  </SortablePinnedList>;
}
