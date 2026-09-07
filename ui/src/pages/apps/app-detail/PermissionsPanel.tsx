import { t, useTranslation } from "@/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Ban, Check, FlaskConical, Loader2, RefreshCw, Search, ShieldQuestion } from "lucide-react";
import type { Agent, ToolCatalogEntry, ToolConnectionCapabilities } from "@paperclipai/shared";
import { useSearchParams } from "@/lib/router";
import { AgentIcon } from "@/components/AgentIconPicker";
import { AgentMultiSelect } from "@/components/AgentMultiSelect";
import { InlineBanner } from "@/components/InlineBanner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { type InstallState } from "@/lib/tool-installs";
import { QuarantinedActionsReview } from "./SetupPanel";
import { ActionTestDialog } from "./TestPanel";
import type { AccessDraft, AppDetailSectionProps } from "./types";

type ActionPermission = "off" | "ask" | "allowed";
type ActionKindFilter = "all" | "read" | "write";

export function PermissionsPanel({
  connectionId,
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
  onSaveAccess,
  onSetActionPermission,
  onReviewQuarantined,
  onRefreshActions,
  refreshPending,
  capabilities,
  permissionChangeWarning,
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
  connectionId: string;
  install: InstallState;
  onSaveAccess: (next: AccessDraft) => void;
  onSetActionPermission: (id: string, next: ActionPermission) => void;
  onReviewQuarantined: (enabledIds: string[]) => void;
  onRefreshActions: () => void;
  refreshPending: boolean;
  capabilities: ToolConnectionCapabilities | undefined;
  permissionChangeWarning?: string;
}) {
  useTranslation();
  const [searchParams] = useSearchParams();
  return (
    <div className="space-y-10">
      <AgentAccessSection
        agents={agents}
        access={access}
        install={install}
        capabilities={capabilities}
        disabled={pending}
        onSave={onSaveAccess}
      />
      <ActionsSection
        key={connectionId}
        connectionId={connectionId}
        appName={appName}
        readOnly={readOnly}
        canChange={canChange}
        quarantined={quarantined}
        enabledIds={enabledIds}
        askFirstIds={askFirstIds}
        disabled={pending}
        refreshPending={refreshPending}
        focusId={searchParams.get("focus")}
        canConfigure={capabilities?.canConfigure ?? false}
        permissionChangeWarning={permissionChangeWarning}
        onSetPermission={onSetActionPermission}
        onReviewQuarantined={onReviewQuarantined}
        onRefreshActions={onRefreshActions}
      />
    </div>
  );
}

function AgentAccessSection({
  agents,
  access,
  install,
  capabilities,
  disabled,
  onSave,
}: {
  agents: Agent[];
  access: AccessDraft;
  install: InstallState;
  capabilities: ToolConnectionCapabilities | undefined;
  disabled: boolean;
  onSave: (next: AccessDraft) => void;
}) {
  const { t } = useTranslation();
  const liveAgents = agents.filter((agent) => agent.status !== "terminated");
  const canManage = capabilities?.canConfigure ?? false;
  const editableAgentIds = capabilities?.editableAgentIds;
  const selectableAgents = editableAgentIds
    ? liveAgents.filter((agent) => editableAgentIds.includes(agent.id))
    : liveAgents;
  const selectedAgents = liveAgents.filter((agent) => access.agentIds.has(agent.id));
  const requiredAgentIds = install.agentIds;

  return (
    <section className="space-y-4 border-t border-border pt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{t("localizationConnections.whichAgentsCanUseThisConnection171")}</h2>
        {disabled ? <span className="text-xs text-muted-foreground">{t("localizationSecrets.saving85")}</span> : null}
      </div>

      {canManage ? (
        <div className="space-y-3">
          <RadioCardGroup
            ariaLabel={t("localizationApps.whichAgentsCanUseThisConnection416")}
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
                title: t("localizationConnections.justAgentsIPick190"),
                description: install.onAll
                  ? t("localizationApps.unavailableWhileThisConnectionIsInstalledForE418")
                  : t("localizationApps.availableOnlyToSelectedAgents419"),
                disabled: install.onAll,
              },
              {
                value: "all",
                title: t("localizationConnections.anyAgent193"),
                description: t("localizationApps.availableAcrossYourCompany421"),
              },
            ]}
          />

          {access.mode === "specific" ? (
            <AgentMultiSelect
              agents={selectableAgents}
              selectedAgentIds={access.agentIds}
              disabled={disabled}
              triggerLabel={access.agentIds.size === 0
                ? t("localizationApps.chooseAgents422")
                : t("localizationApps.selectedAgentsCount", { count: access.agentIds.size })}
              emptyMessage={t("localizationConnections.youCannotEditAnyAgentsYet198")}
              isAgentDisabled={(agent) => requiredAgentIds.has(agent.id)}
              getDescription={(agent) => requiredAgentIds.has(agent.id) ? t("localizationApps.requiredByThisConnectionSInstallSetting424") : agent.title}
              onChange={(agentIds) => onSave({
                mode: "specific",
                agentIds: new Set([...agentIds, ...requiredAgentIds]),
              })}
            />
          ) : null}
        </div>
      ) : access.mode === "all" ? (
        <p className="text-sm text-muted-foreground">{t("localizationApps.anyAgentCanUseThisConnection425")}</p>
      ) : selectedAgents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("localizationApps.noAgentsCanUseThisConnection426")}</p>
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
    </section>
  );
}

