import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../../api/agents";
import { plansApi, type PlanTier } from "../../api/plans";
import { useToastActions } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { manualRequestedChildren } from "../../lib/hive-board";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface NewPlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string | null;
}

type Mode = "manual" | "assign";

// Two authoring paths (both produce a draft — nothing runs until Activate):
//  • manual  — operator types tier-1 task titles (one per line)
//  • assign  — hand it to an agent (e.g. a CTO) to draft the tiers
export function NewPlanDialog({ open, onOpenChange, companyId }: NewPlanDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [mode, setMode] = useState<Mode>("manual");
  const [title, setTitle] = useState("");
  const [overview, setOverview] = useState("");
  const [tasksText, setTasksText] = useState("");
  const [capTokens, setCapTokens] = useState("");
  const [assigneeAgentId, setAssigneeAgentId] = useState<string>("");

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId && open,
  });

  const reset = () => {
    setTitle("");
    setOverview("");
    setTasksText("");
    setCapTokens("");
    setAssigneeAgentId("");
    setMode("manual");
  };

  const taskTitles = tasksText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const create = useMutation({
    mutationFn: () => {
      const tokens = capTokens.trim() ? Number(capTokens.trim()) : null;
      let tiers: PlanTier[] | undefined;
      if (mode === "manual") {
        // In manual mode assigneeAgentId (optional) is applied per-task so the
        // materialized tickets are assigned on Activate and the agent wakes.
        // (In assign mode the same state means the plan's drafting agent.)
        tiers = [
          {
            id: "tier-1",
            kind: "phase",
            name: "Phase 1",
            requestedChildren: manualRequestedChildren(taskTitles, assigneeAgentId || undefined),
            childIssueIds: [],
          },
        ];
      }
      return plansApi.create({
        companyId: companyId!,
        title: title.trim(),
        overview: overview.trim() || null,
        tiers,
        budgetCapTokens: tokens && Number.isFinite(tokens) ? tokens : null,
        assigneeAgentId: mode === "assign" ? assigneeAgentId || null : null,
      });
    },
    onSuccess: () => {
      pushToast({
        title: "Plan created",
        body: mode === "assign" ? "Agent will draft it. Activate when ready." : "Draft saved. Activate when ready.",
        tone: "success",
      });
      if (companyId) queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      reset();
      onOpenChange(false);
    },
    onError: (e) =>
      pushToast({ title: "Create failed", body: errMsg(e), tone: "error" }),
  });

  // Manual plans must declare at least one first-phase task, else the resulting
  // draft has no tier-1 tickets and Activate would fail server-side.
  const canSubmit =
    title.trim().length > 0 &&
    (mode === "manual" ? taskTitles.length > 0 : assigneeAgentId.length > 0);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New plan</DialogTitle>
          <DialogDescription>
            Plans stay as drafts until you activate them — no agent runs on creation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="plan-title">Title</Label>
            <Input
              id="plan-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Build the billing dashboard"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="plan-overview">Overview</Label>
            <Textarea
              id="plan-overview"
              value={overview}
              onChange={(e) => setOverview(e.target.value)}
              placeholder="What this plan is about (optional)"
              rows={2}
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode("manual")}
              className={`flex-1 rounded-md border px-3 py-2 text-sm ${mode === "manual" ? "border-primary bg-primary/5 font-medium" : "border-border text-muted-foreground"}`}
            >
              I'll write the tasks
            </button>
            <button
              type="button"
              onClick={() => setMode("assign")}
              className={`flex-1 rounded-md border px-3 py-2 text-sm ${mode === "assign" ? "border-primary bg-primary/5 font-medium" : "border-border text-muted-foreground"}`}
            >
              Assign to an agent
            </button>
          </div>

          {mode === "manual" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="plan-tasks">First-phase tasks (one per line)</Label>
                <Textarea
                  id="plan-tasks"
                  value={tasksText}
                  onChange={(e) => setTasksText(e.target.value)}
                  placeholder={"Set up Stripe webhook\nBuild invoice list view\nAdd usage chart"}
                  rows={4}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Assign tasks to (optional)</Label>
                <Select value={assigneeAgentId} onValueChange={setAssigneeAgentId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned — pick an agent to wake on activate" />
                  </SelectTrigger>
                  <SelectContent>
                    {(agents ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                        {a.title ? ` · ${a.title}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  When set, every task is assigned to this agent and it wakes once you activate.
                </p>
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label>Drafting agent</Label>
              <Select value={assigneeAgentId} onValueChange={setAssigneeAgentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an agent to draft the plan…" />
                </SelectTrigger>
                <SelectContent>
                  {(agents ?? []).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {a.title ? ` · ${a.title}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="plan-cap">Token budget cap (optional)</Label>
            <Input
              id="plan-cap"
              type="number"
              min={0}
              value={capTokens}
              onChange={(e) => setCapTokens(e.target.value)}
              placeholder="e.g. 500000 — auto-stops the plan when hit"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!canSubmit || create.isPending}>
            {create.isPending ? "Creating…" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}
