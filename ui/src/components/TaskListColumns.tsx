import { createContext, useContext, useId, type CSSProperties, type ReactNode } from "react";
import { DndContext, PointerSensor, closestCenter, pointerWithin, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, Ellipsis } from "lucide-react";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { allTaskListColumns, defaultTaskListColumns, reorderTaskListColumns, taskListColumnStart, taskListColumns, type TaskListColumnId, type TaskListSort } from "../lib/task-list";
import { CellMarquee } from "./CellMarquee";
import { FlyoutAppearanceProvider, FlyoutHeader, FlyoutOptions } from "./ui/flyout";
import { useHorizontalScrollEdges } from "@/hooks/useHorizontalScrollEdges";

export { taskListColumns } from "../lib/task-list";
export type { TaskListColumnId, TaskListSort } from "../lib/task-list";

const ColumnContext = createContext({ columns: defaultTaskListColumns, order: allTaskListColumns });
export const useTaskListColumns = () => useContext(ColumnContext).columns;

function columnLayout(visibleColumns: readonly TaskListColumnId[], hasControls: boolean): CSSProperties {
  const columns = visibleColumns.map(id => taskListColumns.find(column => column.id === id)!);
  const hasTitle = visibleColumns.includes("task");
  const leadingWidth = hasTitle ? "var(--task-list-column-status)" : "var(--task-row-control-size)";
  const widths = columns.flatMap(column => column.id === "task" ? [leadingWidth, "var(--task-list-column-title-min)"] : [column.width]);
  const tracks = columns.flatMap(column => column.id === "task" ? [leadingWidth, "minmax(var(--task-list-column-title-min), 1fr)"] : [column.width]);
  if (!hasTitle) { widths.unshift(leadingWidth); tracks.unshift(`minmax(${leadingWidth}, 1fr)`); }
  return {
    "--task-list-columns": tracks.join(" "),
    "--task-list-task-start": hasTitle ? taskListColumnStart(visibleColumns, "task") : 1,
    "--task-list-min-width": `calc(${widths.join(" + ")} + var(--task-row-gap) * ${widths.length - 1} + var(--task-row-padding-inline) * 2${hasControls ? " + var(--task-list-controls-width)" : ""})`,
    "--task-list-controls-space": hasControls ? "var(--task-list-controls-width)" : "var(--task-list-no-controls-space)",
  } as CSSProperties;
}

/** Shared collection viewport: fades only the edges with content beyond them. */
export function TaskListViewport({ children, visibleColumns = defaultTaskListColumns, columnOrder = allTaskListColumns, controls }: {
  children: ReactNode;
  visibleColumns?: readonly TaskListColumnId[];
  columnOrder?: readonly TaskListColumnId[];
  controls?: ReactNode;
}) {
  const { scrollRef, contentRef, edges } = useHorizontalScrollEdges();
  const orderedColumns = columnOrder.filter(id => visibleColumns.includes(id));

  return (
    <ColumnContext.Provider value={{ columns: orderedColumns, order: columnOrder }}>
      <div role="table" aria-label="Task list" data-slot="task-list-viewport" data-overflow-left={edges.left} data-overflow-right={edges.right} className="task-list-viewport" style={columnLayout(orderedColumns, Boolean(controls))}>
        <div ref={scrollRef} role="region" aria-label="Task list columns" tabIndex={0} className="task-list-columns-scroll">
          <div ref={contentRef} className="task-list-columns-content">{children}</div>
        </div>
        {controls ? <div className="task-list-header-controls">{controls}</div> : null}
      </div>
    </ColumnContext.Provider>
  );
}

const detailColumns = taskListColumns.filter(column => column.id !== "task");
type DetailColumn = Exclude<(typeof detailColumns)[number]["id"], "taskId">;

/** Values are resolved by the collection; identity columns intentionally accept names only. */
export type TaskRowColumnValues = Partial<Record<Exclude<DetailColumn, "createdBy" | "assignee">, ReactNode>> & {
  createdBy?: string | null;
  assignee?: string | null;
};

