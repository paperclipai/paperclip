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
import type { AppDetailSectionProps } from "./types";

type ActionPermission = "off" | "allowed" | "ask";

/**
 * Permissions tab.
 *
 * Agent availability is expressed **once** (PAP-17859). This panel used to
 * stack a legacy "Who can use it" editor on top of "Available to agents",
 * asking the reader to hold two overlapping models of the same fact and to
 * guess which one wins. The install model — *Agents I pick / Any agent* — is
 * now the single visible source of truth.
 *
 * The runtime distinction survives untouched: an install still authorizes its
 * target server-side (`putConnectionInstalls` extends the app profile's
 * bindings), so "installed ⊆ permitted" holds without a second editor. What is
 * gone is the *user-facing* duplicate, and with it the hidden path that could
 * widen access from a control the reader could not see.
 */
export function PermissionsPanel({
  agents,
  install,
  readOnly,
  canChange,
  quarantined,
  enabledIds,
  askFirstIds,
  pending,
  installPending,
  onSaveInstall,
  onSetActionPermission,
  onReviewQuarantined,
  onRefreshActions,
  refreshPending,
  capabilities,
}: Pick<
  AppDetailSectionProps,
  "agents" | "readOnly" | "canChange" | "quarantined" | "enabledIds" | "askFirstIds" | "pending"
> & {
  install: InstallState;
  installPending: boolean;
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
    <div className="space-y-6">
      <AvailableToAgentsSection
        agents={agents}
        install={install}
        capabilities={capabilities}
        disabled={installPending}
        onSave={onSaveInstall}
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

/**
 * "Available to agents" (PAP-17835 Surface E).
 *
 * The old section exposed the runtime's own vocabulary — "permitted only",
 * "installed", an auto-extend warning — which asked the reader to hold two
 * overlapping concepts to answer one question. It is now the same two-choice
 * model the create flow uses: pick agents, or any agent. The runtime
 * distinction still exists in code; it just stopped being the user's problem.
 *
 * Every control is gated on a server capability. A viewer, or a member who may
 * not configure this connection, sees the summary and the agent list with no
 * controls at all rather than disabled ones.
 */
function AvailableToAgentsSection({
  agents,
  install,
  capabilities,
  disabled,
  onSave,
}: {
  agents: Agent[];
  install: InstallState;
  capabilities: ToolConnectionCapabilities | undefined;
  disabled: boolean;
  onSave: (next: InstallState) => void;
}) {
  const liveAgents = agents.filter((a) => a.status !== "terminated");
  const canManage = capabilities?.canManageAgentInstalls ?? false;
  const canSetCompanyWide = capabilities?.canSetCompanyInstall ?? false;
  // "Agents I pick" is scoped to the agents this person may actually edit. The
  // server decides that set; the client never infers it from a role string.
  const editableAgentIds = capabilities?.editableAgentIds;
  const selectableAgents = editableAgentIds
    ? liveAgents.filter((agent) => editableAgentIds.includes(agent.id))
    : liveAgents;
  const mode: "all" | "specific" = install.onAll ? "all" : "specific";
  const selectedAgents = liveAgents.filter((agent) => install.agentIds.has(agent.id));
  const summary = install.onAll
    ? "Any agent"
    : install.agentIds.size === 0
      ? "No agents yet"
      : `${install.agentIds.size} ${install.agentIds.size === 1 ? "agent" : "agents"}`;

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-foreground">Available to agents</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{summary}</p>
        </div>
        {disabled && <span className="text-xs text-muted-foreground">Saving…</span>}
      </div>

      {canManage ? (
        <div className="space-y-3 pt-4">
          <RadioCardGroup
            ariaLabel="Which agents can use this connection"
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
                description: "Choose one or more agents you can edit.",
              },
              {
                value: "all",
                title: "Any agent",
                description: canSetCompanyWide
                  ? "Make this connection available to every agent."
                  : "Only someone who can configure this connection can choose this.",
              },
            ].filter((option) => option.value !== "all" || canSetCompanyWide || install.onAll)}
          />

          {mode === "specific" ? (
            <AgentMultiSelect
              agents={selectableAgents}
              selectedAgentIds={install.agentIds}
              disabled={disabled}
              triggerLabel={
                install.agentIds.size === 0
                  ? "Choose agents"
                  : `${install.agentIds.size} ${install.agentIds.size === 1 ? "agent" : "agents"} selected`
              }
              emptyMessage="You cannot edit any agents yet."
              onChange={(agentIds) => onSave({ onAll: false, agentIds })}
            />
          ) : null}
        </div>
      ) : (
        // Read-only: the state is still fully legible, just not editable.
        <div className="pt-3">
          {install.onAll ? (
            <p className="text-sm text-muted-foreground">Every agent can use this connection.</p>
          ) : selectedAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents have this connection yet.</p>
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
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-foreground">Action permissions</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {canConfigure
              ? "Choose what agents can do and what needs a human first."
              : "What agents can do, and what needs a human first."}
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
        title="Read only"
        hint="Can look up context without changing anything."
        actions={readOnly}
        enabledIds={enabledIds}
        askFirstIds={askFirstIds}
        disabled={disabled}
        focusId={focusId}
        canConfigure={canConfigure}
        onSetPermission={onSetPermission}
      />
      <ActionGroup
        title="Can make changes"
        hint="Can change something in another app."
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
      <div className="pb-2 text-sm">
        <span className="font-bold text-foreground">{title}</span>
        <span className="ml-2 text-muted-foreground">- {hint}</span>
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
