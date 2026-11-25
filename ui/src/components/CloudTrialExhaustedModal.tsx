import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import type {
  AiConnectionBinding,
  CloudTrialInferenceStatus,
  MigrateCloudTrialAgentsResult,
} from "@paperclipai/shared";
import { cloudInferenceApi } from "@/api/cloud-inference";
import { describeError } from "@/api/errors";
import { AiProviderSetup } from "@/components/ai-connections/AiProviderSetup";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export interface CloudTrialExhaustedModalProps {
  open: boolean;
  companyId: string;
  status: CloudTrialInferenceStatus;
  /** When true, blocks closing until the user connects a model provider and migrates agents. */
  required?: boolean;
  /** Initial visual phase override (primarily for Storybook & previewing states). */
  initialPhase?: "connect" | "migrating" | "done" | "error";
  initialResult?: MigrateCloudTrialAgentsResult | null;
  initialError?: string | null;
  onOpenChange?: (open: boolean) => void;
  onMigrationStart?: () => void;
  onMigrated?: (result: MigrateCloudTrialAgentsResult) => void;
}

export function CloudTrialExhaustedModal({
  open,
  companyId,
  status,
  required = true,
  initialPhase = "connect",
  initialResult = null,
  initialError = null,
  onOpenChange,
  onMigrationStart,
  onMigrated,
}: CloudTrialExhaustedModalProps) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<"connect" | "migrating" | "done" | "error">(initialPhase);
  const [migrationResult, setMigrationResult] = useState<MigrateCloudTrialAgentsResult | null>(initialResult);
  const [errorMessage, setErrorMessage] = useState<string | null>(initialError);
  const [lastBinding, setLastBinding] = useState<Exclude<AiConnectionBinding, { mode: "responsible_user" }> | null>(
    null,
  );
  const modalShownTrackedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      modalShownTrackedRef.current = false;
      return;
    }
    if (phase !== "connect" || modalShownTrackedRef.current) return;
    modalShownTrackedRef.current = true;
    void cloudInferenceApi
      .trackTelemetry(companyId, {
        event: "modal_shown",
        trialAgentCount: status.trialAgents.length,
      })
      .catch(() => {
        // Best-effort analytics must never interrupt connecting a provider.
      });
  }, [open, phase, companyId, status.trialAgents.length]);

  const migrateMutation = useMutation({
    mutationFn: (binding: Exclude<AiConnectionBinding, { mode: "responsible_user" }>) =>
      cloudInferenceApi.migrate(companyId, {
        connectionId: binding.connectionId,
        grantId: binding.grantId,
        provider: binding.provider,
        method: binding.method,
        ownership: binding.mode === "shared" ? "shared" : "personal",
        resumeBlockedWork: true,
      }),
    onMutate: (binding) => {
      onMigrationStart?.();
      setLastBinding(binding);
      setErrorMessage(null);
      setPhase("migrating");
    },
    onSuccess: (result) => {
      setMigrationResult(result);
      setPhase("done");
      onMigrated?.(result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.cloudInference.status(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      void queryClient.invalidateQueries({ queryKey: ["ai-connections", companyId] });
    },
    onError: (err) => {
      setErrorMessage(describeError(err).body);
      setPhase("error");
    },
  });

  const canMigrate = status.canMigrate !== false;
  const canClose = !required || !canMigrate || phase === "done";
  const agentCount = status.trialAgents.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !canClose) return;
        onOpenChange?.(nextOpen);
      }}
    >
      <DialogContent
        showCloseButton={canClose}
        onEscapeKeyDown={(event) => {
          if (!canClose) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (!canClose) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (!canClose) event.preventDefault();
        }}
        className="max-h-(--sz-85vh) sm:max-w-2xl overflow-y-auto p-0 gap-0"
      >
        {/* Header */}
        <div className="border-b border-border bg-card px-6 py-4">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border",
                phase === "done"
                  ? "border-(--status-task-icon-done)/30 bg-(--diff-add-bg) text-(--diff-add-fg)"
                  : "border-border bg-muted/50 text-foreground",
              )}
            >
              {phase === "done" ? (
                <CheckCircle2 className="size-4" />
              ) : (
                <Sparkles className="size-4" />
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <DialogHeader className="text-left">
                <DialogTitle className="text-base font-semibold">
                  {phase === "done"
                    ? "Model provider connected"
                    : "Connect a model provider to continue"}
                </DialogTitle>
              </DialogHeader>
              <DialogDescription className="text-sm text-muted-foreground">
                {phase === "done"
                  ? "Your agents have been updated to use your connected model provider."
                  : !canMigrate
                    ? "A company administrator needs to connect a model provider before these agents can continue running."
                    : `You need to connect a model provider to continue. We’ll automatically update ${
                        agentCount === 1
                          ? status.trialAgents[0]?.name || "your agent"
                          : agentCount > 1
                            ? `all ${agentCount} agents`
                            : "your agents"
                      } and pick up where you left off.`}
              </DialogDescription>
              {phase !== "done" && status.trialAgents.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-2">
                  <span className="text-xs text-muted-foreground mr-1">
                    {canMigrate ? "Will update:" : "Waiting on provider:"}
                  </span>
                  {status.trialAgents.map((agent) => (
                    <span
                      key={agent.id}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-foreground"
                    >
                      <Bot className="size-3 text-muted-foreground" />
                      <span className="font-medium">{agent.name}</span>
                      {agent.title ? (
                        <span className="text-muted-foreground">· {agent.title}</span>
                      ) : null}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4">
          {phase === "connect" && !canMigrate && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                You have read-only access to agent model settings in this company. Ask an administrator to connect a model provider so paused agent work can resume.
              </p>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => onOpenChange?.(false)}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}

          {phase === "connect" && canMigrate && (
            <AiProviderSetup
              companyId={companyId}
              hideCancel={!canClose}
              hideProviderHeading
              submitLabel="Connect & update agents"
              onCancel={() => {
                if (canClose) onOpenChange?.(false);
              }}
              onComplete={(binding) => {
                migrateMutation.mutate(binding);
              }}
            />
          )}

          {phase === "migrating" && (
            <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
              <Loader2 className="size-6 animate-spin text-primary" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  Updating your agents to your model provider…
                </p>
                <p className="text-xs text-muted-foreground">
                  Switching harnesses and resuming paused work.
                </p>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="space-y-4 py-4">
              <div
                role="alert"
                className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
              >
                <p className="font-medium">Could not finish updating your agents</p>
                <p className="mt-1 text-xs opacity-90">
                  {errorMessage ?? "An unexpected error occurred while updating your agents."}
                </p>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setErrorMessage(null);
                    setPhase("connect");
                  }}
                >
                  Choose another provider
                </Button>
                {lastBinding && (
                  <Button onClick={() => migrateMutation.mutate(lastBinding)}>
                    <RotateCcw className="size-3.5 mr-1.5" />
                    Retry update
                  </Button>
                )}
              </div>
            </div>
          )}

          {phase === "done" && (
            <div className="space-y-5">
              {migrationResult && migrationResult.agents.length > 0 && (
                <div className="rounded-lg border border-border bg-muted/20 divide-y divide-border">
                  {migrationResult.agents.map((agent) => (
                    <div
                      key={agent.agentId}
                      className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Bot className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium text-foreground">{agent.name}</span>
                      </div>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {agent.runnerProvider ? `${agent.runnerProvider} · ` : ""}
                        {agent.model}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {migrationResult && migrationResult.resumedRunIds.length > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-(--status-task-icon-done)/30 bg-(--diff-add-bg) px-3.5 py-2.5 text-xs text-(--diff-add-fg)">
                  <Sparkles className="size-3.5 shrink-0" />
                  <span>Your paused work has been automatically resumed.</span>
                </div>
              )}

              <div className="flex justify-end">
                <Button onClick={() => onOpenChange?.(false)}>
                  Continue to workspace
                  <ArrowRight className="size-3.5 ml-1.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