function ActionsSection({
  connectionId,
  appName,
  readOnly,
  canChange,
  quarantined,
  enabledIds,
  askFirstIds,
  disabled,
  refreshPending,
  focusId,
  canConfigure,
  permissionChangeWarning,
  onSetPermission,
  onReviewQuarantined,
  onRefreshActions,
}: {
  connectionId: string;
  appName: string;
  readOnly: ToolCatalogEntry[];
  canChange: ToolCatalogEntry[];
  quarantined: ToolCatalogEntry[];
  enabledIds: Set<string>;
  askFirstIds: Set<string>;
  disabled: boolean;
  refreshPending: boolean;
  focusId?: string | null;
  canConfigure: boolean;
  permissionChangeWarning?: string;
  onSetPermission: (id: string, next: ActionPermission) => void;
  onReviewQuarantined: (enabledIds: string[]) => void;
  onRefreshActions: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<ActionKindFilter>("all");
  const [showPermissionChangeWarning, setShowPermissionChangeWarning] = useState(false);
  const byName = (a: ToolCatalogEntry, b: ToolCatalogEntry) =>
    (a.title ?? a.toolName).localeCompare(b.title ?? b.toolName);
  const sortedRead = useMemo(() => [...readOnly].sort(byName), [readOnly]);
  const sortedWrite = useMemo(() => [...canChange].sort(byName), [canChange]);
  const matches = (entry: ToolCatalogEntry) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return (entry.title ?? entry.toolName).toLowerCase().includes(needle)
      || (entry.description ?? "").toLowerCase().includes(needle);
  };
  const visibleRead = kindFilter === "write" ? [] : sortedRead.filter(matches);
  const visibleWrite = kindFilter === "read" ? [] : sortedWrite.filter(matches);
  const visibleCount = visibleRead.length + visibleWrite.length;

  return (
    <section className="space-y-6 border-t border-border pt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">{t("pages.apps.connections.columnActions")}</h2>
        {canConfigure ? (
          <div className="flex items-center gap-2">
            {disabled ? <span className="text-xs text-muted-foreground">{t("localizationSecrets.saving85")}</span> : null}
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
              )}{t("localizationApps.refreshActions428")}</Button>
          </div>
        ) : null}
      </div>

      {canConfigure && quarantined.length > 0 ? (
        <QuarantinedActionsReview
          entries={quarantined}
          disabled={disabled}
          onSubmit={onReviewQuarantined}
        />
      ) : null}

      {permissionChangeWarning && showPermissionChangeWarning ? (
        <InlineBanner tone="warning" compact>
          {permissionChangeWarning}
        </InlineBanner>
      ) : null}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-(--sz-12rem) flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={t("localizationApps.findAnAction429")}
              placeholder={t("localizationApps.findAnAction430")}
              className="pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <FilterChip label={t("localizationApps.allActionsCount", { count: readOnly.length + canChange.length })} active={kindFilter === "all"} onClick={() => setKindFilter("all")} />
          <FilterChip label={t("localizationApps.readActionsCount", { count: readOnly.length })} active={kindFilter === "read"} onClick={() => setKindFilter("read")} />
          <FilterChip label={t("localizationApps.writeActionsCount", { count: canChange.length })} active={kindFilter === "write"} onClick={() => setKindFilter("write")} />
        </div>
        <p className="text-xs text-muted-foreground">{t("localizationApps.matchesSorted", { count: visibleCount })}</p>
      </div>

      {visibleCount === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          {t("localizationApps.noActionsMatch", { query })}
        </div>
      ) : (
        <div className="space-y-6">
          <ActionGroup
            title={t("localizationApps.readActionsParenthesized", { count: visibleRead.length })}
            actions={visibleRead}
            connectionId={connectionId}
            appName={appName}
            enabledIds={enabledIds}
            askFirstIds={askFirstIds}
            disabled={disabled}
            focusId={focusId}
            canConfigure={canConfigure}
            onSetPermission={(id, next) => {
              setShowPermissionChangeWarning(true);
              onSetPermission(id, next);
            }}
          />
          <ActionGroup
            title={t("localizationApps.writeActionsParenthesized", { count: visibleWrite.length })}
            actions={visibleWrite}
            connectionId={connectionId}
            appName={appName}
            enabledIds={enabledIds}
            askFirstIds={askFirstIds}
            disabled={disabled}
            focusId={focusId}
            canConfigure={canConfigure}
            onSetPermission={(id, next) => {
              setShowPermissionChangeWarning(true);
              onSetPermission(id, next);
            }}
          />
        </div>
      )}
    </section>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {label}
    </button>
  );
}

