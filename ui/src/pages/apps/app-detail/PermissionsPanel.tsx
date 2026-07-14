import { useEffect, useRef, useState } from "react";
import { Loader2, PackageCheck, RefreshCw } from "lucide-react";
import type { Agent, ToolCatalogEntry } from "@paperclipai/shared";
import { useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AgentMultiSelect } from "@/components/AgentMultiSelect";
import { InlineBanner } from "@/components/InlineBanner";
import { cn } from "@/lib/utils";
import { brandChipBadge } from "@/lib/status-colors";
import {
  autoExtendNotice,
  INSTALL_ALL_WARNING,
  installInfoNotice,
  type InstallState,
} from "@/lib/tool-installs";
import { QuarantinePill } from "./SetupPanel";
import type { AccessDraft, AppDetailSectionProps } from "./types";

type ActionPermission = "off" | "allowed" | "ask";

export function PermissionsPanel({
  appName,
  access,
  agents,
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
  onTurnOnQuarantined,
  onRefreshActions,
  refreshPending,
}: Pick<
  AppDetailSectionProps,
  "access" | "agents" | "readOnly" | "canChange" | "quarantined" | "enabledIds" | "askFirstIds" | "pending"
> & {
  appName: string;
  install: InstallState;
  installPending: boolean;
  onSaveAccess: (next: AccessDraft) => void;
  onSaveInstall: (next: InstallState) => void;
  onSetActionPermission: (id: string, next: ActionPermission) => void;
  onTurnOnQuarantined: (ids: string[]) => void;
  onRefreshActions: () => void;
  refreshPending: boolean;
}) {
  // Deep-link from the Test tab's "off" panel: ?focus={catalogEntryId} scrolls
  // to and highlights that action row.
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get("focus");
  return (
    <div className="space-y-6">
      <AccessSection access={access} agents={agents} disabled={pending} onSave={onSaveAccess} />
      <InstalledSection
        appName={appName}
        agents={agents}
        access={access}
        install={install}
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
            <AgentMultiSelect
              agents={liveAgents}
              selectedAgentIds={draft.agentIds}
              onChange={(agentIds) => setDraft({ mode: "specific", agentIds })}
              disabled={disabled}
            />
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

function InstalledSection({
  appName,
  agents,
  access,
  install,
  disabled,
  onSave,
}: {
  appName: string;
  agents: Agent[];
  access: AccessDraft;
  install: InstallState;
  disabled: boolean;
  onSave: (next: InstallState) => void;
}) {
  const liveAgents = agents.filter((a) => a.status !== "terminated");
  const hasAccess = (agentId: string) => access.mode === "all" || access.agentIds.has(agentId);
  // Agents that are installed but not (yet) in the access set — installing on
  // them auto-extends access server-side. Surfaced amber so it's never silent.
  const extendingAgents =
    access.mode === "all"
      ? []
      : [...install.agentIds].filter((id) => !access.agentIds.has(id));
  const installedCount = install.onAll ? liveAgents.length : install.agentIds.size;

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="text-sm font-bold text-foreground">Installed on agents</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Whose harness carries {appName}'s tools on every run.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {disabled && <span className="text-xs text-muted-foreground">Saving…</span>}
          {install.onAll ? (
            <InstalledBadge label="Installed on all agents" />
          ) : install.agentIds.size > 0 ? (
            <InstalledBadge label={`${installedCount} installed`} />
          ) : (
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              Permitted only — not installed on any agent
            </span>
          )}
        </div>
      </div>

      <div className="space-y-3 border-t border-border px-5 py-4">
        <InlineBanner tone="info" compact>
          {installInfoNotice(appName)}
        </InlineBanner>

        {!install.onAll && (
          <AgentMultiSelect
            agents={liveAgents}
            selectedAgentIds={install.agentIds}
            disabled={disabled}
            triggerLabel={
              install.agentIds.size === 0
                ? "Choose agents to install on"
                : `${install.agentIds.size} ${install.agentIds.size === 1 ? "agent" : "agents"} installed`
            }
            getDescription={(agent) => (hasAccess(agent.id) ? "has access" : "no access yet")}
            renderNameSuffix={(agent) =>
              !hasAccess(agent.id) && install.agentIds.has(agent.id) ? (
                <span className={cn("rounded border px-1 py-0 text-xs font-medium", brandChipBadge.amber)}>
                  will grant access
                </span>
              ) : null
            }
            onChange={(agentIds) => onSave({ onAll: false, agentIds })}
          />
        )}

        <label
          className={cn(
            "flex items-start gap-3 rounded-lg border px-3 py-2.5",
            install.onAll ? "border-foreground bg-muted/40" : "border-border bg-muted/20",
          )}
        >
          <Checkbox
            checked={install.onAll}
            disabled={disabled}
            aria-label="Install on all agents"
            onCheckedChange={(checked) =>
              onSave(checked ? { onAll: true, agentIds: new Set() } : { onAll: false, agentIds: new Set() })
            }
          />
          <span className="text-xs text-foreground">
            <span className="font-semibold">Install on all agents</span>
            <span className="mt-0.5 block text-muted-foreground">
              {INSTALL_ALL_WARNING}
            </span>
          </span>
        </label>

        {extendingAgents.length > 0 ? (
          <InlineBanner tone="warning" compact>
            <span>
              {autoExtendNotice(
                extendingAgents.length === 1
                  ? liveAgents.find((a) => a.id === extendingAgents[0])?.name ?? "1 agent"
                  : `${extendingAgents.length} agents`,
              )}{" "}
              <span className="font-medium">
                Review the {extendingAgents.length} access change
                {extendingAgents.length === 1 ? "" : "s"}
              </span>
            </span>
          </InlineBanner>
        ) : null}
      </div>
    </section>
  );
}

function InstalledBadge({ label }: { label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", brandChipBadge.green)}>
      <PackageCheck className="h-3 w-3" />
      {label}
    </span>
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
  focusId?: string | null;
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
        focusId={focusId}
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
  focusId,
  onSetPermission,
}: {
  title: string;
  hint: string;
  actions: ToolCatalogEntry[];
  enabledIds: Set<string>;
  askFirstIds: Set<string>;
  disabled: boolean;
  focusId?: string | null;
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
    <div className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-3 text-sm">
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
                "flex items-center gap-4 px-5 py-3",
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
