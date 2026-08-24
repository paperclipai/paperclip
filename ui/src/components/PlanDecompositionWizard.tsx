import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AcceptedPlanDecompositionResult,
  Agent,
  IssueDocument,
  IssueThreadInteraction,
  PlanMetadata,
} from "@paperclipai/shared";
import { Check, ChevronRight, ExternalLink, FileText, GitBranch, Loader2, Milestone, User } from "lucide-react";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { parsePlanMetadata } from "../lib/plan-metadata";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { AgentIcon } from "./AgentIconPicker";
import { Link } from "@/lib/router";

// ─── Types ──────────────────────────────────────────────────────────────────

interface DocumentWithPlanMetadata extends IssueDocument {
  planMetadata: PlanMetadata | null;
}

interface ChildIssueConfig {
  localId: string;
  milestoneId: string;
  milestoneTitle: string;
  milestoneDescription: string | null;
  title: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  description: string | null;
}

type WizardStep = "review" | "configure" | "preview" | "result";

interface PlanDecompositionWizardProps {
  issueId: string;
  issueIdentifier: string | null;
  agents: Agent[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function findLatestAcceptedPlanRevision(
  interactions: IssueThreadInteraction[],
): { revisionId: string; revisionNumber: number | null } | null {
  const acceptedPlanConfirmations = interactions
    .filter((interaction) => interaction.kind === "request_confirmation" && interaction.status === "accepted")
    .filter((interaction) => {
      const target = "payload" in interaction ? (interaction as any).payload?.target : null;
      return target?.type === "issue_document" && target?.key === "plan" && target?.revisionId;
    });

  if (acceptedPlanConfirmations.length === 0) return null;

  // Sort by resolvedAt descending, then createdAt descending
  acceptedPlanConfirmations.sort((a, b) => {
    const aResolved = a.resolvedAt ? new Date(a.resolvedAt).getTime() : 0;
    const bResolved = b.resolvedAt ? new Date(b.resolvedAt).getTime() : 0;
    if (bResolved !== aResolved) return bResolved - aResolved;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const latest = acceptedPlanConfirmations[0] as any;
  const target = latest?.payload?.target;
  return {
    revisionId: target.revisionId,
    revisionNumber: target.revisionNumber ?? null,
  };
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function AgentOption({ agent, selected, onSelect }: { agent: Agent; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent",
        selected && "bg-accent font-medium",
      )}
    >
      <AgentIcon icon={agent.icon} className="h-4 w-4 shrink-0" />
      <span className="truncate">{agent.name}</span>
      {selected && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />}
    </button>
  );
}

function AssigneePopover({
  agents,
  value,
  onChange,
}: {
  agents: Agent[];
  value: string | null;
  onChange: (agentId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  const selectedAgent = value ? agents.find((a) => a.id === value) : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "inline-flex h-8 w-full items-center gap-1.5 rounded-md border border-input bg-transparent px-2 text-xs transition-colors hover:bg-accent/50",
          !selectedAgent && "text-muted-foreground",
        )}
      >
        {selectedAgent ? (
          <>
            <AgentIcon icon={selectedAgent.icon} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{selectedAgent.name}</span>
          </>
        ) : (
          <>
            <User className="h-3.5 w-3.5 shrink-0" />
            <span>Unassigned</span>
          </>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-lg">
            <ScrollArea className="max-h-60">
              <button
                type="button"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent",
                  !value && "bg-accent font-medium",
                )}
              >
                <User className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span>Unassigned</span>
                {!value && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />}
              </button>
              {agents.map((agent) => (
                <AgentOption
                  key={agent.id}
                  agent={agent}
                  selected={value === agent.id}
                  onSelect={() => {
                    onChange(agent.id);
                    setOpen(false);
                  }}
                />
              ))}
            </ScrollArea>
          </div>
        </>
      )}
    </div>
  );
}