function ActionGroup({
  title,
  actions,
  connectionId,
  appName,
  enabledIds,
  askFirstIds,
  disabled,
  focusId,
  canConfigure,
  onSetPermission,
}: {
  title: string;
  actions: ToolCatalogEntry[];
  connectionId: string;
  appName: string;
  enabledIds: Set<string>;
  askFirstIds: Set<string>;
  disabled: boolean;
  focusId?: string | null;
  canConfigure: boolean;
  onSetPermission: (id: string, next: ActionPermission) => void;
}) {
  useTranslation();
  if (actions.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="divide-y divide-border">
        {actions.map((action) => (
          <ActionRow
            key={action.id}
            action={action}
            connectionId={connectionId}
            appName={appName}
            value={actionPermission(action.id, enabledIds, askFirstIds)}
            disabled={disabled}
            focused={focusId === action.id}
            canConfigure={canConfigure}
            onSetPermission={onSetPermission}
          />
        ))}
      </div>
    </div>
  );
}

const PERMISSION_OPTIONS: Array<{
  value: ActionPermission;
  label: string;
  description: string;
  icon: typeof Ban;
}> = [
  { value: "off", get label() { return t("pages.instanceSettings.off"); }, get description() { return t("localizationApps.agentsCannotRunThisAction439"); }, icon: Ban },
  { value: "ask", get label() { return t("pages.apps.connect.actions.askFirst"); }, get description() { return t("localizationApps.aHumanMustApproveEachCall441"); }, icon: ShieldQuestion },
  { value: "allowed", get label() { return t("localizationApps.allowed166"); }, get description() { return t("localizationApps.runsWithoutApproval442"); }, icon: Check },
];

function ActionRow({
  action,
  connectionId,
  appName,
  value,
  disabled,
  focused,
  canConfigure,
  onSetPermission,
}: {
  action: ToolCatalogEntry;
  connectionId: string;
  appName: string;
  value: ActionPermission;
  disabled: boolean;
  focused: boolean;
  canConfigure: boolean;
  onSetPermission: (id: string, next: ActionPermission) => void;
}) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const title = action.title ?? action.toolName;

  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focused]);

  return (
    <>
      <div
        ref={rowRef}
        className={cn(
          "flex flex-col gap-3 py-3 sm:flex-row sm:items-center",
          focused && "rounded-md bg-primary/5 ring-2 ring-primary/40",
        )}
        data-action-id={action.id}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {action.description ? (
            <div className="truncate text-xs text-muted-foreground">{action.description}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canConfigure ? (
            <TooltipProvider>
              <div
                role="radiogroup"
                aria-label={t("localizationApps.actionPermissionLabel", { title })}
                className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
              >
              {PERMISSION_OPTIONS.map((option) => {
                const Icon = option.icon;
                const selected = option.value === value;
                return (
                  <Tooltip key={option.value}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={`${title}: ${option.label}`}
                        disabled={disabled}
                        onClick={() => onSetPermission(action.id, option.value)}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors",
                          "hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                          "disabled:cursor-not-allowed disabled:opacity-50",
                          selected && "bg-background text-foreground shadow-xs",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <span className="font-medium">{option.label}</span> — {option.description}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
              </div>
            </TooltipProvider>
          ) : (
            <span className="text-sm text-muted-foreground">
              {PERMISSION_OPTIONS.find((option) => option.value === value)?.label}
            </span>
          )}
          <Button type="button" size="sm" variant="outline" onClick={() => setTestOpen(true)}>
            <FlaskConical className="mr-1.5 h-3.5 w-3.5" />{t("localizationApps.test447")}</Button>
        </div>
      </div>
      <ActionTestDialog
        connectionId={connectionId}
        appName={appName}
        entry={action}
        open={testOpen}
        onOpenChange={setTestOpen}
      />
    </>
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
