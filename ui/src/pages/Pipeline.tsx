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

const AGNB_BASE =
  (import.meta.env.VITE_AGNB_BASE_URL as string | undefined) ??
  "https://www.allgasnobrakes.online";

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

  const move = useMutation({
    mutationFn: ({ dealId, stageId }: { dealId: string; stageId: string }) =>
      pipelineApi.move(dealId, stageId),
    onError: () => {
      // Revert to server truth on failure.
      queryClient.invalidateQueries({ queryKey: queryKeys.agnb.pipeline });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agnb.pipeline });
    },
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

  function handleDragStart(e: DragStartEvent) {
    setActiveCard(cardIndex.get(String(e.active.id))?.card ?? null);
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveCard(null);
    const { active, over } = e;
    if (!over) return;
    const dealId = String(active.id);
    const from = cardIndex.get(dealId)?.columnId;
    if (!from) return;

    // `over` is either a column (droppable) or another card — resolve to a column.
    const overId = String(over.id);
    const toColumn = columns.some((c) => c.id === overId)
      ? overId
      : cardIndex.get(overId)?.columnId;
    if (!toColumn || toColumn === from) return;

    // Optimistic: pull the card out of its column, append to the target.
    setColumns((prev) => {
      const moving = prev
        .flatMap((c) => c.cards)
        .find((c) => c.id === dealId);
      if (!moving) return prev;
      return prev.map((c) => {
        if (c.id === from)
          return { ...c, cards: c.cards.filter((x) => x.id !== dealId) };
        if (c.id === toColumn)
          return {
            ...c,
            cards: [...c.cards, { ...moving, stageLabel: c.label }],
          };
        return c;
      });
    });
    move.mutate({ dealId, stageId: toColumn });
  }

  if (isLoading) return <PageSkeleton variant="list" />;

  const allCards = columns.flatMap((c) => c.cards);
  const syncMin = data?.lastSync
    ? Math.round((Date.now() - new Date(data.lastSync).getTime()) / 60000)
    : null;

  return (
    <div className="space-y-4">
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
              <DroppableColumn key={col.id} column={col} />
            ))}
          </div>
          <DragOverlay>
            {activeCard ? <DealCard card={activeCard} overlay /> : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

function DroppableColumn({ column }: { column: PipelineColumn }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const total = column.cards.reduce((s, c) => s + (c.amount || 0), 0);
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
            <SortableCard key={c.id} card={c} />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableCard({ card }: { card: PipelineCard }) {
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
      <DealCard card={card} />
    </div>
  );
}

function DealCard({ card, overlay }: { card: PipelineCard; overlay?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-background p-2.5",
        overlay ? "shadow-lg" : "transition-colors hover:bg-accent/40",
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
