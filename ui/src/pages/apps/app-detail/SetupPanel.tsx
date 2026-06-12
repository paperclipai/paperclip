import { useState } from "react";
import type { ToolCatalogEntry, ToolConnection } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type { AppDetailSectionProps } from "./types";

export function SetupPanel({
  connection,
  galleryEntry,
  onToggleApp,
  appToggleDisabled,
}: Pick<
  AppDetailSectionProps,
  "connection" | "galleryEntry"
> & {
  onToggleApp: () => void;
  appToggleDisabled: boolean;
}) {
  const description = galleryEntry?.description ?? galleryEntry?.tagline ?? null;
  return (
    <div className="space-y-6">
      {description && (
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      )}
      <AppLifecycleSection connection={connection} disabled={appToggleDisabled} onToggle={onToggleApp} />
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

export function QuarantinePill({
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
