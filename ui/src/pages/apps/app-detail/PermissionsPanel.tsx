import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { Agent, ToolCatalogEntry } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { QuarantinePill } from "./SetupPanel";
import type { AccessDraft, AppDetailSectionProps } from "./types";

type ActionPermission = "off" | "allowed" | "ask";

export function PermissionsPanel({
  access,
  agents,
  readOnly,
  canChange,
  quarantined,
  enabledIds,
  askFirstIds,
  pending,
  onSaveAccess,
  onSetActionPermission,
  onTurnOnQuarantined,
  onRefreshActions,
  refreshPending,
}: Pick<
  AppDetailSectionProps,
  "access" | "agents" | "readOnly" | "canChange" | "quarantined" | "enabledIds" | "askFirstIds" | "pending"
> & {
  onSaveAccess: (next: AccessDraft) => void;
  onSetActionPermission: (id: string, next: ActionPermission) => void;
  onTurnOnQuarantined: (ids: string[]) => void;
  onRefreshActions: () => void;
  refreshPending: boolean;
}) {
  return (
    <div className="space-y-6">
      <AccessSection access={access} agents={agents} disabled={pending} onSave={onSaveAccess} />
      <ActionsSection
        readOnly={readOnly}
        canChange={canChange}
        quarantined={quarantined}
        enabledIds={enabledIds}
        askFirstIds={askFirstIds}
        disabled={pending}
        refreshPending={refreshPending}
        onSetPermission={onSetActionPermission}
        onTurnOnQuarantined={onTurnOnQuarantined}
        onRefreshActions={onRefreshActions}
      />
    </div>
  );
}

function AccessSection({
  access,
  agents,
  disabled,
  onSave,
}: {
  access: AccessDraft;
  agents: Agent[];
  disabled: boolean;
  onSave: (next: AccessDraft) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AccessDraft>(access);
  const liveAgents = agents.filter((a) => a.status !== "terminated");

  useEffect(() => {
    if (!editing) setDraft(access);
  }, [access, editing]);

  const summary =
    access.mode === "all"
      ? "Every agent can use it"
      : `${access.agentIds.size} ${access.agentIds.size === 1 ? "agent" : "agents"} can use it`;

  const canSave = draft.mode === "all" || draft.agentIds.size > 0;

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between px-5 py-4">
        <div>
          <h2 className="text-sm font-bold text-foreground">Who can use it</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{summary}</p>
        </div>
        {!editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Change
          </Button>
        )}
      </div>

      {editing && (
        <div className="space-y-3 border-t border-border px-5 py-4">
          <label className="flex items-start gap-3">
            <input
              type="radio"
              className="mt-1"
              checked={draft.mode === "all"}
              onChange={() => setDraft({ mode: "all", agentIds: new Set() })}
            />
            <span>
              <span className="text-sm font-semibold text-foreground">All agents</span>
              <span className="block text-xs text-muted-foreground">Anyone you've added to Paperclip.</span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="radio"
              className="mt-1"
              checked={draft.mode === "specific"}
              onChange={() => setDraft({ mode: "specific", agentIds: new Set(draft.agentIds) })}
            />
            <span>
              <span className="text-sm font-semibold text-foreground">Only specific agents</span>
              <span className="block text-xs text-muted-foreground">Pick who can use it.</span>
            </span>
          </label>

          {draft.mode === "specific" && (
            <div className="rounded-lg border border-border">
              {liveAgents.length === 0 ? (
                <div className="p-3 text-xs text-muted-foreground">No agents yet.</div>
              ) : (
                liveAgents.map((agent) => (
                  <label key={agent.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/40">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border"
                      checked={draft.agentIds.has(agent.id)}
                      onChange={() => {
                        const next = new Set(draft.agentIds);
                        if (next.has(agent.id)) next.delete(agent.id);
                        else next.add(agent.id);
                        setDraft({ mode: "specific", agentIds: next });
                      }}
                    />
                    <span className="text-sm font-medium text-foreground">{agent.name}</span>
                    {agent.title && <span className="truncate text-xs text-muted-foreground">- {agent.title}</span>}
                  </label>
                ))
              )}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              disabled={disabled || !canSave}
              onClick={() => {
                onSave(draft);
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={disabled}>
              Cancel
            </Button>
          </div>
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
  onSetPermission,
  onTurnOnQuarantined,
  onRefreshActions,
}: {
  readOnly: ToolCatalogEntry[];
  canChange: ToolCatalogEntry[];
  quarantined: ToolCatalogEntry[];
  enabledIds: Set<string>;
  askFirstIds: Set<string>;
  disabled: boolean;
  refreshPending: boolean;
  onSetPermission: (id: string, next: ActionPermission) => void;
  onTurnOnQuarantined: (ids: string[]) => void;
  onRefreshActions: () => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-foreground">Action permissions</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Choose what agents can do and what needs a human first.
          </p>
        </div>
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
      </div>

      {quarantined.length > 0 && (
        <QuarantinePill
          count={quarantined.length}
          entries={quarantined}
          disabled={disabled}
          onTurnOn={onTurnOnQuarantined}
        />
      )}

      <ActionGroup
        title="Read only"
        hint="Can look up context without changing anything."
        actions={readOnly}
        enabledIds={enabledIds}
        askFirstIds={askFirstIds}
        disabled={disabled}
        onSetPermission={onSetPermission}
      />
      <ActionGroup
        title="Can make changes"
        hint="Can change something in another app."
        actions={canChange}
        enabledIds={enabledIds}
        askFirstIds={askFirstIds}
        disabled={disabled}
        onSetPermission={onSetPermission}
      />
    </section>
  );
}

function ActionGroup({
  title,
  hint,
  actions,
  enabledIds,
  askFirstIds,
  disabled,
  onSetPermission,
}: {
  title: string;
  hint: string;
  actions: ToolCatalogEntry[];
  enabledIds: Set<string>;
  askFirstIds: Set<string>;
  disabled: boolean;
  onSetPermission: (id: string, next: ActionPermission) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-3 text-sm">
        <span className="font-bold text-foreground">{title}</span>
        <span className="ml-2 text-muted-foreground">- {hint}</span>
      </div>
      <div className="divide-y divide-border">
        {actions.map((action) => {
          const value = actionPermission(action.id, enabledIds, askFirstIds);
          return (
            <div key={action.id} className="flex items-center gap-4 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{action.title ?? action.toolName}</div>
                {action.description && (
                  <div className="truncate text-xs text-muted-foreground">{action.description}</div>
                )}
              </div>
              <select
                aria-label={`${action.title ?? action.toolName} permission`}
                className={cn(
                  "h-9 w-44 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none",
                  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
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
