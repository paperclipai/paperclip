import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookTemplate,
  ChevronRight,
  Clock,
  Folder,
  Play,
  Plus,
  Sparkles,
  Users,
  CheckCircle2,
  ArrowRight,
} from "lucide-react";
import { playbooksApi, type Playbook, type PlaybookWithSteps } from "../api/playbooks";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { MarkdownBody } from "../components/MarkdownBody";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { NewPlaybookDialog } from "../components/NewPlaybookDialog";
import { RunPlaybookDialog } from "../components/RunPlaybookDialog";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const CATEGORY_COLORS: Record<string, string> = {
  onboarding: "bg-green-500/10 text-green-600 dark:text-green-400",
  security: "bg-red-500/10 text-red-600 dark:text-red-400",
  engineering: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  operations: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  marketing: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  custom: "bg-muted text-muted-foreground",
};

function formatMinutes(mins: number | null): string {
  if (!mins) return "";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/* ------------------------------------------------------------------ */
/*  Playbook Card (left panel)                                         */
/* ------------------------------------------------------------------ */

function PlaybookCard({
  playbook,
  isSelected,
  onSelect,
}: {
  playbook: Playbook;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "w-full text-left p-3 border-b border-border transition-colors",
        isSelected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium flex-1 truncate">{playbook.name}</span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <span
          className={cn(
            "inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-medium",
            CATEGORY_COLORS[playbook.category] ?? CATEGORY_COLORS.custom,
          )}
        >
          {playbook.category}
        </span>
        {playbook.runCount > 0 && (
          <span className="text-[11px] text-muted-foreground flex items-center gap-0.5">
            <Play className="h-3 w-3" />
            {playbook.runCount}x
          </span>
        )}
      </div>
      {playbook.description && (
        <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">
          {playbook.description}
        </p>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Step Timeline                                                      */
/* ------------------------------------------------------------------ */

function StepTimeline({ playbook }: { playbook: PlaybookWithSteps }) {
  return (
    <div className="space-y-0">
      {playbook.steps.map((step, idx) => {
        const isLast = idx === playbook.steps.length - 1;
        return (
          <div key={step.id} className="flex gap-3">
            {/* Timeline line + dot */}
            <div className="flex flex-col items-center pt-1">
              <div className="flex items-center justify-center h-6 w-6 rounded-full bg-accent border border-border text-xs font-medium shrink-0">
                {step.stepOrder}
              </div>
              {!isLast && <div className="w-px flex-1 bg-border my-1" />}
            </div>

            {/* Step content */}
            <div className={cn("flex-1 pb-4", isLast && "pb-0")}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{step.title}</span>
                {step.requiresApproval && (
                  <Tooltip delayDuration={300}>
                    <TooltipTrigger>
                      <CheckCircle2 className="h-3.5 w-3.5 text-amber-500" />
                    </TooltipTrigger>
                    <TooltipContent className="text-xs">Requires approval</TooltipContent>
                  </Tooltip>
                )}
              </div>

              <div className="flex items-center gap-2 mt-1">
                {step.assigneeRole && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
                    <Users className="h-3 w-3" />
                    {step.assigneeRole}
                  </span>
                )}
                {step.dependsOn && step.dependsOn.length > 0 && (
                  <span className="text-[11px] text-muted-foreground flex items-center gap-0.5">
                    <ArrowRight className="h-3 w-3" />
                    after step {step.dependsOn.join(", ")}
                  </span>
                )}
              </div>

              {step.instructions && (
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                  {step.instructions}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Playbook Detail (right panel)                                      */
/* ------------------------------------------------------------------ */

function PlaybookDetail({
  companyId,
  playbookId,
  onRun,
  isRunning,
}: {
  companyId: string;
  playbookId: string;
  onRun: () => void;
  isRunning: boolean;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.playbooks.detail(companyId, playbookId),
    queryFn: () => playbooksApi.detail(companyId, playbookId),
  });

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error || !data) {
    return (
      <div className="p-6 text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load playbook"}
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-6 max-w-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold">{data.name}</h2>
            {data.description && (
              <p className="text-sm text-muted-foreground mt-1">{data.description}</p>
            )}
          </div>
          <Button size="sm" onClick={onRun} disabled={isRunning}>
            <Play className="h-3.5 w-3.5 mr-1.5" />
            {isRunning ? "Running..." : "Run Playbook"}
          </Button>
        </div>

        {/* Meta chips */}
        <div className="flex items-center gap-2 mb-6">
          <span
            className={cn(
              "inline-flex px-2 py-1 rounded-full text-xs font-medium",
              CATEGORY_COLORS[data.category] ?? CATEGORY_COLORS.custom,
            )}
          >
            {data.category}
          </span>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground bg-muted px-2 py-1 rounded-full">
            {data.steps.length} step{data.steps.length !== 1 ? "s" : ""}
          </span>
          {data.runCount > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground bg-muted px-2 py-1 rounded-full">
              <Play className="h-3 w-3" />
              Run {data.runCount}x
            </span>
          )}
        </div>

        {/* Body description */}
        {data.body && (
          <div className="mb-6 p-4 rounded-lg bg-muted/30 border border-border">
            <MarkdownBody>{data.body}</MarkdownBody>
          </div>
        )}

        {/* Steps timeline */}
        <div className="mb-4">
          <h3 className="text-sm font-semibold mb-4">Steps</h3>
          <StepTimeline playbook={data} />
        </div>
      </div>
    </ScrollArea>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Playbooks Page                                                */
/* ------------------------------------------------------------------ */

export function Playbooks() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Playbooks" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [showRunDialog, setShowRunDialog] = useState(false);

  const { data: playbooksList, isLoading } = useQuery({
    queryKey: queryKeys.playbooks.list(selectedCompanyId!),
    queryFn: () => playbooksApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const runMutation = useMutation({
    mutationFn: ({ playbookId, name, repoUrl }: { playbookId: string; name?: string; repoUrl?: string }) =>
      playbooksApi.run(selectedCompanyId!, playbookId, undefined /* projectId */, name, repoUrl),
    onSuccess: (data) => {
      pushToast({
        title: "Playbook started",
        body: `${data.stepsCreated} tasks created`,
        tone: "success",
      });
      setShowRunDialog(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.playbooks.list(selectedCompanyId!) });
      if (selectedId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.playbooks.detail(selectedCompanyId!, selectedId) });
      }
    },
    onError: () => {
      pushToast({ title: "Failed to run playbook", tone: "error" });
    },
  });

  const createMutation = useMutation({
    mutationFn: (payload: Parameters<typeof playbooksApi.create>[1]) =>
      playbooksApi.create(selectedCompanyId!, payload),
    onSuccess: (data) => {
      pushToast({ title: "Playbook created", body: data.name, tone: "success" });
      queryClient.invalidateQueries({ queryKey: queryKeys.playbooks.list(selectedCompanyId!) });
      setSelectedId(data.id);
      setShowNewDialog(false);
    },
    onError: () => {
      pushToast({ title: "Failed to create playbook", tone: "error" });
    },
  });

  const seedMutation = useMutation({
    mutationFn: () => playbooksApi.seed(selectedCompanyId!),
    onSuccess: (data) => {
      if (data.seeded) {
        pushToast({ title: "Playbooks seeded", body: `${data.count} playbook templates added`, tone: "success" });
      } else {
        pushToast({ title: "Already seeded", body: "Default playbooks already exist", tone: "info" });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.playbooks.list(selectedCompanyId!) });
    },
  });

  const filteredPlaybooks = (playbooksList ?? []).filter(
    (pb) =>
      !filter ||
      pb.name.toLowerCase().includes(filter.toLowerCase()) ||
      pb.category.toLowerCase().includes(filter.toLowerCase()),
  );

  // Group by category
  const grouped = filteredPlaybooks.reduce(
    (acc, pb) => {
      const cat = pb.category;
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(pb);
      return acc;
    },
    {} as Record<string, Playbook[]>,
  );

  if (!selectedCompanyId) return null;

  const totalPlaybooks = filteredPlaybooks.length;

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)] overflow-hidden">
      {/* Page header — matches Goals, Issues, Routines */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Playbooks</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Multi-agent workflows you can run with one click.
          </p>
          {totalPlaybooks > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {totalPlaybooks} playbook{totalPlaybooks !== 1 ? "s" : ""} available
            </p>
          )}
        </div>
        <Button size="sm" onClick={() => setShowNewDialog(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Create Playbook
        </Button>
      </div>

      {/* Two-pane content */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left pane: Playbook list */}
      <div className="w-80 shrink-0 border-r border-border flex flex-col bg-background">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter playbooks..."
            className="h-7 text-xs"
          />
        </div>


        <ScrollArea className="flex-1 min-h-0">
          {isLoading ? (
            <div className="p-3">
              <PageSkeleton variant="list" />
            </div>
          ) : filteredPlaybooks.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <BookTemplate className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No playbooks yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Click the sparkle icon to load templates
              </p>
            </div>
          ) : (
            Object.entries(grouped).map(([category, pbs]) => (
              <div key={category}>
                <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider bg-muted/30 border-b border-border">
                  {category}
                </div>
                {pbs.map((pb) => (
                  <PlaybookCard
                    key={pb.id}
                    playbook={pb}
                    isSelected={pb.id === selectedId}
                    onSelect={() => setSelectedId(pb.id)}
                  />
                ))}
              </div>
            ))
          )}
        </ScrollArea>
      </div>

      {/* Right pane: Detail */}
      <div className="flex-1 min-w-0 bg-background">
        {selectedId ? (
          <PlaybookDetail
            companyId={selectedCompanyId}
            playbookId={selectedId}
            onRun={() => setShowRunDialog(true)}
            isRunning={runMutation.isPending}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <BookTemplate className="h-12 w-12 text-muted-foreground/20 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">
              Select a playbook to view
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Playbooks are reusable multi-agent workflows. Select one to see the steps, or load templates to get started.
            </p>
            {(!playbooksList || playbooksList.length === 0) && (
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => seedMutation.mutate()}
                disabled={seedMutation.isPending}
              >
                <Sparkles className={cn("h-3.5 w-3.5 mr-1.5", seedMutation.isPending && "animate-pulse")} />
                Load Template Playbooks
              </Button>
            )}
          </div>
        )}
      </div>

      </div>

      <NewPlaybookDialog
        open={showNewDialog}
        onOpenChange={setShowNewDialog}
        onSubmit={(payload) => createMutation.mutate(payload)}
        isPending={createMutation.isPending}
      />

      {selectedId && (
        <RunPlaybookDialog
          open={showRunDialog}
          onOpenChange={setShowRunDialog}
          playbookName={filteredPlaybooks.find((p) => p.id === selectedId)?.name ?? "Playbook"}
          onRun={(input) => runMutation.mutate({ playbookId: selectedId, ...input })}
          isPending={runMutation.isPending}
        />
      )}
    </div>
  );
}
