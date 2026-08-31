import { useEffect, useRef } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { Agent, ToolCatalogEntry, ToolConnectionCapabilities } from "@paperclipai/shared";
import { useSearchParams } from "@/lib/router";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { AgentMultiSelect } from "@/components/AgentMultiSelect";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { cn } from "@/lib/utils";
import { type InstallState } from "@/lib/tool-installs";
import { QuarantinedActionsReview } from "./SetupPanel";
import {
  formatActionPermissionSummary,
  summarizeActionPermissions,
} from "./action-permission-summary";
import type { AccessDraft, AppDetailSectionProps } from "./types";

type ActionPermission = "off" | "allowed" | "ask";

/**
 * Permissions tab.
 *
 * Agent access and installs answer two different questions. Access decides who
 * may use the app when work needs it. Installs decide which agents load the app
 * on every run. Keeping the sections adjacent makes that distinction explicit
 * while preserving the server invariant that installed agents are permitted.
 */
export function PermissionsPanel({
  appName,
  agents,
  access,
  install,
  readOnly,
  canChange,
  quarantined,
  enabledIds,
  askFirstIds,
  pending,
  installPending,
  onSaveAccess,
  onSaveInstall,
  onSetActionPermission,
  onReviewQuarantined,
  onRefreshActions,
  refreshPending,
  capabilities,
}: Pick<
  AppDetailSectionProps,
  | "appName"
  | "agents"
  | "access"
  | "readOnly"
  | "canChange"
  | "quarantined"
  | "enabledIds"
  | "askFirstIds"
  | "pending"
> & {
  install: InstallState;
  installPending: boolean;
  onSaveAccess: (next: AccessDraft) => void;
  onSaveInstall: (next: InstallState) => void;
  onSetActionPermission: (id: string, next: ActionPermission) => void;
  onReviewQuarantined: (enabledIds: string[]) => void;
  onRefreshActions: () => void;
  refreshPending: boolean;
  /** Server verdict on what this caller may change here (PAP-17835). */
  capabilities: ToolConnectionCapabilities | undefined;
}) {
  // Deep-link from the Test tab's "off" panel: ?focus={catalogEntryId} scrolls
  // to and highlights that action row.
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get("focus");
  return (
    <div className="space-y-10">
      <AlwaysInstalledSection
        appName={appName}
        agents={agents}
        install={install}
        capabilities={capabilities}
        disabled={installPending}
        onSave={onSaveInstall}
      />
      <AgentAccessSection
        appName={appName}
        agents={agents}
        access={access}
        install={install}
        capabilities={capabilities}
        disabled={pending}
        onSave={onSaveAccess}
      />
      <ActionsSection
        readOnly={readOnly}
        canChange={canChange}
        quarantined={quarantined}
        enabledIds={enabledIds}
        askFirstIds={askFirstIds}
        disabled={pending}
        refreshPending={refreshPending}
        focusId={focusId}
        canConfigure={capabilities?.canConfigure ?? false}
        onSetPermission={onSetActionPermission}
        onReviewQuarantined={onReviewQuarantined}
        onRefreshActions={onRefreshActions}
      />
    </div>
  );
}