function stepLabel(step: WizardStep): string {
  switch (step) {
    case "review": return "Select milestones";
    case "configure": return "Configure child issues";
    case "preview": return "Review & confirm";
    case "result": return "Results";
  }
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function PlanDecompositionWizard({
  issueId,
  issueIdentifier,
  agents,
  open,
  onOpenChange,
}: PlanDecompositionWizardProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<WizardStep>("review");
  const [selectedMilestoneIds, setSelectedMilestoneIds] = useState<Set<string>>(new Set());
  const [childConfigs, setChildConfigs] = useState<ChildIssueConfig[]>([]);
  const [result, setResult] = useState<AcceptedPlanDecompositionResult | null>(null);

  // Fetch plan document
  const { data: planDocument, isLoading: planLoading } = useQuery({
    queryKey: queryKeys.issues.document(issueId, "plan"),
    queryFn: () => issuesApi.getDocument(issueId, "plan"),
    enabled: open,
  });

  // Fetch interactions to find accepted plan revision
  const { data: interactions = [] } = useQuery({
    queryKey: queryKeys.issues.interactions(issueId),
    queryFn: () => issuesApi.listInteractions(issueId),
    enabled: open,
  });

  // Parse plan metadata from the document
  const planMetadata = useMemo<PlanMetadata | null>(() => {
    if (!planDocument) return null;
    return parsePlanMetadata((planDocument as DocumentWithPlanMetadata).planMetadata);
  }, [planDocument]);

  const milestones = useMemo(() => planMetadata?.milestones ?? [], [planMetadata]);
  const planStatus = useMemo(() => planMetadata?.status, [planMetadata]);

  // Find accepted plan revision
  const acceptedPlanRevision = useMemo(
    () => findLatestAcceptedPlanRevision(interactions),
    [interactions],
  );

  const acceptedRevisionId = useMemo(
    () => acceptedPlanRevision?.revisionId ?? null,
    [acceptedPlanRevision],
  );

  const latestRevisionId = useMemo(
    () => (planDocument as DocumentWithPlanMetadata)?.latestRevisionId ?? null,
    [planDocument],
  );

  // Effective revision: prefer the accepted one, fall back to latest
  const effectiveRevisionId = acceptedRevisionId ?? latestRevisionId;

  // Reset state when sheet opens
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        // Reset after a brief delay so the sheet animation plays
        setTimeout(() => {
          setStep("review");
          setSelectedMilestoneIds(new Set());
          setChildConfigs([]);
          setResult(null);
        }, 300);
      }
      onOpenChange(newOpen);
    },
    [onOpenChange],
  );

  // ─── Step transitions ─────────────────────────────────────────────────────

  const handleReviewNext = useCallback(() => {
    const selectedMilestones = milestones.filter((m) => selectedMilestoneIds.has(m.id));
    if (selectedMilestones.length === 0) return;

    setChildConfigs(
      selectedMilestones.map((ms, index) => ({
        localId: `config-${ms.id}-${index}`,
        milestoneId: ms.id,
        milestoneTitle: ms.title,
        milestoneDescription: ms.description ?? null,
        title: ms.title,
        assigneeAgentId: null,
        assigneeUserId: null,
        description: ms.description ?? null,
      })),
    );
    setStep("configure");
  }, [milestones, selectedMilestoneIds]);

  const handleConfigureNext = useCallback(() => {
    setStep("preview");
  }, []);

  // ─── Submission ───────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: (data: { acceptedPlanRevisionId: string; children: Record<string, unknown>[] }) =>
      issuesApi.createAcceptedPlanDecomposition(issueId, data),
    onSuccess: (response: AcceptedPlanDecompositionResult) => {
      // Refetch the full list so the decomposition history section shows the new record.
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.acceptedPlanDecompositions(issueId) });
      // The response carries decomposition + childIssueIds + newlyCreatedChildIssueIds.
      setResult(response);
      setStep("result");
    },
  });

  const handleSubmit = useCallback(() => {
    if (!effectiveRevisionId) return;

    const children = childConfigs.map((config) => ({
      title: config.title,
      description: config.description,
      status: "todo" as const,
      workMode: "standard" as const,
      priority: "medium" as const,
      assigneeAgentId: config.assigneeAgentId,
      assigneeUserId: config.assigneeUserId,
    }));

    createMutation.mutate({
      acceptedPlanRevisionId: effectiveRevisionId,
      children,
    });
  }, [childConfigs, effectiveRevisionId, createMutation]);

  // ─── Derived data ─────────────────────────────────────────────────────────

  const currentStepIndex = useMemo(() => {
    const steps: WizardStep[] = ["review", "configure", "preview", "result"];
    return steps.indexOf(step);
  }, [step]);

  // ─── Render: content ──────────────────────────────────────────────────────

  function renderStepIndicator() {
    const steps = [
      { id: "review" as WizardStep, label: "Select" },
      { id: "configure" as WizardStep, label: "Configure" },
      { id: "preview" as WizardStep, label: "Preview" },
    ];
    const isDone = step === "result";

    return (
      <div className="flex items-center gap-0.5">
        {steps.map((s, i) => {
          const isActive = currentStepIndex === i;
          const isPast = currentStepIndex > i || isDone;
          return (
            <div key={s.id} className="flex items-center gap-0.5">
              {i > 0 && (
                <div className={cn("h-px w-3", isPast ? "bg-primary" : "bg-border")} />
              )}
              <span
                className={cn(
                  "text-[11px] font-medium",
                  isActive && "text-foreground",
                  isPast && !isActive && "text-primary",
                  !isActive && !isPast && "text-muted-foreground/60",
                )}
              >
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  function renderReviewStep() {
    if (milestones.length === 0) {
      return (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <FileText className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            This plan has no milestones defined.
          </p>
          <p className="max-w-sm text-xs text-muted-foreground/70">
            Milestones are defined in the plan document metadata. Add milestones to the plan before decomposing.
          </p>
          {issueIdentifier && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/issues/${issueIdentifier}#document-plan`}>
                <FileText className="mr-1.5 h-3.5 w-3.5" />
                Open plan document
              </Link>
            </Button>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="rounded-md border border-border bg-card/50 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <Milestone className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{milestones.length} milestone{milestones.length !== 1 ? "s" : ""}</span>
            </div>
            <span className="text-xs text-muted-foreground">
              {selectedMilestoneIds.size} of {milestones.length} selected
            </span>
          </div>
          {planStatus && (
            <div className="mt-1 text-xs text-muted-foreground">
              Plan status: <span className="font-medium capitalize">{planStatus}</span>
              {planStatus !== "approved" && !acceptedRevisionId && (
                <span className="ml-1.5 text-amber-500">(not yet approved)</span>
              )}
            </div>
          )}
          {!acceptedRevisionId && latestRevisionId ? (
            <p className="mt-2 rounded-sm border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
              No accepted plan confirmation found for the latest revision. The server may reject the decomposition.
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          {milestones.map((ms) => {
            const isSelected = selectedMilestoneIds.has(ms.id);
            return (
              <button
                key={ms.id}
                type="button"
                onClick={() => {
                  const next = new Set(selectedMilestoneIds);
                  if (isSelected) next.delete(ms.id);
                  else next.add(ms.id);
                  setSelectedMilestoneIds(next);
                }}
                className={cn(
                  "flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors",
                  isSelected
                    ? "border-primary/50 bg-primary/5"
                    : "border-border bg-card/30 hover:bg-accent/30",
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input",
                  )}
                >
                  {isSelected ? <Check className="h-3 w-3" /> : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{ms.title}</div>
                  {ms.description && (
                    <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {ms.description}
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span>Order: {ms.order + 1}</span>
                    {ms.acceptanceCriteria?.length > 0 && (
                      <span>{ms.acceptanceCriteria.length} acceptance criter{ms.acceptanceCriteria.length === 1 ? "ion" : "ia"}</span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={selectedMilestoneIds.size === 0}
            onClick={handleReviewNext}
          >
            Continue
            <ChevronRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  function updateChildConfig(localId: string, updates: Partial<ChildIssueConfig>) {
    setChildConfigs((prev) =>
      prev.map((c) => (c.localId === localId ? { ...c, ...updates } : c)),
    );
  }

  function renderConfigureStep() {
    if (childConfigs.length === 0) return null;

    return (
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Configure each child issue. Titles are auto-suggested from milestone names. Select an assignee for each.
        </p>

        <div className="space-y-3">
          {childConfigs.map((config, index) => (
            <div
              key={config.localId}
              className="rounded-md border border-border bg-card/40 p-3"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-medium text-primary">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <Label htmlFor={`title-${config.localId}`} className="text-xs text-muted-foreground">
                    Title
                  </Label>
                  <Input
                    id={`title-${config.localId}`}
                    value={config.title}
                    onChange={(e) => updateChildConfig(config.localId, { title: e.target.value })}
                    className="mt-0.5 h-8 text-sm"
                  />
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Assignee</Label>
                  <AssigneePopover
                    agents={agents ?? []}
                    value={config.assigneeAgentId}
                    onChange={(agentId) =>
                      updateChildConfig(config.localId, { assigneeAgentId: agentId })
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Milestone</Label>
                  <div className="mt-0.5 truncate rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
                    {config.milestoneTitle}
                  </div>
                </div>
              </div>

              {config.milestoneDescription && (
                <div className="mt-2">
                  <Label className="text-xs text-muted-foreground">Description</Label>
                  <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground/80">
                    {config.milestoneDescription}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => setStep("review")}>
            Back
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={childConfigs.some((c) => !c.title.trim())}
              onClick={handleConfigureNext}
            >
              Continue
              <ChevronRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  function renderPreviewStep() {
    const newIssues = childConfigs.map((config, index) => ({
      ...config,
      index,
    }));

    return (
      <div className="space-y-4">
        <div className="rounded-md border border-border bg-card/50 p-3">
          <div className="text-sm font-medium">Summary</div>
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            <div className="flex items-center justify-between">
              <span>Child issues to create</span>
              <span className="font-medium text-foreground">{newIssues.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Plan revision</span>
              <span className="font-medium text-foreground">
                {acceptedPlanRevision?.revisionNumber != null
                  ? `v${acceptedPlanRevision.revisionNumber}`
                  : effectiveRevisionId?.slice(0, 8) ?? "—"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Assignee</span>
              <span className="font-medium text-foreground">
                {newIssues.filter((c) => c.assigneeAgentId).length} assigned,{" "}
                {newIssues.filter((c) => !c.assigneeAgentId).length} unassigned
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          {newIssues.map((config) => {
            const assignee = config.assigneeAgentId
              ? agents?.find((a) => a.id === config.assigneeAgentId)
              : null;
            return (
              <div
                key={config.localId}
                className="flex items-start gap-3 rounded-md border border-border bg-card/30 p-3"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-medium text-primary">
                  {config.index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{config.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="truncate">From: {config.milestoneTitle}</span>
                    {assignee && (
                      <>
                        <span className="text-muted-foreground/50">·</span>
                        <span className="inline-flex items-center gap-1">
                          <AgentIcon icon={assignee.icon} className="h-3 w-3" />
                          {assignee.name}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => setStep("configure")}>
            Back
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={createMutation.isPending}
              onClick={handleSubmit}
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <GitBranch className="mr-1 h-3.5 w-3.5" />
                  Create {newIssues.length} {newIssues.length === 1 ? "issue" : "issues"}
                </>
              )}
            </Button>
          </div>
        </div>

        {createMutation.isError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-700 dark:text-red-300">
            {createMutation.error instanceof Error
              ? createMutation.error.message
              : "Failed to create decomposition. The plan revision may not be accepted."}
          </div>
        )}
      </div>
    );
  }

  function renderResultStep() {
    if (!result) return null;

    const { decomposition, childIssueIds, newlyCreatedChildIssueIds } = result;
    const newlyCreatedIds = newlyCreatedChildIssueIds ?? [];

    return (
      <div className="space-y-5">
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4 text-center">
          <div className="inline-flex items-center justify-center rounded-full bg-emerald-500/15 p-2">
            <Check className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h3 className="mt-3 text-sm font-semibold">Decomposition created</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {newlyCreatedIds.length} {newlyCreatedIds.length === 1 ? "child issue was" : "child issues were"} created from plan milestones
          </p>
        </div>

        {decomposition && (
          <div className="rounded-md border border-border bg-card/40 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Decomposition</span>
              <span className="text-[11px] text-muted-foreground">
                {decomposition.requestedChildCount} requested, {childIssueIds.length} created
              </span>
            </div>
            {decomposition.ownerAgentId && agents && (
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <User className="h-3 w-3" />
                <span>
                  {agents.find((a) => a.id === decomposition.ownerAgentId)?.name ??
                    decomposition.ownerAgentId.slice(0, 8)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Show created child issue IDs */}
        <div className="rounded-md border border-border bg-card/30 p-4">
          <h4 className="text-xs font-medium text-muted-foreground">Child issues</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            The decomposition is in progress. Created child issues will appear in the decomposition history below. You can also{" "}
            <Link
              to={`/issues/${issueIdentifier ?? issueId}`}
              className="underline underline-offset-2 hover:text-foreground"
            >
              view the parent issue
            </Link>
            {" "}to see all sub-tasks.
          </p>
          {newlyCreatedIds.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {newlyCreatedIds.map((cid: string) => (
                <Link
                  key={cid}
                  to={`/issues/${cid}`}
                  className="inline-flex items-center gap-1 rounded-sm border border-border bg-background px-2 py-1 text-xs transition-colors hover:bg-accent/50"
                >
                  <GitBranch className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium">{cid.slice(0, 8)}</span>
                  <ExternalLink className="h-3 w-3 text-muted-foreground" />
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            size="sm"
            onClick={() => {
              handleOpenChange(false);
            }}
          >
            Done
          </Button>
        </div>
      </div>
    );
  }

  function renderBody() {
    if (planLoading) {
      return (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (!planDocument || milestones.length === 0) {
      return (
        <div className="flex flex-col items-center gap-4 py-12 text-center">
          <FileText className="h-12 w-12 text-muted-foreground/30" />
          <div>
            <h3 className="text-sm font-medium">No plan document found</h3>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              This issue doesn&apos;t have a plan document with milestones. Create a plan first.
            </p>
          </div>
          {issueIdentifier && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/issues/${issueIdentifier}#document-plan`}>
                <FileText className="mr-1.5 h-3.5 w-3.5" />
                Open documents
              </Link>
            </Button>
          )}
        </div>
      );
    }

    if (step === "review") return renderReviewStep();
    if (step === "configure") return renderConfigureStep();
    if (step === "preview") return renderPreviewStep();
    if (step === "result") return renderResultStep();

    return null;
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader className="shrink-0">
          <div className="flex items-center justify-between">
            <SheetTitle>Decompose plan</SheetTitle>
            {step !== "result" && renderStepIndicator()}
          </div>
          <SheetDescription>
            {step === "result"
              ? "Child issues created from plan milestones"
              : `Step ${currentStepIndex + 1}: ${stepLabel(step)}`}
          </SheetDescription>
        </SheetHeader>

        <Separator className="my-3" />

        <ScrollArea className="flex-1">
          <div className="px-1 pb-6">
            {renderBody()}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}