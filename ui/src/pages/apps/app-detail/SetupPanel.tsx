import { useState } from "react";
import type { ToolCatalogEntry, ToolConnection } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type { AppDetailSectionProps } from "./types";
import { googleSheetsConfigWithAllowlist, parseGoogleSheetIds } from "../google-sheets";

export function SetupPanel({
  connection,
  galleryEntry,
  onToggleApp,
  appToggleDisabled,
  onUpdateConfig,
  configUpdateDisabled,
}: Pick<
  AppDetailSectionProps,
  "connection" | "galleryEntry"
> & {
  onToggleApp: () => void;
  appToggleDisabled: boolean;
  onUpdateConfig: (config: Record<string, unknown>) => void;
  configUpdateDisabled: boolean;
}) {
  const description = galleryEntry?.description ?? galleryEntry?.tagline ?? null;
  return (
    <div className="space-y-6">
      {description && (
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      )}
      {galleryEntry?.key === "google-sheets" && (
        <GoogleSheetsAllowlistSection
          connection={connection}
          disabled={configUpdateDisabled}
          onUpdateConfig={onUpdateConfig}
        />
      )}
      <AppLifecycleSection connection={connection} disabled={appToggleDisabled} onToggle={onToggleApp} />
    </div>
  );
}

function currentSpreadsheetIds(connection: ToolConnection): string[] {
  const raw = connection.config?.allowedSpreadsheetIds;
  return Array.isArray(raw) ? raw.map((value) => String(value).trim()).filter(Boolean) : [];
}

function googleSheetsUrlForId(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
}

function GoogleSheetsAllowlistSection({
  connection,
  disabled,
  onUpdateConfig,
}: {
  connection: ToolConnection;
  disabled: boolean;
  onUpdateConfig: (config: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ids = currentSpreadsheetIds(connection);
  const saveIds = (nextIds: string[]) =>
    onUpdateConfig(googleSheetsConfigWithAllowlist(connection.config, nextIds));

  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4">
      <div>
        <h2 className="text-sm font-bold text-foreground">Sheets agents can use</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Agents can only use the sheets listed here.
        </p>
      </div>

      <div className="mt-4 space-y-2">
        {ids.length === 0 ? (
          <div className="text-sm text-muted-foreground">No sheets are connected yet.</div>
        ) : (
          ids.map((id) => {
            const sheetUrl = googleSheetsUrlForId(id);
            return (
              <div key={id} className="flex items-center gap-3 border-t border-border py-2 first:border-t-0">
                <a
                  href={sheetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 text-sm font-medium text-foreground underline-offset-2 hover:underline"
                >
                  <span className="block truncate">Open sheet</span>
                  <span className="block truncate font-mono text-xs font-normal text-muted-foreground">
                    {sheetUrl}
                  </span>
                  <span className="block truncate font-mono text-[11px] font-normal text-muted-foreground/80">
                    ID: {id}
                  </span>
                </a>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || ids.length <= 1}
                  title={ids.length <= 1 ? "Add another sheet before removing this one." : undefined}
                  onClick={() => saveIds(ids.filter((current) => current !== id))}
                >
                  Remove
                </Button>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          placeholder="https://docs.google.com/spreadsheets/d/..."
          className="h-10"
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            const parsed = parseGoogleSheetIds(draft);
            if (parsed.ids.length === 0) {
              setError("Paste a Google Sheets link.");
              return;
            }
            if (parsed.invalidCount > 0) {
              setError("That doesn't look like a Google Sheets link.");
              return;
            }
            saveIds(Array.from(new Set([...ids, ...parsed.ids])));
            setDraft("");
          }}
        >
          Add sheet
        </Button>
      </div>
      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
    </section>
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
