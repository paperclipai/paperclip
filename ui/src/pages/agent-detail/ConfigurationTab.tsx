import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi, type AgentPermissionUpdate } from "../../api/agents";
import { queryKeys } from "../../lib/queryKeys";
import { formatDate } from "../../lib/utils";
import { cn } from "../../lib/utils";
import { AgentConfigForm } from "../../components/AgentConfigForm";
import { Button } from "@/components/ui/button";
import { ChevronRight, ChevronDown } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KeysTab } from "./KeysTab";
import type { AgentDetail as AgentDetailRecord } from "@paperclipai/shared";

export function AgentConfigurePage({
  agent,
  agentId,
  companyId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
  updatePermissions,
}: {
  agent: AgentDetailRecord;
  agentId: string;
  companyId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
  updatePermissions: { mutate: (permissions: AgentPermissionUpdate) => void; isPending: boolean };
}) {
  const queryClient = useQueryClient();
  const [revisionsOpen, setRevisionsOpen] = useState(false);

  const { data: configRevisions } = useQuery({
    queryKey: queryKeys.agents.configRevisions(agent.id),
    queryFn: () => agentsApi.listConfigRevisions(agent.id, companyId),
  });

  const rollbackConfig = useMutation({
    mutationFn: (revisionId: string) => agentsApi.rollbackConfigRevision(agent.id, revisionId, companyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
    },
  });

  return (
    <div className="max-w-3xl space-y-6">
      <ConfigurationForm
        agent={agent}
        onDirtyChange={onDirtyChange}
        onSaveActionChange={onSaveActionChange}
        onCancelActionChange={onCancelActionChange}
        onSavingChange={onSavingChange}
        updatePermissions={updatePermissions}
        companyId={companyId}
        hidePromptTemplate
        hideInstructionsFile
      />
      <div>
        <h3 className="text-sm font-medium mb-3">API Keys</h3>
        <KeysTab agentId={agentId} companyId={companyId} />
      </div>

      {/* Configuration Revisions — collapsible at the bottom */}
      <div>
        <button
          className="flex items-center gap-2 text-sm font-medium hover:text-foreground transition-colors"
          onClick={() => setRevisionsOpen((v) => !v)}
        >
          {revisionsOpen
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          }
          Configuration Revisions
          <span className="text-xs font-normal text-muted-foreground">{configRevisions?.length ?? 0}</span>
        </button>
        {revisionsOpen && (
          <div className="mt-3">
            {(configRevisions ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No configuration revisions yet.</p>
            ) : (
              <div className="space-y-2">
                {(configRevisions ?? []).slice(0, 10).map((revision) => (
                  <div key={revision.id} className="border border-border/70 rounded-md p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs text-muted-foreground">
                        <span className="font-mono">{revision.id.slice(0, 8)}</span>
                        <span className="mx-1">·</span>
                        <span>{formatDate(revision.createdAt)}</span>
                        <span className="mx-1">·</span>
                        <span>{revision.source}</span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-xs"
                        onClick={() => rollbackConfig.mutate(revision.id)}
                        disabled={rollbackConfig.isPending}
                      >
                        Restore
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Changed:{" "}
                      {revision.changedKeys.length > 0 ? revision.changedKeys.join(", ") : "no tracked changes"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ConfigurationForm({
  agent,
  companyId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
  updatePermissions,
  hidePromptTemplate,
  hideInstructionsFile,
}: {
  agent: AgentDetailRecord;
  companyId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
  updatePermissions: { mutate: (permissions: AgentPermissionUpdate) => void; isPending: boolean };
  hidePromptTemplate?: boolean;
  hideInstructionsFile?: boolean;
}) {
  const queryClient = useQueryClient();
  const [awaitingRefreshAfterSave, setAwaitingRefreshAfterSave] = useState(false);
  const lastAgentRef = useRef(agent);

  const { data: adapterModels } = useQuery({
    queryKey:
      companyId
        ? queryKeys.agents.adapterModels(companyId, agent.adapterType)
        : ["agents", "none", "adapter-models", agent.adapterType],
    queryFn: () => agentsApi.adapterModels(companyId!, agent.adapterType),
    enabled: Boolean(companyId),
  });

  const updateAgent = useMutation({
    mutationFn: (data: Record<string, unknown>) => agentsApi.update(agent.id, data, companyId),
    onMutate: () => {
      setAwaitingRefreshAfterSave(true);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
    },
    onError: () => {
      setAwaitingRefreshAfterSave(false);
    },
  });

  useEffect(() => {
    if (awaitingRefreshAfterSave && agent !== lastAgentRef.current) {
      setAwaitingRefreshAfterSave(false);
    }
    lastAgentRef.current = agent;
  }, [agent, awaitingRefreshAfterSave]);
  const isConfigSaving = updateAgent.isPending || awaitingRefreshAfterSave;

  useEffect(() => {
    onSavingChange(isConfigSaving);
  }, [onSavingChange, isConfigSaving]);

  const canCreateAgents = Boolean(agent.permissions?.canCreateAgents);
  const canAssignTasks = Boolean(agent.access?.canAssignTasks);
  const taskAssignSource = agent.access?.taskAssignSource ?? "none";
  const taskAssignLocked = agent.role === "ceo" || canCreateAgents;
  const taskAssignHint =
    taskAssignSource === "ceo_role"
      ? "Enabled automatically for CEO agents."
      : taskAssignSource === "agent_creator"
        ? "Enabled automatically while this agent can create new agents."
        : taskAssignSource === "explicit_grant"
          ? "Enabled via explicit company permission grant."
          : "Disabled unless explicitly granted.";

  return (
    <div className="space-y-6">
      <AgentConfigForm
        mode="edit"
        agent={agent}
        onSave={(patch) => updateAgent.mutate(patch)}
        isSaving={isConfigSaving}
        adapterModels={adapterModels}
        onDirtyChange={onDirtyChange}
        onSaveActionChange={onSaveActionChange}
        onCancelActionChange={onCancelActionChange}
        hideInlineSave
        hidePromptTemplate={hidePromptTemplate}
        hideInstructionsFile={hideInstructionsFile}
        sectionLayout="cards"
      />

      <div>
        <h3 className="text-sm font-medium mb-3">Permissions</h3>
        <div className="border border-border rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between gap-4 text-sm">
            <div className="space-y-1">
              <div>Can create new agents</div>
              <p className="text-xs text-muted-foreground">
                Lets this agent create or hire agents and implicitly assign tasks.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={canCreateAgents}
              className={cn(
                "relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 disabled:cursor-not-allowed disabled:opacity-50",
                canCreateAgents ? "bg-green-600" : "bg-muted",
              )}
              onClick={() =>
                updatePermissions.mutate({
                  canCreateAgents: !canCreateAgents,
                  canAssignTasks: !canCreateAgents ? true : canAssignTasks,
                })
              }
              disabled={updatePermissions.isPending}
            >
              <span
                className={cn(
                  "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                  canCreateAgents ? "translate-x-4.5" : "translate-x-0.5",
                )}
              />
            </button>
          </div>
          <div className="flex items-center justify-between gap-4 text-sm">
            <div className="space-y-1">
              <div>Can assign tasks</div>
              <p className="text-xs text-muted-foreground">
                {taskAssignHint}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={canAssignTasks}
              className={cn(
                "relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 disabled:cursor-not-allowed disabled:opacity-50",
                canAssignTasks ? "bg-green-600" : "bg-muted",
              )}
              onClick={() =>
                updatePermissions.mutate({
                  canCreateAgents,
                  canAssignTasks: !canAssignTasks,
                })
              }
              disabled={updatePermissions.isPending || taskAssignLocked}
            >
              <span
                className={cn(
                  "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                  canAssignTasks ? "translate-x-4.5" : "translate-x-0.5",
                )}
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
