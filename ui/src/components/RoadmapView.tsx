import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Maximize2, Minus, Plus, Trash2 } from "lucide-react";
import type { Goal, RoadmapBlock } from "@paperclipai/shared";
import { ROADMAP_BLOCK_STATUSES } from "@paperclipai/shared";
import { goalsApi } from "../api/goals";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { InlineEditor } from "./InlineEditor";

const BLOCK_W = 190;
const BLOCK_H = 52;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const DRAG_THRESHOLD = 5;

function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(24, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/**
 * The long-range planning board (imported from Miro). Blocks are shared team
 * state: drag to reposition (persisted for everyone), + to promote a block
 * into an initiative/epic, edges read "completing this unlocks that".
 */
export function RoadmapView({ companyId, goals }: { companyId: string; goals: Goal[] }) {
  const queryClient = useQueryClient();
  const { data: roadmap } = useQuery({
    queryKey: queryKeys.goals.roadmap(companyId),
    queryFn: () => goalsApi.roadmap(companyId),
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.goals.roadmap(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(companyId) });
  }, [queryClient, companyId]);

  const blockUpdate = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      goalsApi.roadmapBlockUpdate(id, data),
    onSettled: invalidate,
  });
  const blockCreate = useMutation({
    mutationFn: (data: Record<string, unknown>) => goalsApi.roadmapBlockCreate(companyId, data),
    onSettled: invalidate,
  });
  const blockRemove = useMutation({
    mutationFn: (id: string) => goalsApi.roadmapBlockRemove(id),
    onSettled: invalidate,
  });
  const blockPromote = useMutation({
    mutationFn: ({ id, level, parentGoalId }: { id: string; level: "initiative" | "epic"; parentGoalId?: string | null }) =>
      goalsApi.roadmapBlockPromote(id, { level, parentGoalId }),
    onSettled: invalidate,
  });
  const edgeCreate = useMutation({
    mutationFn: (data: { fromBlockId: string; toBlockId: string }) => goalsApi.roadmapEdgeCreate(companyId, data),
    onSettled: invalidate,
  });
  const edgeRemove = useMutation({
    mutationFn: (id: string) => goalsApi.roadmapEdgeRemove(id),
    onSettled: invalidate,
  });

  const blocks = useMemo(() => roadmap?.blocks ?? [], [roadmap]);
  const edges = useMemo(() => roadmap?.edges ?? [], [roadmap]);
  const blockById = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);
  const goalById = useMemo(() => new Map(goals.map((g) => [g.id, g])), [goals]);
  const initiatives = useMemo(() => goals.filter((g) => g.level === "initiative"), [goals]);
  const epics = useMemo(() => goals.filter((g) => g.level === "epic"), [goals]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? blockById.get(selectedId) ?? null : null;

  // Pan/zoom + block drag
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [zoom, setZoom] = useState(0.85);
  const [panning, setPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const dragState = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null);
  const [dragDelta, setDragDelta] = useState({ dx: 0, dy: 0 });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const suppressClick = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-roadmap-action]")) return;
    const card = target.closest<HTMLElement>("[data-roadmap-block]");
    if (card) {
      dragState.current = { id: card.dataset.roadmapBlock!, startX: e.clientX, startY: e.clientY, moved: false };
      return;
    }
    setPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const drag = dragState.current;
    if (drag) {
      if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.moved = true;
      setDraggingId(drag.id);
      setDragDelta({ dx: (e.clientX - drag.startX) / zoom, dy: (e.clientY - drag.startY) / zoom });
      return;
    }
    if (!panning) return;
    setPan({ x: panStart.current.panX + e.clientX - panStart.current.x, y: panStart.current.panY + e.clientY - panStart.current.y });
  }, [panning, zoom]);

  const handleMouseUp = useCallback(() => {
    const drag = dragState.current;
    dragState.current = null;
    setPanning(false);
    if (drag?.moved) {
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 300);
      const block = blockById.get(drag.id);
      if (block) {
        blockUpdate.mutate({
          id: drag.id,
          data: { x: Math.round(block.x + dragDelta.dx), y: Math.round(block.y + dragDelta.dy) },
        });
      }
    }
    setDraggingId(null);
    setDragDelta({ dx: 0, dy: 0 });
  }, [blockById, blockUpdate, dragDelta]);

  const zoomTowardPoint = useCallback((newZoom: number, point: { x: number; y: number }) => {
    const clamped = clampZoom(newZoom);
    const scale = clamped / zoom;
    setPan({ x: point.x - scale * (point.x - pan.x), y: point.y - scale * (point.y - pan.y) });
    setZoom(clamped);
  }, [zoom, pan]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    zoomTowardPoint(zoom * (e.deltaY < 0 ? 1.1 : 0.9), { x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, [zoom, zoomTowardPoint]);

  const fitToScreen = useCallback(() => {
    const container = containerRef.current;
    if (!container || blocks.length === 0) return;
    let maxX = 0, maxY = 0;
    for (const b of blocks) {
      maxX = Math.max(maxX, b.x + BLOCK_W + 60);
      maxY = Math.max(maxY, b.y + BLOCK_H + 60);
    }
    const fitZoom = clampZoom(Math.min((container.clientWidth - 40) / maxX, (container.clientHeight - 40) / maxY, 1));
    setZoom(fitZoom);
    setPan({ x: (container.clientWidth - maxX * fitZoom) / 2, y: (container.clientHeight - maxY * fitZoom) / 2 });
  }, [blocks]);

  const newBlock = useCallback(() => {
    const container = containerRef.current;
    const cx = container ? Math.round((container.clientWidth / 2 - pan.x) / zoom) : 100;
    const cy = container ? Math.round((container.clientHeight / 2 - pan.y) / zoom) : 100;
    blockCreate.mutate({ title: "New block", x: cx, y: cy });
  }, [blockCreate, pan, zoom]);

  const statusOf = (block: RoadmapBlock): string => {
    if (block.linkedGoalId && goalById.get(block.linkedGoalId)?.status === "achieved") return "done";
    return block.status;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border md:flex-row">
      <div
        ref={containerRef}
        data-testid="roadmap-viewport"
        className="relative min-h-(--sz-280px) flex-1 overflow-hidden bg-muted/20"
        style={{ cursor: draggingId || panning ? "grabbing" : "grab", touchAction: "none", overscrollBehavior: "contain" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        <div className="absolute top-3 right-3 z-10 flex flex-col gap-1.5">
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7"
            onClick={() => {
              const container = containerRef.current;
              if (container) zoomTowardPoint(zoom * 1.2, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
            }}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7"
            onClick={() => {
              const container = containerRef.current;
              if (container) zoomTowardPoint(zoom * 0.8, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
            }}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <Minus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background transition-colors hover:bg-accent sm:size-7"
            onClick={fitToScreen}
            title="Fit to screen"
            aria-label="Fit roadmap to screen"
          >
            <Maximize2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
        </div>
        <div className="absolute top-3 left-3 z-10">
          <Button size="sm" variant="outline" onClick={newBlock}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            New block
          </Button>
        </div>

        <svg className="pointer-events-none absolute inset-0" style={{ width: "100%", height: "100%" }}>
          <defs>
            <marker id="roadmap-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--border)" />
            </marker>
          </defs>
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {edges.map((edge) => {
              const from = blockById.get(edge.fromBlockId);
              const to = blockById.get(edge.toBlockId);
              if (!from || !to) return null;
              const fx = from.x + (draggingId === from.id ? dragDelta.dx : 0);
              const fy = from.y + (draggingId === from.id ? dragDelta.dy : 0);
              const tx = to.x + (draggingId === to.id ? dragDelta.dx : 0);
              const ty = to.y + (draggingId === to.id ? dragDelta.dy : 0);
              return (
                <path
                  key={edge.id}
                  d={curve(fx + BLOCK_W, fy + BLOCK_H / 2, tx, ty + BLOCK_H / 2)}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth={1.4}
                  markerEnd="url(#roadmap-arrow)"
                />
              );
            })}
          </g>
        </svg>

        <div
          className="absolute inset-0"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
        >
          {blocks.map((block) => {
            const isSelected = selectedId === block.id;
            const isDragging = draggingId === block.id;
            const status = statusOf(block);
            const linked = block.linkedGoalId ? goalById.get(block.linkedGoalId) : null;
            return (
              <Card
                key={block.id}
                data-roadmap-block={block.id}
                role="button"
                tabIndex={0}
                title={block.detail ?? block.title}
                className={cn(
                  "group absolute block cursor-pointer overflow-hidden rounded-lg py-0 select-none",
                  status === "done" && "border-green-700/30 bg-green-500/10",
                  status === "in_progress" && "border-l-2 border-l-(--status-task-icon-in_progress)",
                  !linked && "border-dashed",
                  isSelected && "border-ring ring-2 ring-ring/40",
                  isDragging && "shadow-lg opacity-90",
                )}
                style={{
                  left: block.x + (isDragging ? dragDelta.dx : 0),
                  top: block.y + (isDragging ? dragDelta.dy : 0),
                  width: BLOCK_W,
                  height: BLOCK_H,
                  zIndex: isDragging ? 10 : undefined,
                }}
                onClick={() => {
                  if (!suppressClick.current) setSelectedId(block.id);
                }}
              >
                <div className="flex h-full flex-col justify-center gap-0.5 py-1 pl-2.5 pr-6">
                  <span className="truncate text-xs font-semibold">{block.title}</span>
                  {linked ? (
                    <span className="truncate text-(length:--text-nano) font-medium text-(--hex-22d3ee)">
                      {linked.level === "initiative" ? "⬖" : "◆"} {linked.title}
                    </span>
                  ) : (
                    <span className="truncate text-(length:--text-nano) text-muted-foreground">{block.detail ?? block.status}</span>
                  )}
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      data-roadmap-action
                      aria-label="Make initiative / epic, or link existing"
                      title="Make initiative / epic, or link existing"
                      className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded border border-(--hex-22d3ee) bg-background text-sm font-bold text-(--hex-22d3ee) hover:bg-(--hex-22d3ee) hover:text-white"
                    >
                      +
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 p-1" align="start">
                    <button
                      data-roadmap-action
                      className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50"
                      onClick={() => blockPromote.mutate({ id: block.id, level: "initiative" })}
                    >
                      ⬖ New initiative from this block
                    </button>
                    <p className="px-2 pt-1.5 text-xs text-muted-foreground">New epic under…</p>
                    {initiatives.map((initiative) => (
                      <button
                        key={initiative.id}
                        data-roadmap-action
                        className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50"
                        onClick={() => blockPromote.mutate({ id: block.id, level: "epic", parentGoalId: initiative.id })}
                      >
                        ◆ {initiative.title}
                      </button>
                    ))}
                    <div className="my-1 border-t border-border" />
                    <p className="px-2 pt-0.5 text-xs text-muted-foreground">Link existing epic…</p>
                    {epics.map((epic) => (
                      <button
                        key={epic.id}
                        data-roadmap-action
                        className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50"
                        onClick={() => blockUpdate.mutate({ id: block.id, data: { linkedGoalId: epic.id } })}
                      >
                        ◆ {epic.title}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
              </Card>
            );
          })}
        </div>
      </div>

      <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-border bg-background p-4 md:w-80 md:border-t-0 md:border-l">
        {!selected ? (
          <p className="text-sm text-muted-foreground">
            The long-range board. Select a block to edit it; drag to arrange (shared with the whole team);
            use a block's + to turn it into an initiative or epic when the time comes.
          </p>
        ) : (
          <>
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Roadmap block</p>
              <InlineEditor
                value={selected.title}
                onSave={(title) => blockUpdate.mutateAsync({ id: selected.id, data: { title } })}
                as="h2"
                className="text-lg font-semibold leading-snug"
              />
              <InlineEditor
                value={selected.detail ?? ""}
                onSave={(detail) => blockUpdate.mutateAsync({ id: selected.id, data: { detail } })}
                as="p"
                className="text-sm text-muted-foreground"
                placeholder="Add a detail line…"
                multiline
              />
            </div>

            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</h3>
              <div className="flex gap-1.5">
                {ROADMAP_BLOCK_STATUSES.map((status) => (
                  <Button
                    key={status}
                    size="sm"
                    variant={selected.status === status ? "secondary" : "outline"}
                    onClick={() => blockUpdate.mutate({ id: selected.id, data: { status } })}
                  >
                    {status.replace("_", " ")}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Unlocks</h3>
              <div className="space-y-1">
                {edges.filter((edge) => edge.fromBlockId === selected.id).map((edge) => (
                  <div key={edge.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">→ {blockById.get(edge.toBlockId)?.title ?? "?"}</span>
                    <button
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Remove edge"
                      onClick={() => edgeRemove.mutate(edge.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {edges.filter((edge) => edge.toBlockId === selected.id).map((edge) => (
                  <div key={edge.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">← {blockById.get(edge.fromBlockId)?.title ?? "?"}</span>
                    <button
                      className="hover:text-destructive"
                      aria-label="Remove edge"
                      onClick={() => edgeRemove.mutate(edge.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" className="mt-2">+ add unlocks…</Button>
                </PopoverTrigger>
                <PopoverContent className="max-h-72 w-72 overflow-y-auto p-1" align="start">
                  {blocks.filter((b) => b.id !== selected.id).map((b) => (
                    <button
                      key={b.id}
                      className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50"
                      onClick={() => edgeCreate.mutate({ fromBlockId: selected.id, toBlockId: b.id })}
                    >
                      → {b.title}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            </div>

            <div className="mt-auto pt-2">
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                onClick={() => {
                  blockRemove.mutate(selected.id);
                  setSelectedId(null);
                }}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete block
              </Button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
