import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, ExternalLink, MessageSquare } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  useSortable,
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  pipelineApi,
  type PipelineCard,
  type PipelineColumn,
} from "../api/pipeline";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { cn, relativeTime } from "../lib/utils";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { PipelineCardDrawer } from "../components/PipelineCardDrawer";
import { Button } from "@/components/ui/button";

function money(n: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

export function Pipeline() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Pipeline" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.pipeline,
    queryFn: () => pipelineApi.board(),
    refetchInterval: 60_000,
  });

  // Local mirror so drag moves apply optimistically before the server confirms.
  const [columns, setColumns] = useState<PipelineColumn[]>([]);
  useEffect(() => {
    if (data?.columns) setColumns(data.columns);
  }, [data?.columns]);

  const [activeCard, setActiveCard] = useState<PipelineCard | null>(null);
  const [selected, setSelected] = useState<PipelineCard | null>(null);
  const [lostTarget, setLostTarget] = useState<{ dealId: string; toColumn: string } | null>(null);
  const [lostReason, setLostReason] = useState("");

  const move = useMutation({
    mutationFn: ({ dealId, stageId, lost }: { dealId: string; stageId: string; lost?: string }) =>
      pipelineApi.move(dealId, stageId, lost),
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.agnb.pipeline }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.agnb.pipeline }),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const cardIndex = useMemo(() => {
    const m = new Map<string, { card: PipelineCard; columnId: string }>();
    for (const col of columns)
      for (const card of col.cards) m.set(card.id, { card, columnId: col.id });
    return m;
  }, [columns]);

  const isLostStage = (colId: string) => /lost/i.test(columns.find((c) => c.id === colId)?.label ?? "");

  function applyOptimisticMove(dealId: string, toColumn: string) {
    setColumns((prev) => {
      const moving = prev.flatMap((c) => c.cards).find((c) => c.id === dealId);
      if (!moving) return prev;
      return prev.map((c) => {
        if (c.cards.some((x) => x.id === dealId) && c.id !== toColumn)
          return { ...c, cards: c.cards.filter((x) => x.id !== dealId) };
        if (c.id === toColumn) return { ...c, cards: [...c.cards.filter((x) => x.id !== dealId), { ...moving, stageLabel: c.label }] };
        return c;
      });
    });
  }

  // Move with lost-reason interception.
  function requestMove(dealId: string, toColumn: string) {
    const from = cardIndex.get(dealId)?.columnId;
    if (!from || from === toColumn) return;
    if (isLostStage(toColumn)) { setLostTarget({ dealId, toColumn }); return; }
    applyOptimisticMove(dealId, toColumn);
    move.mutate({ dealId, stageId: toColumn });
  }

  function confirmLost() {
    if (!lostTarget) return;
    applyOptimisticMove(lostTarget.dealId, lostTarget.toColumn);
    move.mutate({ dealId: lostTarget.dealId, stageId: lostTarget.toColumn, lost: lostReason.trim() || undefined });
    setLostTarget(null); setLostReason(""); setSelected(null);
  }

  const createDeal = useMutation({
    mutationFn: (body: { dealname: string; dealstage: string }) => pipelineApi.createDeal(body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.agnb.pipeline }),
  });

  function handleDragStart(e: DragStartEvent) {
    setActiveCard(cardIndex.get(String(e.active.id))?.card ?? null);
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveCard(null);
    const { active, over } = e;
    if (!over) return;
    const dealId = String(active.id);
    const overId = String(over.id);
    const toColumn = columns.some((c) => c.id === overId) ? overId : cardIndex.get(overId)?.columnId;
    if (toColumn) requestMove(dealId, toColumn);
  }

  if (isLoading) return <PageSkeleton variant="list" />;

  const allCards = columns.flatMap((c) => c.cards);
  const syncMin = data?.lastSync
    ? Math.round((Date.now() - new Date(data.lastSync).getTime()) / 60000)
    : null;

  return (
    <div className="space-y-4">
      <AgnbSubnav group="pipeline" />
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">Pipeline</h1>
            <span className="rounded bg-[#FF7A59]/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#FF7A59]">
              HS
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            HubSpot deals by stage. Drag a card between columns to move the deal;
            open it to act in HubSpot.
          </p>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {move.isPending ? "saving…" : syncMin != null ? `synced ${syncMin}m ago` : "no sync"}
        </span>
      </div>

      {error && (
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      )}

      {(data?.errors?.length ?? 0) > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="mb-1 font-semibold">HubSpot scope issues — partial data:</p>
          {data!.errors.map((e, i) => (
            <p key={i} className="break-all font-mono opacity-90">{e}</p>
          ))}
        </div>
      )}

      {(data?.funnel?.length ?? 0) > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {data!.funnel.map((s) => (
            <div
              key={s.stageId}
              className="min-w-[120px] shrink-0 rounded-md border border-border p-2"
            >
              <div className="truncate text-xs font-medium">{s.label}</div>
              <div className="text-sm font-semibold">{Math.round(s.reachedPct)}%</div>
              <div className="text-[11px] text-muted-foreground">
                {s.count} · {money(s.amount) || "$0"}
              </div>
            </div>
          ))}
        </div>
      )}

      {allCards.length === 0 ? (
        <EmptyState icon={LayoutGrid} message="No deals yet." />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-3 overflow-x-auto pb-2">
            {columns.map((col) => (
              <DroppableColumn
                key={col.id}
                column={col}
                onOpen={setSelected}
                onCreate={(dealname) => createDeal.mutate({ dealname, dealstage: col.id })}
              />
            ))}
          </div>
          <DragOverlay>
            {activeCard ? <DealCard card={activeCard} overlay /> : null}
          </DragOverlay>
        </DndContext>
      )}

      {selected && (
        <PipelineCardDrawer
          card={selected}
          columns={columns}
          onClose={() => setSelected(null)}
          onMove={(stageId) => { requestMove(selected.id, stageId); setSelected(null); }}
        />
      )}

      {lostTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={() => setLostTarget(null)}>
          <div className="w-full max-w-md rounded-lg border border-border bg-background p-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">Mark deal as Closed Lost?</h3>
            <p className="mt-1 text-xs text-muted-foreground">Capture a reason so the win/loss analyzer can learn.</p>
            <textarea
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              rows={3}
              placeholder="Why did this deal fail? (budget, timing, competitor, no-budget, ghost…)"
              className="mt-2 w-full rounded-md border border-border bg-background p-2 text-sm"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setLostTarget(null)}>Cancel</Button>
              <Button variant="destructive" size="sm" onClick={confirmLost}>Mark Lost</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DroppableColumn({ column, onOpen, onCreate }: { column: PipelineColumn; onOpen: (c: PipelineCard) => void; onCreate: (dealname: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const total = column.cards.reduce((s, c) => s + (c.amount || 0), 0);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const submit = () => { if (name.trim()) { onCreate(name.trim()); setName(""); setAdding(false); } };
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-lg border bg-muted/30 transition-colors",
        isOver ? "border-foreground/40 bg-accent/40" : "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{column.label}</span>
          <span className="text-xs text-muted-foreground">{column.cards.length}</span>
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">{money(total)}</span>
      </div>
      <SortableContext
        items={column.cards.map((c) => c.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex min-h-[40px] flex-col gap-2 p-2">
          {column.cards.map((c) => (
            <SortableCard key={c.id} card={c} onOpen={onOpen} />
          ))}
          {adding ? (
            <div className="flex flex-col gap-1">
              <textarea
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
                rows={2}
                placeholder="Deal name…"
                className="rounded-md border border-border bg-background p-1.5 text-xs"
              />
              <div className="flex gap-1">
                <button onClick={submit} className="rounded bg-foreground px-2 py-0.5 text-xs text-background">Add card</button>
                <button onClick={() => { setAdding(false); setName(""); }} className="px-2 py-0.5 text-xs text-muted-foreground">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent/50">+ Add a card</button>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableCard({ card, onOpen }: { card: PipelineCard; onOpen: (c: PipelineCard) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: card.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
    >
      <DealCard card={card} onOpen={onOpen} />
    </div>
  );
}

function DealCard({ card, overlay, onOpen }: { card: PipelineCard; overlay?: boolean; onOpen?: (c: PipelineCard) => void }) {
  return (
    <div
      onClick={() => onOpen?.(card)}
      className={cn(
        "rounded-md border border-border bg-background p-2.5",
        overlay ? "shadow-lg" : "cursor-pointer transition-colors hover:bg-accent/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-sm font-medium">{card.name}</span>
        <a
          href={card.hubspotUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          title="Open in HubSpot"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {card.company?.name && (
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          🏢 {card.company.name}
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{card.ownerName}</span>
        {card.amount > 0 && (
          <span className="font-mono text-xs font-medium">{money(card.amount)}</span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        {card.priority && <Badge variant="outline">{card.priority}</Badge>}
        {(card.commentCount ?? 0) > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <MessageSquare className="h-3 w-3" />
            {card.commentCount}
          </span>
        )}
        {(card.probability ?? 0) > 0 && <span>{card.probability}%</span>}
        {card.closeAt && <span className="ml-auto">{relativeTime(card.closeAt)}</span>}
      </div>
    </div>
  );
}
