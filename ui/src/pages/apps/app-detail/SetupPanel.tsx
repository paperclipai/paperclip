import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { ToolCatalogEntry, ToolConnection } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type { AppDetailSectionProps } from "./types";

export function SetupPanel({
  connection,
  readOnly,
  canChange,
  quarantined,
  enabledIds,
  pending,
  onToggleApp,
  appToggleDisabled,
  onToggleAction,
  onTurnOnQuarantined,
  onRefreshTools,
  refreshPending,
}: Pick<
  AppDetailSectionProps,
  "connection" | "readOnly" | "canChange" | "quarantined" | "enabledIds" | "pending"
> & {
  onToggleApp: () => void;
  appToggleDisabled: boolean;
  onToggleAction: (id: string, on: boolean) => void;
  onTurnOnQuarantined: (ids: string[]) => void;
  onRefreshTools: () => void;
  refreshPending: boolean;
}) {
  return (
    <div className="space-y-6">
      <AppLifecycleSection connection={connection} disabled={appToggleDisabled} onToggle={onToggleApp} />

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold text-foreground">Actions</h2>
          <div className="flex items-center gap-2">
            {pending && <span className="text-xs text-muted-foreground">Saving...</span>}
            <Button
              variant="outline"
              size="sm"
              onClick={onRefreshTools}
              disabled={refreshPending || pending}
            >
              {refreshPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Refresh tools
            </Button>
          </div>
        </div>

        {quarantined.length > 0 && (
          <QuarantinePill
            count={quarantined.length}
            entries={quarantined}
            disabled={pending}
            onTurnOn={onTurnOnQuarantined}
          />
        )}

        <ActionGroup
          title="Read only"
          hint="these can look but not change anything"
          actions={readOnly}
          enabledIds={enabledIds}
          disabled={pending}
          onToggle={onToggleAction}
        />
        <ActionGroup
          title="Can make changes"
          hint="these change something in another app"
          actions={canChange}
          enabledIds={enabledIds}
          disabled={pending}
          onToggle={onToggleAction}
        />
      </section>
    </div>
  );
}

export function AppLifecycleSection({
  connection,
  disabled,
  onToggle,
}: {
  connection: ToolConnection;
  disabled: boolean;
  onToggle: () => void;
}) {
  const enabled = connection.enabled !== false && connection.status !== "disabled";
  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold text-foreground">
            {enabled ? "Agents can use this app" : "This app is paused"}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {enabled
              ? "Pause it to stop every agent from using its actions."
              : "Resume it when agents should be able to use its actions again."}
          </p>
        </div>
        <ToggleSwitch
          aria-label={enabled ? "Pause this app" : "Resume this app"}
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onToggle}
          size="lg"
        />
      </div>
    </section>
  );
}

function ActionGroup({
  title,
  hint,
  actions,
  enabledIds,
  disabled,
  onToggle,
}: {
  title: string;
  hint: string;
  actions: ToolCatalogEntry[];
  enabledIds: Set<string>;
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
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
          const on = enabledIds.has(action.id);
          return (
            <div key={action.id} className="flex items-center gap-4 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{action.title ?? action.toolName}</div>
                {action.description && (
                  <div className="truncate text-xs text-muted-foreground">{action.description}</div>
                )}
              </div>
              <ToggleSwitch
                checked={on}
                disabled={disabled}
                onCheckedChange={(next) => onToggle(action.id, next)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QuarantinePill({
  count,
  entries,
  disabled,
  onTurnOn,
}: {
  count: number;
  entries: ToolCatalogEntry[];
  disabled: boolean;
  onTurnOn: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.08] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-amber-800 dark:text-amber-200">
          {count} new {count === 1 ? "action" : "actions"} to review
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Review"}
          </Button>
          <Button size="sm" disabled={disabled} onClick={() => onTurnOn(entries.map((e) => e.id))}>
            Turn on all
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
        This app added actions since you set it up. They stay off until you turn them on.
      </p>
      {open && (
        <div className="mt-3 divide-y divide-amber-500/25 rounded-lg border border-amber-500/40 bg-background">
          {entries.map((entry) => (
            <div key={entry.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{entry.title ?? entry.toolName}</div>
                {entry.description && (
                  <div className="truncate text-xs text-muted-foreground">{entry.description}</div>
                )}
              </div>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => onTurnOn([entry.id])}>
                Turn on
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
