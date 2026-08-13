import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { GripVertical, Map as MapIcon, MoreHorizontal, Plus, Target } from "lucide-react";
import type { Goal, GoalRelation, GoalTarget } from "@paperclipai/shared";
import { GOAL_STATUSES } from "@paperclipai/shared";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { InlineEditor } from "../components/InlineEditor";
import { StatusBadge } from "../components/StatusBadge";

interface TargetTreeNode {
  target: GoalTarget;
  children: TargetTreeNode[];
}

function buildTargetTree(targets: GoalTarget[], goalId: string): TargetTreeNode[] {
  const forGoal = targets
    .filter((t) => t.goalId === goalId)
    .sort((a, b) => a.sortOrder - b.sortOrder || String(a.createdAt).localeCompare(String(b.createdAt)));
  const byId = new Map(forGoal.map((t) => [t.id, { target: t, children: [] as TargetTreeNode[] }]));
  const roots: TargetTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.target.parentId ? byId.get(node.target.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function PlannerActionsMenu({
  trigger,
  initiatives,
  epics,
  subjectLabel,
  onLink,
  onCreate,
  extraActions,
}: {
  trigger: React.ReactNode;
  initiatives: Goal[];
  epics: Goal[];
  subjectLabel: string;
  onLink: (goal: Goal) => void;
  onCreate: (level: "initiative" | "epic", title: string, parentInitiativeId: string | null) => void;
  extraActions: Array<{ label: string; destructive?: boolean; onClick: () => void }>;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"main" | "link" | "name" | "epicPick">("main");
  const [pendingLevel, setPendingLevel] = useState<"initiative" | "epic">("initiative");
  const [pendingParent, setPendingParent] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const itemCls = "flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50";
  const submit = () => {
    if (!title.trim()) return;
    onCreate(pendingLevel, title.trim(), pendingParent);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setView("main");
          setTitle("");
          setPendingParent(null);
        }
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-72 p-1" align="end">
        {view === "main" && (
          <>
            <button className={itemCls} onClick={() => setView("link")}>🔗 Link existing initiative / epic…</button>
            <button
              className={itemCls}
              onClick={() => { setPendingLevel("initiative"); setPendingParent(null); setView("name"); }}
            >
              ⬖ New initiative from this {subjectLabel}
            </button>
            <button
              className={itemCls}
              onClick={() => { setPendingLevel("epic"); setView(initiatives.length > 0 ? "epicPick" : "name"); }}
            >
              ◆ New epic from this {subjectLabel}
            </button>
            <div className="my-1 border-t border-border" />
            {extraActions.map((action) => (
              <button
                key={action.label}
                className={cn(itemCls, action.destructive && "text-destructive")}
                onClick={() => { action.onClick(); setOpen(false); }}
              >
                {action.label}
              </button>
            ))}
          </>
        )}
        {view === "link" && (
          <>
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Link an existing initiative or epic</p>
            <div className="max-h-64 overflow-y-auto">
              {[...initiatives, ...epics].map((g) => (
                <button key={g.id} className={itemCls} onClick={() => { onLink(g); setOpen(false); }}>
                  {g.level === "initiative" ? "⬖ " : "◆ "}
                  <span className="truncate">{g.title}</span>
                </button>
              ))}
              {initiatives.length + epics.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Nothing to link yet.</p>
              )}
            </div>
          </>
        )}
        {view === "epicPick" && (
          <>
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Which initiative does the new epic belong to?</p>
            {initiatives.map((g) => (
              <button key={g.id} className={itemCls} onClick={() => { setPendingParent(g.id); setView("name"); }}>
                ⬖ <span className="truncate">{g.title}</span>
              </button>
            ))}
          </>
        )}
        {view === "name" && (
          <div className="p-2">
            <p className="mb-1.5 text-xs text-muted-foreground">
              {pendingLevel === "initiative" ? "New initiative" : "New epic"} title
            </p>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="Title…"
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus-visible:ring-ring focus-visible:ring-[3px] focus-visible:outline-none"
            />
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={!title.trim()} onClick={submit}>Create</Button>
              <Button size="sm" variant="outline" onClick={() => setView("main")}>Back</Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function countTargets(nodes: TargetTreeNode[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const walk = (list: TargetTreeNode[]) => {
    for (const node of list) {
      total += 1;
      if (node.target.checked) done += 1;
      walk(node.children);
    }
  };
  walk(nodes);
  return { done, total };
}

export function Goals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: targets } = useQuery({
    queryKey: queryKeys.goals.targets(selectedCompanyId!),
    queryFn: () => goalsApi.targets(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: relations } = useQuery({
    queryKey: queryKeys.goals.relations(selectedCompanyId!),
    queryFn: () => goalsApi.relations(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const invalidate = useCallback(() => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(selectedCompanyId) });
  }, [queryClient, selectedCompanyId]);

  const goalMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => goalsApi.update(id, data),
    onSettled: invalidate,
  });
  const goalCreate = useMutation({
    mutationFn: (data: Record<string, unknown>) => goalsApi.create(selectedCompanyId!, data),
    onSettled: invalidate,
  });
  const goalRemove = useMutation({
    mutationFn: (id: string) => goalsApi.remove(id),
    onSettled: invalidate,
  });
  const targetCreate = useMutation({
    mutationFn: ({ goalId, data }: { goalId: string; data: Record<string, unknown> }) =>
      goalsApi.targetCreate(goalId, data),
    onSettled: invalidate,
  });
  const targetUpdate = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => goalsApi.targetUpdate(id, data),
    onSettled: invalidate,
  });
  const targetRemove = useMutation({
    mutationFn: (id: string) => goalsApi.targetRemove(id),
    onSettled: invalidate,
  });
  const relationCreate = useMutation({
    mutationFn: (data: { fromGoalId: string; toGoalId?: string | null; toTargetId?: string | null }) =>
      goalsApi.relationCreate(selectedCompanyId!, { type: "serves", ...data }),
    onSettled: invalidate,
  });
  const relationRemove = useMutation({
    mutationFn: (id: string) => goalsApi.relationRemove(id),
    onSettled: invalidate,
  });

  const northStar = useMemo(
    () => (goals ?? []).find((g) => g.level === "company") ?? null,
    [goals],
  );
  const objectives = useMemo(
    () => (goals ?? [])
      .filter((g) => g.level === "objective")
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt))),
    [goals],
  );
  const initiatives = useMemo(
    () => (goals ?? []).filter((g) => g.level === "initiative"),
    [goals],
  );
  const epics = useMemo(
    () => (goals ?? []).filter((g) => g.level === "epic"),
    [goals],
  );
  const goalById = useMemo(() => new Map((goals ?? []).map((g) => [g.id, g])), [goals]);
  const relationsByGoal = useMemo(() => {
    const map = new Map<string, GoalRelation[]>();
    for (const relation of relations ?? []) {
      if (!relation.toGoalId) continue;
      const list = map.get(relation.toGoalId) ?? [];
      list.push(relation);
      map.set(relation.toGoalId, list);
    }
    return map;
  }, [relations]);
  const relationsByTarget = useMemo(() => {
    const map = new Map<string, GoalRelation[]>();
    for (const relation of relations ?? []) {
      if (!relation.toTargetId) continue;
      const list = map.get(relation.toTargetId) ?? [];
      list.push(relation);
      map.set(relation.toTargetId, list);
    }
    return map;
  }, [relations]);

  // Drag-to-reorder (goal cards and target rows).
  const dragRef = useRef<{ kind: "goal" | "target"; id: string } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const reorderObjectives = useCallback((movedId: string, beforeId: string | null) => {
    const order = objectives.filter((g) => g.id !== movedId).map((g) => g.id);
    const index = beforeId ? order.indexOf(beforeId) : order.length;
    order.splice(index < 0 ? order.length : index, 0, movedId);
    order.forEach((id, i) => {
      const goal = goalById.get(id);
      if (goal && (goal.sortOrder ?? 0) !== i) goalMutation.mutate({ id, data: { sortOrder: i } });
    });
  }, [objectives, goalById, goalMutation]);

  const reorderTarget = useCallback((movedId: string, goalId: string, parentId: string | null, beforeId: string | null) => {
    const moved = (targets ?? []).find((t) => t.id === movedId);
    if (!moved) return;
    const siblings = (targets ?? [])
      .filter((t) => t.goalId === goalId && (t.parentId ?? null) === parentId && t.id !== movedId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const order = siblings.map((t) => t.id);
    const index = beforeId ? order.indexOf(beforeId) : order.length;
    order.splice(index < 0 ? order.length : index, 0, movedId);
    const patches: Array<{ id: string; data: Record<string, unknown> }> = [];
    order.forEach((id, i) => {
      const existing = (targets ?? []).find((t) => t.id === id);
      const data: Record<string, unknown> = {};
      if (existing?.sortOrder !== i) data.sortOrder = i;
      if (id === movedId) {
        if ((moved.parentId ?? null) !== parentId) data.parentId = parentId;
        if (moved.goalId !== goalId) data.goalId = goalId;
      }
      if (Object.keys(data).length > 0) patches.push({ id, data });
    });
    patches.forEach((patch) => targetUpdate.mutate(patch));
  }, [targets, targetUpdate]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view goals." />;
  }
  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const createLinkedGoal = async (
    level: "initiative" | "epic",
    title: string,
    parentInitiativeId: string | null,
    link: { toGoalId?: string; toTargetId?: string },
  ) => {
    const parentId = level === "initiative" ? northStar?.id ?? null : parentInitiativeId;
    const created = await goalsApi.create(selectedCompanyId!, { title, level, status: "active", parentId });
    await goalsApi.relationCreate(selectedCompanyId!, { type: "serves", fromGoalId: created.id, ...link });
    invalidate();
  };

  const renderChips = (relationList: GoalRelation[]) => relationList.map((relation) => {
    const linked = relation.fromGoalId ? goalById.get(relation.fromGoalId) : null;
    if (!linked) return null;
    return (
      <span
        key={relation.id}
        className="group/chip inline-flex items-center gap-1 rounded bg-accent/60 px-1.5 py-0.5 text-xs font-medium"
        title={`${linked.level}: ${linked.title}`}
      >
        {linked.level === "initiative" ? "⬖" : "◆"} {linked.title}
        <button
          className="hidden text-muted-foreground hover:text-destructive group-hover/chip:inline"
          aria-label="Unlink"
          onClick={() => relationRemove.mutate(relation.id)}
        >
          ×
        </button>
      </span>
    );
  });

  const renderTargetRow = (goal: Goal, node: TargetTreeNode, depth: number): React.ReactNode => {
    const target = node.target;
    return (
      <div key={target.id}>
        <div
          className={cn(
            "group flex items-start gap-2 rounded px-1 py-0.5",
            dragOverId === target.id && "border-t-2 border-ring",
          )}
          style={{ marginLeft: depth * 24 }}
          draggable
          onDragStart={(e) => {
            dragRef.current = { kind: "target", id: target.id };
            e.stopPropagation();
          }}
          onDragOver={(e) => {
            if (dragRef.current?.kind !== "target") return;
            e.preventDefault();
            e.stopPropagation();
            setDragOverId(target.id);
          }}
          onDragLeave={() => setDragOverId((current) => (current === target.id ? null : current))}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOverId(null);
            const drag = dragRef.current;
            dragRef.current = null;
            if (drag?.kind === "target" && drag.id !== target.id) {
              reorderTarget(drag.id, goal.id, target.parentId ?? null, target.id);
            }
          }}
        >
          <GripVertical className="mt-1 h-3.5 w-3.5 shrink-0 cursor-grab text-transparent group-hover:text-muted-foreground/60" />
          <button
            aria-label={target.checked ? "Mark not done" : "Mark done"}
            className={cn(
              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]",
              target.checked ? "border-green-600 bg-green-600 text-white" : "border-border bg-background text-transparent",
            )}
            onClick={() => targetUpdate.mutate({ id: target.id, data: { checked: !target.checked } })}
          >
            ✓
          </button>
          <span className={cn("min-w-0 flex-1 text-sm", target.checked && "text-muted-foreground line-through")}>
            <InlineEditor
              value={target.text}
              onSave={(text) => targetUpdate.mutateAsync({ id: target.id, data: { text } })}
              as="span"
              className="text-sm"
            />
          </span>
          <span className="flex shrink-0 flex-wrap items-center gap-1">
            {renderChips(relationsByTarget.get(target.id) ?? [])}
          </span>
          <PlannerActionsMenu
            trigger={
              <button
                className="mt-0.5 shrink-0 rounded border border-border px-1 text-muted-foreground/70 hover:border-ring hover:text-foreground"
                aria-label="Target actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            }
            initiatives={initiatives}
            epics={epics}
            subjectLabel="target"
            onLink={(g) => relationCreate.mutate({ fromGoalId: g.id, toTargetId: target.id })}
            onCreate={(level, title, parent) => { void createLinkedGoal(level, title, parent, { toTargetId: target.id }); }}
            extraActions={[
              {
                label: "＋ Add sub-item",
                onClick: () => targetCreate.mutate({ goalId: goal.id, data: { parentId: target.id, text: "New sub-item" } }),
              },
              { label: "🗑 Delete target", destructive: true, onClick: () => targetRemove.mutate(target.id) },
            ]}
          />
        </div>
        {node.children.map((child) => renderTargetRow(goal, child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {northStar && (
        <div className="rounded-lg border border-border bg-accent/30 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">North Star</p>
          <InlineEditor
            value={northStar.title}
            onSave={(title) => goalMutation.mutateAsync({ id: northStar.id, data: { title } })}
            as="h2"
            className="mt-1 text-lg font-bold leading-snug"
          />
          <InlineEditor
            value={northStar.description ?? ""}
            onSave={(description) => goalMutation.mutateAsync({ id: northStar.id, data: { description } })}
            as="p"
            className="mt-1 text-sm text-muted-foreground"
            placeholder="Describe the ultimate goal…"
            multiline
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => goalCreate.mutate({ title: "New goal", level: "objective", status: "active", parentId: northStar?.id ?? null, sortOrder: objectives.length })}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New goal
        </Button>
        <Link to="/goals/map" className="ml-auto">
          <Button size="sm" variant="outline">
            <MapIcon className="mr-1.5 h-3.5 w-3.5" />
            Initiatives Map
          </Button>
        </Link>
      </div>

      {objectives.length === 0 && (
        <EmptyState icon={Target} message="No goals yet. Add the first one." />
      )}

      {objectives.map((goal) => {
        const tree = buildTargetTree(targets ?? [], goal.id);
        const counts = countTargets(tree);
        return (
          <div
            key={goal.id}
            className={cn(
              "group/goal rounded-lg border border-border bg-card px-5 py-4",
              dragOverId === goal.id && "border-t-2 border-t-ring",
            )}
            onDragOver={(e) => {
              if (dragRef.current?.kind !== "goal") return;
              e.preventDefault();
              setDragOverId(goal.id);
            }}
            onDragLeave={() => setDragOverId((current) => (current === goal.id ? null : current))}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverId(null);
              const drag = dragRef.current;
              dragRef.current = null;
              if (drag?.kind === "goal" && drag.id !== goal.id) reorderObjectives(drag.id, goal.id);
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                draggable
                onDragStart={() => { dragRef.current = { kind: "goal", id: goal.id }; }}
                className="cursor-grab"
              >
                <GripVertical className="h-4 w-4 text-transparent group-hover/goal:text-muted-foreground/60" />
              </span>
              <InlineEditor
                value={goal.title}
                onSave={(title) => goalMutation.mutateAsync({ id: goal.id, data: { title } })}
                as="span"
                className="text-sm font-bold"
              />
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {counts.done}/{counts.total} targets met
              </span>
              <span className="flex flex-wrap items-center gap-1">
                {renderChips(relationsByGoal.get(goal.id) ?? [])}
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="rounded-full">
                      <StatusBadge status={goal.status} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-44 p-1" align="end">
                    {GOAL_STATUSES.map((status) => (
                      <button
                        key={status}
                        className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50"
                        onClick={() => goalMutation.mutate({ id: goal.id, data: { status } })}
                      >
                        {status}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
                <PlannerActionsMenu
                  trigger={
                    <button
                      className="rounded border border-border px-1 py-0.5 text-muted-foreground/70 hover:border-ring hover:text-foreground"
                      aria-label="Goal actions"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  }
                  initiatives={initiatives}
                  epics={epics}
                  subjectLabel="goal"
                  onLink={(g) => relationCreate.mutate({ fromGoalId: g.id, toGoalId: goal.id })}
                  onCreate={(level, title, parent) => { void createLinkedGoal(level, title, parent, { toGoalId: goal.id }); }}
                  extraActions={[
                    {
                      label: "＋ Add target",
                      onClick: () => targetCreate.mutate({ goalId: goal.id, data: { text: "New target" } }),
                    },
                    { label: "🗑 Delete goal", destructive: true, onClick: () => goalRemove.mutate(goal.id) },
                  ]}
                />
              </span>
            </div>

            <div className="mt-2 space-y-0.5">
              {tree.map((node) => renderTargetRow(goal, node, 0))}
            </div>
            <button
              className="mt-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => targetCreate.mutate({ goalId: goal.id, data: { text: "New target" } })}
            >
              + add target
            </button>
          </div>
        );
      })}
    </div>
  );
}