function AgentAccessSection({
  appName,
  agents,
  access,
  install,
  capabilities,
  disabled,
  onSave,
}: {
  appName: string;
  agents: Agent[];
  access: AccessDraft;
  install: InstallState;
  capabilities: ToolConnectionCapabilities | undefined;
  disabled: boolean;
  onSave: (next: AccessDraft) => void;
}) {
  const liveAgents = agents.filter((a) => a.status !== "terminated");
  const canManage = capabilities?.canConfigure ?? false;
  const editableAgentIds = capabilities?.editableAgentIds;
  const selectableAgents = editableAgentIds
    ? liveAgents.filter((agent) => editableAgentIds.includes(agent.id))
    : liveAgents;
  const selectedAgents = liveAgents.filter((agent) => access.agentIds.has(agent.id));
  const requiredAgentIds = install.agentIds;
  const summary = access.mode === "all"
    ? "Any agent"
    : access.agentIds.size === 0
      ? "No agents"
      : `${access.agentIds.size} ${access.agentIds.size === 1 ? "agent" : "agents"}`;

  return (
    <section className="border-t border-border pt-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Agent access</h2>
          <p className="mt-1 text-sm text-muted-foreground">{summary}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Agents that may use {appName} when work needs it.
          </p>
        </div>
        {disabled && <span className="text-xs text-muted-foreground">Saving…</span>}
      </div>

      {canManage ? (
        <div className="space-y-3 pt-4">
          <RadioCardGroup
            ariaLabel="Which agents can use this connection"
            value={access.mode}
            disabled={disabled}
            className="sm:grid-cols-2"
            onValueChange={(next) => {
              if (next === "all") onSave({ mode: "all", agentIds: new Set() });
              else onSave({
                mode: "specific",
                agentIds: new Set([...access.agentIds, ...requiredAgentIds]),
              });
            }}
            options={[
              {
                value: "specific",
                title: "Agents I pick",
                description: install.onAll
                  ? "Unavailable while installed for every agent."
                  : "Only selected agents.",
                disabled: install.onAll,
              },
              {
                value: "all",
                title: "Any agent",
                description: "Available across your company.",
              },
            ]}
          />

          {access.mode === "specific" ? (
            <AgentMultiSelect
              agents={selectableAgents}
              selectedAgentIds={access.agentIds}
              disabled={disabled}
              triggerLabel={
                access.agentIds.size === 0
                  ? "Choose agents"
                  : `${access.agentIds.size} ${access.agentIds.size === 1 ? "agent" : "agents"} selected`
              }
              emptyMessage="You cannot edit any agents yet."
              isAgentDisabled={(agent) => requiredAgentIds.has(agent.id)}
              getDescription={(agent) => requiredAgentIds.has(agent.id) ? "Always installed" : agent.title}
              headerContent={requiredAgentIds.size > 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Always-installed agents keep access.
                </p>
              ) : null}
              onChange={(agentIds) => onSave({
                mode: "specific",
                agentIds: new Set([...agentIds, ...requiredAgentIds]),
              })}
            />
          ) : null}
        </div>
      ) : (
        // Read-only: the state is still fully legible, just not editable.
        <div className="pt-3">
          {access.mode === "all" ? (
            <p className="text-sm text-muted-foreground">Every agent can use this connection.</p>
          ) : selectedAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents can use this connection.</p>
          ) : (
            <div className="space-y-0.5">
              {selectedAgents.map((agent) => (
                <div key={agent.id} className="flex items-center gap-2 px-1.5 py-1 text-sm">
                  <AgentIcon icon={agent.icon ?? null} className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{agent.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function AlwaysInstalledSection({
  appName,
  agents,
  install,
  capabilities,
  disabled,
  onSave,
}: {
  appName: string;
  agents: Agent[];
  install: InstallState;
  capabilities: ToolConnectionCapabilities | undefined;
  disabled: boolean;
  onSave: (next: InstallState) => void;
}) {
  const liveAgents = agents.filter((agent) => agent.status !== "terminated");
  const canManage = capabilities?.canManageAgentInstalls ?? false;
  const canSetCompanyWide = capabilities?.canSetCompanyInstall ?? false;
  const editableAgentIds = capabilities?.editableAgentIds;
  const selectableAgents = editableAgentIds
    ? liveAgents.filter((agent) => editableAgentIds.includes(agent.id))
    : liveAgents;
  const selectedAgents = liveAgents.filter((agent) => install.agentIds.has(agent.id));
  const mode: "all" | "specific" = install.onAll ? "all" : "specific";
  const summary = install.onAll
    ? "Every agent"
    : install.agentIds.size === 0
      ? "No agents"
      : `${install.agentIds.size} ${install.agentIds.size === 1 ? "agent" : "agents"}`;

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Always installed</h2>
          <p className="mt-1 text-sm text-muted-foreground">{summary}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Loads {appName} on every run. Agent access only makes it available when needed.
          </p>
        </div>
        {disabled && <span className="text-xs text-muted-foreground">Saving…</span>}
      </div>

      {canManage ? (
        <div className="space-y-3 pt-4">
          <RadioCardGroup
            ariaLabel="Which agents always load this connection"
            value={mode}
            disabled={disabled}
            className="sm:grid-cols-2"
            onValueChange={(next) => {
              if (next === "all") onSave({ onAll: true, agentIds: new Set() });
              else onSave({ onAll: false, agentIds: new Set(install.agentIds) });
            }}
            options={[
              {
                value: "specific",
                title: "Agents I pick",
                description: "Always loaded for selected agents.",
              },
              {
                value: "all",
                title: "Every agent",
                description: canSetCompanyWide
                  ? "Always loaded for current and future agents."
                  : "Only a connection manager can choose this.",
              },
            ].filter((option) => option.value !== "all" || canSetCompanyWide || install.onAll)}
          />

          {mode === "specific" ? (
            <AgentMultiSelect
              agents={selectableAgents}
              selectedAgentIds={install.agentIds}
              disabled={disabled}
              triggerLabel={install.agentIds.size === 0
                ? "Choose agents"
                : `${install.agentIds.size} ${install.agentIds.size === 1 ? "agent" : "agents"} selected`}
              emptyMessage="You cannot edit any agents yet."
              onChange={(agentIds) => onSave({ onAll: false, agentIds })}
            />
          ) : null}
        </div>
      ) : (
        <div className="pt-3">
          {install.onAll ? (
            <p className="text-sm text-muted-foreground">This connection is always loaded for every agent.</p>
          ) : selectedAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground">This connection is not always loaded for any agent.</p>
          ) : (
            <div className="space-y-0.5">
              {selectedAgents.map((agent) => (
                <div key={agent.id} className="flex items-center gap-2 px-1.5 py-1 text-sm">
                  <AgentIcon icon={agent.icon ?? null} className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{agent.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ActionsSection({
  readOnly,
  canChange,
  quarantined,
  enabledIds,
  askFirstIds,
  disabled,
  refreshPending,
  focusId,
  canConfigure,
  onSetPermission,
  onReviewQuarantined,
  onRefreshActions,
}: {
  readOnly: ToolCatalogEntry[];
  canChange: ToolCatalogEntry[];
  quarantined: ToolCatalogEntry[];
  enabledIds: Set<string>;
  askFirstIds: Set<string>;
  disabled: boolean;
  refreshPending: boolean;
  focusId?: string | null;
  /** Server verdict: may this caller change this connection's configuration? */
  canConfigure: boolean;
  onSetPermission: (id: string, next: ActionPermission) => void;
  onReviewQuarantined: (enabledIds: string[]) => void;
  onRefreshActions: () => void;
}) {
  return (
    <section className="space-y-10 border-t border-border pt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Actions</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatActionPermissionSummary(summarizeActionPermissions(
              [...readOnly, ...canChange],
              enabledIds,
              askFirstIds,
            ))}
          </p>
        </div>
        {/* Viewer rule D4: a forbidden action is omitted, not rendered disabled.
            Refreshing the catalog mutates the connection, so a caller who may
            not configure it never sees the control. */}
        {canConfigure ? (
          <div className="flex items-center gap-2">
            {disabled && <span className="text-xs text-muted-foreground">Saving...</span>}
            <Button
              variant="outline"
              size="sm"
              onClick={onRefreshActions}
              disabled={refreshPending || disabled}
            >
              {refreshPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Refresh actions
            </Button>
          </div>
        ) : null}
      </div>

      {canConfigure && quarantined.length > 0 && (
        <QuarantinedActionsReview
          entries={quarantined}
          disabled={disabled}
          onSubmit={onReviewQuarantined}
        />
      )}

      <ActionGroup
        title={`Read (${readOnly.length})`}
        hint="Views data without changing it."
        actions={readOnly}
        enabledIds={enabledIds}
        askFirstIds={askFirstIds}
        disabled={disabled}
        focusId={focusId}
        canConfigure={canConfigure}
        onSetPermission={onSetPermission}
      />
      <ActionGroup
        title={`Write (${canChange.length})`}
        hint="Creates or changes data."
        actions={canChange}
        enabledIds={enabledIds}
        askFirstIds={askFirstIds}
        disabled={disabled}
        focusId={focusId}
        canConfigure={canConfigure}
        onSetPermission={onSetPermission}
      />
    </section>
  );
}

const ACTION_PERMISSION_LABELS: Record<ActionPermission, string> = {
  off: "Off",
  allowed: "Allowed",
  ask: "Ask a human first",
};

function ActionGroup({
  title,
  hint,
  actions,
  enabledIds,
  askFirstIds,
  disabled,
  focusId,
  canConfigure,
  onSetPermission,
}: {
  title: string;
  hint: string;
  actions: ToolCatalogEntry[];
  enabledIds: Set<string>;
  askFirstIds: Set<string>;
  disabled: boolean;
  focusId?: string | null;
  canConfigure: boolean;
  onSetPermission: (id: string, next: ActionPermission) => void;
}) {
  const focusRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusId && focusRef.current) {
      focusRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusId]);
  if (actions.length === 0) return null;
  return (
    <div>
      <div className="pb-4">
        <div className="text-lg font-semibold text-foreground">{title}</div>
        <div className="mt-1 text-sm text-muted-foreground">{hint}</div>
      </div>
      <div className="divide-y divide-border">
        {actions.map((action) => {
          const value = actionPermission(action.id, enabledIds, askFirstIds);
          const focused = focusId === action.id;
          return (
            <div
              key={action.id}
              ref={focused ? focusRef : undefined}
              className={cn(
                "flex items-center gap-4 py-3",
                focused && "rounded-md bg-primary/5 ring-2 ring-primary/40",
              )}
              data-action-id={action.id}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{action.title ?? action.toolName}</div>
                {action.description && (
                  <div className="truncate text-xs text-muted-foreground">{action.description}</div>
                )}
              </div>
              {canConfigure ? (
                <select
                  aria-label={`${action.title ?? action.toolName} permission`}
                  className={cn(
                    "h-9 w-44 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none",
                    "focus-visible:border-ring focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                  value={value}
                  disabled={disabled}
                  onChange={(event) => onSetPermission(action.id, event.currentTarget.value as ActionPermission)}
                >
                  <option value="off">Off</option>
                  <option value="allowed">Allowed</option>
                  <option value="ask">Ask a human first</option>
                </select>
              ) : (
                // Read-only: the same fact, stated rather than offered.
                <span className="w-44 shrink-0 text-sm text-muted-foreground">
                  {ACTION_PERMISSION_LABELS[value]}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function actionPermission(
  id: string,
  enabledIds: Set<string>,
  askFirstIds: Set<string>,
): ActionPermission {
  if (!enabledIds.has(id)) return "off";
  return askFirstIds.has(id) ? "ask" : "allowed";
}
