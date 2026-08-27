import { useState } from "react";
import type { ToolCatalogEntry, ToolConnection } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { appDefinitionSlug } from "../app-definition-display";
import type { AppDetailSectionProps } from "./types";
import { googleSheetsConfigWithAllowlist, parseGoogleSheetIds } from "../google-sheets";

export function SetupPanel({
  connection,
  galleryEntry,
  onToggleApp,
  appToggleDisabled,
  onUpdateConfig,
  configUpdateDisabled,
  onStartOAuth,
  oauthStartDisabled,
}: Pick<
  AppDetailSectionProps,
  "connection" | "galleryEntry"
> & {
  onToggleApp: () => void;
  appToggleDisabled: boolean;
  onUpdateConfig: (config: Record<string, unknown>) => void;
  configUpdateDisabled: boolean;
  onStartOAuth: () => void;
  oauthStartDisabled: boolean;
}) {
  const description = galleryEntry?.description ?? null;
  const oauth = connection.config?.oauth;
  const hasOAuthSignIn = Boolean(oauth && typeof oauth === "object" && !Array.isArray(oauth));
  const isSmokeLabFixture = connection.config?.smokeLabFixture === "oauth-http";
  return (
    <div className="space-y-6">
      {description && (
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      )}
      {appDefinitionSlug(galleryEntry) === "google-sheets" && (
        <GoogleSheetsAllowlistSection
          connection={connection}
          disabled={configUpdateDisabled}
          onUpdateConfig={onUpdateConfig}
        />
      )}
      {appDefinitionSlug(galleryEntry) === "posthog" && (
        <PostHogConfigurationSection connection={connection} />
      )}
      {hasOAuthSignIn && (
        <OAuthConnectionSection
          connected={Boolean((oauth as Record<string, unknown>).connectedAt)}
          providerName={appDefinitionSlug(galleryEntry) === "notion"
            ? "Notion"
            : appDefinitionSlug(galleryEntry) === "posthog"
              ? "PostHog"
              : isSmokeLabFixture ? "Smoke OAuth" : "OAuth"}
          disabled={oauthStartDisabled}
          onStart={onStartOAuth}
        />
      )}
      <AppLifecycleSection connection={connection} disabled={appToggleDisabled} onToggle={onToggleApp} />
    </div>
  );
}

function PostHogConfigurationSection({ connection }: { connection: ToolConnection }) {
  const raw = connection.config?.methodConfig;
  const config = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const method = connection.config?.connectionMethodKey === "mcp-oauth" ? "PostHog sign-in" : "Personal API key";
  const features = typeof config.features === "string" ? config.features : "None";
  const tools = typeof config.tools === "string" && config.tools ? config.tools : "None";
  const rows = [
    ["Connection method", method],
    ["Project ID", typeof config.projectId === "string" ? config.projectId : "Not set"],
    ["Read-only mode", config.readOnly === true ? "On" : "Off"],
    ["Feature groups", features],
    ["Individual tools", tools],
    ["Response mode", typeof config.mode === "string" ? config.mode : "tools"],
  ];
  return (
    <section>
      <h2 className="text-sm font-bold text-foreground">PostHog access scope</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        This connection is pinned to the project and analytics surface below.
      </p>
      <dl className="mt-4 divide-y divide-border">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 py-2 sm:grid-cols-3 sm:gap-4">
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="break-words text-sm text-foreground sm:col-span-2">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function OAuthConnectionSection({
  connected,
  providerName,
  disabled,
  onStart,
}: {
  connected: boolean;
  providerName: string;
  disabled: boolean;
  onStart: () => void;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold text-foreground">
            {connected ? `${providerName} connected` : `Connect with ${providerName}`}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {connected
              ? "Your workspace authorization is active. Reconnect any time to replace it."
              : "Open the provider's consent page to finish connecting this app."}
          </p>
        </div>
        <Button type="button" disabled={disabled} onClick={onStart}>
          {connected ? "Reconnect" : `Connect with ${providerName}`}
        </Button>
      </div>
    </section>
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
    <section>
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
                  <span className="block truncate font-mono text-(length:--text-micro) font-normal text-muted-foreground/80">
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
    <section>
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

export function QuarantinedActionsReview({
  entries,
  disabled,
  onSubmit,
}: {
  entries: ToolCatalogEntry[];
  disabled: boolean;
  onSubmit: (enabledIds: string[]) => void;
}) {
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const count = entries.length;
  const selectedIds = entries.filter((entry) => enabledIds.has(entry.id)).map((entry) => entry.id);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            Review {count} new {count === 1 ? "action" : "actions"}
          </div>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            Turn on the actions agents may use. Anything left off stays blocked when you save.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-xs font-medium text-amber-800 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-50"
            disabled={disabled}
            onClick={() => setEnabledIds(new Set(entries.map((entry) => entry.id)))}
          >
            Turn all on
          </button>
          <button
            type="button"
            className="text-xs font-medium text-amber-800 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-50"
            disabled={disabled}
            onClick={() => setEnabledIds(new Set())}
          >
            Turn all off
          </button>
        </div>
      </div>
      <div className="divide-y divide-border">
        {entries.map((entry) => {
          const enabled = enabledIds.has(entry.id);
          const label = entry.title ?? entry.toolName;
          return (
            <div key={entry.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{label}</div>
                {entry.description && (
                  <div className="truncate text-xs text-muted-foreground">{entry.description}</div>
                )}
              </div>
              <ToggleSwitch
                aria-label={`${label} allowed`}
                checked={enabled}
                disabled={disabled}
                onCheckedChange={(next) => {
                  setEnabledIds((current) => {
                    const updated = new Set(current);
                    if (next) updated.add(entry.id);
                    else updated.delete(entry.id);
                    return updated;
                  });
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-amber-700 dark:text-amber-300">
          {selectedIds.length} of {count} will be on
        </span>
        <Button size="sm" disabled={disabled} onClick={() => onSubmit(selectedIds)}>
          {disabled ? "Saving…" : "Save choices"}
        </Button>
      </div>
    </section>
  );
}
