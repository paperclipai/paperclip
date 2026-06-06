import { useCallback, useState } from "react";
import { useNavigate } from "@/lib/router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Pause,
  Play,
  Plus,
  MoreHorizontal,
  Loader2,
  Copy,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AgentStatusBadge } from "./StatusBadge";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { agentRouteRef } from "../lib/utils";
import { useDialogActions } from "../context/DialogContext";
import { useToastActions } from "../context/ToastContext";
import {
  buildDuplicateAgentPayload,
  duplicateAgentName,
  type DuplicateInstructionsBundle,
} from "../lib/duplicate-agent-payload";
import type {
  Agent,
  AgentInstructionsBundle,
  AgentInstructionsFileSummary,
  HeartbeatRun,
} from "@paperclipai/shared";

export function RunButton({
  onClick,
  disabled,
  label = "Run now",
  size = "sm",
}: {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
  size?: "sm" | "default";
}) {
  return (
    <Button variant="outline" size={size} onClick={onClick} disabled={disabled}>
      <Play className="h-3.5 w-3.5 sm:mr-1" />
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

export function PauseResumeButton({
  isPaused,
  onPause,
  onResume,
  disabled,
  size = "sm",
}: {
  isPaused: boolean;
  onPause: () => void;
  onResume: () => void;
  disabled?: boolean;
  size?: "sm" | "default";
}) {
  if (isPaused) {
    return (
      <Button variant="outline" size={size} onClick={onResume} disabled={disabled}>
        <Play className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">Resume</span>
      </Button>
    );
  }

  return (
    <Button variant="outline" size={size} onClick={onPause} disabled={disabled}>
      <Pause className="h-3.5 w-3.5 sm:mr-1" />
      <span className="hidden sm:inline">Pause</span>
    </Button>
  );
}

function duplicateInstructionFilePath(
  _bundle: AgentInstructionsBundle,
  summary: AgentInstructionsFileSummary,
): string | null {
  if (summary.deprecated || summary.virtual) return null;
  return summary.path;
}

export async function loadDuplicateInstructionsBundle(
  agentId: string,
  companyId?: string,
): Promise<DuplicateInstructionsBundle | null> {
  const bundle = await agentsApi.instructionsBundle(agentId, companyId);
  const files: Record<string, string> = {};

  for (const summary of bundle.files) {
    const path = duplicateInstructionFilePath(bundle, summary);
    if (!path) continue;
    const file = await agentsApi.instructionsFile(agentId, summary.path, companyId);
    files[path] = file.content;
  }

  const entryFile = Object.prototype.hasOwnProperty.call(files, bundle.entryFile)
    ? bundle.entryFile
    : Object.keys(files)[0] ?? "AGENTS.md";
  return Object.keys(files).length > 0 ? { entryFile, files } : null;
}

/**
 * Shared agent action cluster used by both the agent detail header and the
 * agents list rows. Encapsulates the invoke / pause / resume / terminate /
 * duplicate / reset-session mutations so callers do not diverge in behavior.
 */
export function AgentActionButtons({
  agent,
  companyId,
  size = "sm",
  assignLabel = "Assign Task",
  runLabel = "Run now",
  showStatus = true,
  actionsDisabled = false,
  workActionsDisabled = false,
  workActionsDisabledReason,
  navigateToRunOnInvoke = true,
  onActionError,
  children,
  className,
}: {
  agent: Agent;
  companyId?: string | null;
  size?: "sm" | "default";
  assignLabel?: string;
  runLabel?: string;
  showStatus?: boolean;
  actionsDisabled?: boolean;
  workActionsDisabled?: boolean;
  workActionsDisabledReason?: string;
  navigateToRunOnInvoke?: boolean;
  /**
   * Optional inline error reporter. When provided it is used instead of a toast
   * for action failures (preserves the detail page's inline error banner). When
   * omitted, failures surface as toasts (used by the list view).
   */
  onActionError?: (message: string | null) => void;
  /** Extra content rendered just before the overflow menu (e.g. live-run link). */
  children?: React.ReactNode;
  className?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { openNewIssue } = useDialogActions();
  const { pushToast } = useToastActions();
  const [moreOpen, setMoreOpen] = useState(false);

  const resolvedCompanyId = companyId ?? agent.companyId;
  const canonicalAgentRef = agentRouteRef(agent);
  const isPaused = agent.status === "paused";

  const reportError = useCallback(
    (message: string) => {
      if (onActionError) {
        onActionError(message);
      } else {
        pushToast({ title: "Action failed", body: message, tone: "error" });
      }
    },
    [onActionError, pushToast],
  );

  const invalidateAgent = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(canonicalAgentRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(agent.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(agent.id) });
    if (resolvedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(resolvedCompanyId, agent.id) });
    }
  }, [agent.id, canonicalAgentRef, queryClient, resolvedCompanyId]);

  const agentAction = useMutation({
    mutationFn: async (action: "invoke" | "pause" | "resume" | "approve" | "terminate") => {
      switch (action) {
        case "invoke": return agentsApi.invoke(agent.id, resolvedCompanyId ?? undefined);
        case "pause": return agentsApi.pause(agent.id, resolvedCompanyId ?? undefined);
        case "resume": return agentsApi.resume(agent.id, resolvedCompanyId ?? undefined);
        case "approve": return agentsApi.approve(agent.id, resolvedCompanyId ?? undefined);
        case "terminate": return agentsApi.terminate(agent.id, resolvedCompanyId ?? undefined);
      }
    },
    onSuccess: (data, action) => {
      onActionError?.(null);
      invalidateAgent();
      if (action === "invoke" && navigateToRunOnInvoke && data && typeof data === "object" && "id" in data) {
        navigate(`/agents/${canonicalAgentRef}/runs/${(data as HeartbeatRun).id}`);
      }
    },
    onError: (err) => {
      reportError(err instanceof Error ? err.message : "Action failed");
    },
  });

  const duplicateAgent = useMutation({
    mutationFn: async () => {
      if (!resolvedCompanyId) {
        throw new Error("Agent is not ready to duplicate");
      }
      const instructionsBundle = await loadDuplicateInstructionsBundle(agent.id, resolvedCompanyId);
      const payload = buildDuplicateAgentPayload(agent, instructionsBundle);
      try {
        return await agentsApi.create(resolvedCompanyId, payload);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.message.includes("requires board approval")) {
          const hire = await agentsApi.hire(resolvedCompanyId, payload);
          return hire.agent;
        }
        throw error;
      }
    },
    onSuccess: async (createdAgent) => {
      onActionError?.(null);
      if (resolvedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
      pushToast({ title: "Agent duplicated", body: createdAgent.name, tone: "success" });
      navigate(`/agents/${agentRouteRef(createdAgent)}/dashboard`);
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Failed to duplicate agent";
      onActionError?.(message);
      pushToast({ title: "Could not duplicate agent", body: message, tone: "error" });
    },
  });

  const handleDuplicateAgent = useCallback(() => {
    if (duplicateAgent.isPending) return;
    const nextName = duplicateAgentName(agent.name);
    const confirmed = window.confirm(`Duplicate ${agent.name} as ${nextName}?`);
    setMoreOpen(false);
    if (!confirmed) return;
    duplicateAgent.mutate();
  }, [agent.name, duplicateAgent]);

  const resetTaskSession = useMutation({
    mutationFn: () => agentsApi.resetSession(agent.id, null, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      onActionError?.(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(agent.id) });
    },
    onError: (err) => {
      reportError(err instanceof Error ? err.message : "Failed to reset session");
    },
  });

  const isPendingApproval = agent.status === "pending_approval";
  const disabled = actionsDisabled || agentAction.isPending;
  const assignAndRunDisabled = disabled || isPendingApproval || workActionsDisabled;
  const pauseResumeDisabled = disabled || isPendingApproval || (isPaused && workActionsDisabled);

  return (
    <div className={className ?? "flex items-center gap-1 sm:gap-2 shrink-0"}>
      <Button
        variant="outline"
        size={size}
        onClick={() => openNewIssue({ assigneeAgentId: agent.id })}
        disabled={assignAndRunDisabled}
        title={workActionsDisabled ? workActionsDisabledReason : undefined}
      >
        <Plus className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">{assignLabel}</span>
      </Button>
      <RunButton
        onClick={() => agentAction.mutate("invoke")}
        disabled={assignAndRunDisabled}
        label={runLabel}
        size={size}
      />
      <PauseResumeButton
        isPaused={isPaused}
        onPause={() => agentAction.mutate("pause")}
        onResume={() => agentAction.mutate("resume")}
        disabled={pauseResumeDisabled}
        size={size}
      />
      {showStatus && (
        <span className="hidden sm:inline">
          <AgentStatusBadge status={agent.status} />
        </span>
      )}
      {children}
      <Popover open={moreOpen} onOpenChange={setMoreOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`Open actions for ${agent.name}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-44 p-1" align="end">
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
            disabled={duplicateAgent.isPending}
            onClick={handleDuplicateAgent}
          >
            {duplicateAgent.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            Duplicate Agent
          </button>
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
            onClick={() => {
              navigator.clipboard.writeText(agent.id);
              setMoreOpen(false);
            }}
          >
            <Copy className="h-3 w-3" />
            Copy Agent ID
          </button>
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
            onClick={() => {
              resetTaskSession.mutate();
              setMoreOpen(false);
            }}
          >
            <RotateCcw className="h-3 w-3" />
            Reset Sessions
          </button>
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
            onClick={() => {
              agentAction.mutate("terminate");
              setMoreOpen(false);
            }}
          >
            <Trash2 className="h-3 w-3" />
            Terminate
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
