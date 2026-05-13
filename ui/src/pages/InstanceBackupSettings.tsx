import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, AlertTriangle } from "lucide-react";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Field,
  ToggleField,
  HintIcon,
} from "../components/agent-config-primitives";

export function InstanceBackupSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState(false);

  // Local form state
  const [enabled, setEnabled] = useState(true);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [retentionDays, setRetentionDays] = useState(30);
  const [dir, setDir] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Backups" },
    ]);
  }, [setBreadcrumbs]);

  const backupQuery = useQuery({
    queryKey: queryKeys.instance.backupSettings,
    queryFn: () => instanceSettingsApi.getBackup(),
  });

  // Sync form state from query
  useEffect(() => {
    if (backupQuery.data) {
      setEnabled(backupQuery.data.enabled);
      setIntervalMinutes(backupQuery.data.intervalMinutes);
      setRetentionDays(backupQuery.data.retentionDays);
      setDir(backupQuery.data.dir);
    }
  }, [backupQuery.data]);

  const isDirty =
    backupQuery.data &&
    (enabled !== backupQuery.data.enabled ||
      intervalMinutes !== backupQuery.data.intervalMinutes ||
      retentionDays !== backupQuery.data.retentionDays ||
      dir !== backupQuery.data.dir);

  const updateMutation = useMutation({
    mutationFn: async () => {
      setPendingSave(true);
      return instanceSettingsApi.updateBackup({
        enabled,
        intervalMinutes,
        retentionDays,
        dir,
      });
    },
    onSuccess: async () => {
      setActionError(null);
      setPendingSave(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.backupSettings });
    },
    onError: (error) => {
      setPendingSave(false);
      setActionError(error instanceof Error ? error.message : "Failed to update backup settings.");
    },
  });

  if (backupQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading backup settings...</div>;
  }

  if (backupQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {backupQuery.error instanceof Error
          ? backupQuery.error.message
          : "Failed to load backup settings."}
      </div>
    );
  }

  const configFileExists = backupQuery.data?.configFileExists ?? false;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Database Backups</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure automatic database backup schedule and retention policy.
        </p>
      </div>

      {/* Restart warning */}
      <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3">
        <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
            Server restart required
          </p>
          <p className="text-sm text-muted-foreground">
            Changes to backup settings are saved to the config file but only take effect after
            restarting the Paperclip server. The current running settings are shown below.
          </p>
        </div>
      </div>

      {!configFileExists && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm space-y-2">
          <p className="font-medium text-amber-600 dark:text-amber-400">
            No config file found — settings are read-only
          </p>
          <p className="text-muted-foreground">
            Unlike other Instance Settings (which are stored in the database), backup settings are read from{" "}
            <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">config.json</code> at server startup.
            Your instance is currently running on defaults.
          </p>
          <p className="text-muted-foreground">
            To enable editing, either:
          </p>
          <ul className="list-disc list-inside text-muted-foreground ml-2 space-y-1">
            <li>
              Run <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">paperclipai onboard</code> to create a config file
            </li>
            <li>
              Or set values via environment variables (see below)
            </li>
          </ul>
        </div>
      )}

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {updateMutation.isSuccess && !isDirty && (
        <div className="rounded-md border border-green-500/40 bg-green-500/5 px-3 py-2 text-sm text-green-600 dark:text-green-400">
          Settings saved to config file. Restart the server to apply changes.
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5 space-y-5">
        <ToggleField
          label="Enable automatic backups"
          hint="When enabled, the database is backed up automatically on a schedule."
          checked={enabled}
          onChange={setEnabled}
        />

        <Field
          label="Backup interval"
          hint="How often to create a new backup (1-10080 minutes, i.e., up to 7 days)."
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={10080}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Math.max(1, Math.min(10080, Number(e.target.value) || 1)))}
              className="w-24 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            />
            <span className="text-sm text-muted-foreground">minutes</span>
            <span className="text-xs text-muted-foreground ml-2">
              ({Math.floor(intervalMinutes / 60)}h {intervalMinutes % 60}m)
            </span>
          </div>
        </Field>

        <Field
          label="Retention period"
          hint="How long to keep old backups before automatic deletion (1-3650 days)."
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={3650}
              value={retentionDays}
              onChange={(e) => setRetentionDays(Math.max(1, Math.min(3650, Number(e.target.value) || 1)))}
              className="w-24 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            />
            <span className="text-sm text-muted-foreground">days</span>
          </div>
        </Field>

        <Field
          label="Backup directory"
          hint="Where backup files are stored. Supports ~ for home directory."
        >
          <input
            type="text"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="~/.paperclip/instances/default/data/backups"
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
          />
        </Field>
      </section>

      {/* Alternative: Environment Variables */}
      <section className="rounded-xl border border-border bg-card/50 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Alternative: Environment Variables</h2>
          <HintIcon text="Environment variables override config file settings and also require a server restart." />
        </div>
        <p className="text-sm text-muted-foreground">
          You can also configure backups via environment variables. These take precedence over the config file.
        </p>
        <div className="rounded-md bg-muted/30 p-3 font-mono text-xs space-y-1">
          <div><span className="text-muted-foreground">PAPERCLIP_DB_BACKUP_ENABLED=</span>true</div>
          <div><span className="text-muted-foreground">PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=</span>60</div>
          <div><span className="text-muted-foreground">PAPERCLIP_DB_BACKUP_RETENTION_DAYS=</span>30</div>
          <div><span className="text-muted-foreground">PAPERCLIP_DB_BACKUP_DIR=</span>~/.paperclip/instances/default/data/backups</div>
        </div>
      </section>

      {/* Save button */}
      {configFileExists && (
        <div className="flex items-center gap-3">
          <Button
            onClick={() => updateMutation.mutate()}
            disabled={!isDirty || pendingSave}
          >
            {pendingSave ? "Saving..." : "Save to config file"}
          </Button>
          {isDirty && (
            <span className="text-xs text-muted-foreground">
              You have unsaved changes
            </span>
          )}
        </div>
      )}
    </div>
  );
}