function SortableColumnHeader({ id, label, start, sort, onSortChange, onColumnOrderChange, helpId }: {
  id: TaskListColumnId;
  label: string;
  start: number;
  sort?: TaskListSort;
  onSortChange?: (sort: TaskListSort) => void;
  onColumnOrderChange?: (columns: readonly TaskListColumnId[]) => void;
  helpId: string;
}) {
  const { columns, order } = useContext(ColumnContext);
  const sortable = useSortable({ id, disabled: !onColumnOrderChange, transition: null });
  const active = sort?.column === id;
  const direction = active && sort.direction === "ascending" ? "descending" : "ascending";
  return (
    <span
      ref={sortable.setNodeRef}
      role="columnheader"
      data-column={id}
      data-dragging={sortable.isDragging || undefined}
      aria-colspan={id === "task" ? 2 : undefined}
      aria-sort={active ? sort.direction : "none"}
      style={{
        gridColumn: `${start} / span ${id === "task" ? 2 : 1}`,
        transform: sortable.transform ? CSS.Translate.toString({ ...sortable.transform, y: 0 }) : undefined,
      }}
    >
      {onSortChange || onColumnOrderChange ? (
        <Button
          ref={sortable.setActivatorNodeRef}
          {...sortable.attributes}
          {...sortable.listeners}
          type="button" variant="ghost" size="sm" className="task-list-sort-button"
          data-active={active || undefined} data-reorderable={Boolean(onColumnOrderChange)}
          aria-label={onSortChange ? `${label}: sort ${direction}` : label}
          aria-describedby={onColumnOrderChange ? helpId : undefined}
          aria-keyshortcuts={onColumnOrderChange ? "Alt+ArrowLeft Alt+ArrowRight" : undefined}
          onClick={() => onSortChange?.({ column: id, direction })}
          onKeyDown={event => {
            if (!onColumnOrderChange || !event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            const target = columns[columns.indexOf(id) + (event.key === "ArrowLeft" ? -1 : 1)];
            if (target) onColumnOrderChange(reorderTaskListColumns(order, id, target));
          }}
        >
          <span>{label}</span>
          {active ? sort.direction === "ascending"
            ? <ArrowUp className="size-3" data-slot="task-list-sort-direction" aria-hidden />
            : <ArrowDown className="size-3" data-slot="task-list-sort-direction" aria-hidden /> : null}
        </Button>
      ) : label}
    </span>
  );
}

export function TaskListColumnHeader({ sort, onSortChange, onColumnOrderChange }: {
  sort?: TaskListSort;
  onSortChange?: (sort: TaskListSort) => void;
  onColumnOrderChange?: (columns: readonly TaskListColumnId[]) => void;
}) {
  const { columns, order } = useContext(ColumnContext);
  const helpId = useId();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  return (
    <DndContext sensors={sensors} collisionDetection={args => {
      const targets = pointerWithin(args);
      return targets.length ? targets : closestCenter(args);
    }} onDragEnd={({ active, over }) => {
      if (over) onColumnOrderChange?.(reorderTaskListColumns(order, active.id as TaskListColumnId, over.id as TaskListColumnId));
    }} accessibility={{ screenReaderInstructions: { draggable: "Click to sort. Drag horizontally to reorder, or use Alt plus Left or Right Arrow." } }}>
      <span id={helpId} className="sr-only">Drag to reorder columns, or use Alt plus Left or Right Arrow. Click to sort.</span>
      <SortableContext items={[...columns]} strategy={horizontalListSortingStrategy}>
        <div role="row" data-slot="task-list-column-header" className="task-list-column-header">
          {!columns.includes("task") ? <span role="columnheader" aria-label="Task hierarchy" /> : null}
          {columns.map(id => <SortableColumnHeader key={id} id={id} label={taskListColumns.find(column => column.id === id)!.label} start={taskListColumnStart(columns, id)} sort={sort} onSortChange={onSortChange} onColumnOrderChange={onColumnOrderChange} helpId={helpId} />)}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/** Compact refresh variant; the existing inbox picker uses legacy column IDs. */
export function TaskListColumnSettings({ visibleColumns, onVisibleColumnsChange, onColumnOrderChange, onResetDefaults }: {
  visibleColumns: readonly TaskListColumnId[];
  onVisibleColumnsChange: (columns: readonly TaskListColumnId[]) => void;
  onColumnOrderChange?: (columns: readonly TaskListColumnId[]) => void;
  onResetDefaults?: () => void;
}) {
  const { order } = useContext(ColumnContext);
  return (
    <FlyoutAppearanceProvider><DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" className="task-list-settings-trigger" aria-label="Columns"><Ellipsis aria-hidden /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="task-list-options" aria-label="Columns">
        <DropdownMenuLabel asChild><FlyoutHeader className="task-list-options-heading">Columns</FlyoutHeader></DropdownMenuLabel>
        <FlyoutOptions className="task-list-options-items">
          {order.map(id => (
            <DropdownMenuCheckboxItem
              key={id}
              className="task-list-options-item"
              checked={visibleColumns.includes(id)}
              disabled={visibleColumns.length === 1 && visibleColumns.includes(id)}
              onSelect={event => event.preventDefault()}
              onCheckedChange={checked => onVisibleColumnsChange(order.filter(column => column === id ? checked === true : visibleColumns.includes(column)))}
            >
              {taskListColumns.find(column => column.id === id)!.label}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuItem className="task-list-options-reset" onSelect={event => { event.preventDefault(); onColumnOrderChange?.(allTaskListColumns); onVisibleColumnsChange(defaultTaskListColumns); onResetDefaults?.(); }}>Reset defaults</DropdownMenuItem>
        </FlyoutOptions>
      </DropdownMenuContent>
    </DropdownMenu></FlyoutAppearanceProvider>
  );
}

export function TaskRowColumnCells({ identifier, values }: { identifier: string; values: TaskRowColumnValues }) {
  const columns = useTaskListColumns();
  if (!detailColumns.some(column => columns.includes(column.id))) return null;
  return (
    <span data-slot="task-row-columns" className="task-row-columns">
      {columns.filter(id => id !== "task").map(id => (
        <span key={id} role="cell" data-column={id} data-marquee-cell={id} className="task-row-column" style={{ gridColumn: taskListColumnStart(columns, id) }}>
          <CellMarquee cell={id}>{id === "taskId" ? identifier : values[id] ?? "—"}</CellMarquee>
        </span>
      ))}
    </span>
  );
}
