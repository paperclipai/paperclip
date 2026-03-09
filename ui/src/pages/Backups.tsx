import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BackupAuditEvent,
  BackupComponentKey,
  BackupComponentSupport,
  BackupRestorePreview,
  BackupRestoreState,
  BackupRun,
  BackupSettings,
} from "@paperclipai/shared";
import {
  Archive,
  ArchiveX,
  CheckCircle2,
  Clock3,
  CloudUpload,
  Download,
  Eye,
  FolderArchive,
  HardDriveDownload,
  History,
  KeyRound,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { backupsApi } from "@/api/backups";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatBytes, formatDateTime, relativeTime } from "@/lib/utils";

const COMPONENT_ORDER: BackupComponentKey[] = [
  "database",
  "storage",
  "config",
  "env",
  "secretsKey",
  "workspaces",
];

const OPTIONAL_COMPONENT_KEYS = ["storage", "config", "env", "secretsKey", "workspaces"] as const;

function emptySettings(): BackupSettings {
  return {
    enabled: true,
    intervalMinutes: 60,
    retentionDays: 30,
    directory: "",
    components: {
      storage: true,
      config: true,
      env: false,
      secretsKey: false,
      workspaces: false,
    },
    requireSignedBackups: false,
    remote: {
      provider: "none",
      s3: {
        bucket: "",
        region: "us-east-1",
        endpoint: null,
        prefix: "",
        accessKeyId: null,
        secretAccessKey: null,
        forcePathStyle: false,
        deleteFromRemoteOnDelete: false,
        serverSideEncryption: "none",
        kmsKeyId: null,
      },
    },
    updatedAt: null,
    updatedBy: null,
  };
}

function statusTone(
  status:
    | BackupRun["status"]
    | BackupRestoreState["status"]
    | "included"
    | "verified"
    | "mismatch"
    | "error"
    | "unverifiable"
    | "skipped"
    | "not_needed"
    | "missing"
    | "unsupported"
    | "failed",
) {
  switch (status) {
    case "succeeded":
    case "included":
    case "verified":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "running":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
    case "skipped":
    case "not_needed":
    case "idle":
      return "bg-muted text-muted-foreground";
    case "missing":
    case "unverifiable":
    case "unsupported":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "mismatch":
    case "error":
    case "failed":
      return "bg-red-500/15 text-red-700 dark:text-red-300";
  }
}

function restoreStatusIcon(status: BackupRestoreState["status"]) {
  switch (status) {
    case "succeeded":
      return ShieldCheck;
    case "failed":
      return ShieldAlert;
    case "running":
      return Clock3;
    case "idle":
      return Archive;
  }
}

function metricLabel(value: string, label: string, icon: typeof Archive) {
  const Icon = icon;
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function durationText(run: BackupRun): string {
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const start = new Date(run.startedAt).getTime();
  const seconds = Math.max(1, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`;
}

function SettingsField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      {children}
    </label>
  );
}

function StatusBadge({
  label,
  status,
}: {
  label: string;
  status:
    | BackupRun["status"]
    | BackupRestoreState["status"]
    | "included"
    | "verified"
    | "mismatch"
    | "error"
    | "unverifiable"
    | "skipped"
    | "not_needed"
    | "missing"
    | "unsupported"
    | "failed";
}) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", statusTone(status))}>
      {label}
    </span>
  );
}

function DetailSection({
  title,
  description,
  defaultOpen,
  children,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="rounded-lg border border-border bg-muted/20 px-3 py-2" open={defaultOpen || undefined}>
      <summary className="cursor-pointer list-none text-sm font-medium text-foreground">{title}</summary>
      {description ? <div className="mt-1 text-xs text-muted-foreground">{description}</div> : null}
      <div className="mt-3">{children}</div>
    </details>
  );
}

function RestorePreviewSummary({ preview }: { preview: BackupRestorePreview }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{preview.bundleName}</span>
            <StatusBadge label={preview.canRestore ? "restorable" : "blocked"} status={preview.canRestore ? "succeeded" : "failed"} />
            <StatusBadge label={`integrity ${preview.integrity.status}`} status={preview.integrity.status} />
            <StatusBadge label={`signature ${preview.signature.status}`} status={preview.signature.status} />
          </div>
          <div className="text-xs text-muted-foreground">Checked {formatDateTime(preview.checkedAt)}</div>
        </div>
      </div>

      {preview.issues.length > 0 ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          {preview.issues.join(" ")}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Restore</div>
          <div className="mt-1 font-medium">{preview.canRestore ? "Ready to apply" : "Blocked"}</div>
        </div>
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Integrity</div>
          <div className="mt-1 font-medium">{preview.integrity.status}</div>
        </div>
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Signature</div>
          <div className="mt-1 font-medium">
            {preview.signature.keyId ? `${preview.signature.status} (${preview.signature.keyId})` : preview.signature.status}
          </div>
        </div>
      </div>

      <div className="grid gap-2">
        {preview.components.map((component) => (
          <div key={component.key} className="rounded-md border border-border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{component.label}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {component.action}
              </span>
              <StatusBadge label={component.integrityStatus} status={component.integrityStatus} />
            </div>
            {component.issues.length > 0 ? (
              <div className="mt-1 text-xs text-red-700 dark:text-red-300">{component.issues.join(" ")}</div>
            ) : component.notes ? (
              <div className="mt-1 text-xs text-muted-foreground">{component.notes}</div>
            ) : null}
          </div>
        ))}
      </div>

      <DetailSection title="Technical details" description="Hashes, destination paths, and low-level validation output.">
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Expected bundle hash</div>
              <div className="mt-1 font-mono text-xs break-all">{preview.integrity.expectedBundleHash ?? "Not recorded"}</div>
            </div>
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Actual bundle hash</div>
              <div className="mt-1 font-mono text-xs break-all">{preview.integrity.actualBundleHash ?? "Not computed"}</div>
            </div>
          </div>

          {(preview.signature.issues.length > 0 || preview.integrity.issues.length > 0) ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
              {[...preview.signature.issues, ...preview.integrity.issues].join(" ")}
            </div>
          ) : null}

          <div className="grid gap-2">
            {preview.components.map((component) => (
              <div key={`${component.key}-technical`} className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{component.label}</span>
                  <StatusBadge label={component.integrityStatus} status={component.integrityStatus} />
                </div>
                <div className="mt-2 space-y-1">
                  <div>{component.destinationPath ?? "No destination path"}</div>
                  {component.expectedHash ? <div className="font-mono break-all">expected {component.expectedHash}</div> : null}
                  {component.actualHash ? <div className="font-mono break-all">actual {component.actualHash}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </DetailSection>
    </div>
  );
}

export function Backups() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<BackupSettings>(emptySettings());
  const [previewBackupId, setPreviewBackupId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Backups" }]);
  }, [setBreadcrumbs]);

  const overviewQuery = useQuery({
    queryKey: queryKeys.backups.overview,
    queryFn: () => backupsApi.overview(),
    refetchInterval: 5_000,
  });

  const previewQuery = useQuery({
    queryKey: previewBackupId ? queryKeys.backups.preview(previewBackupId) : ["backups", "preview", "idle"],
    queryFn: () => backupsApi.previewRestore(previewBackupId!),
    enabled: previewBackupId !== null,
  });

  useEffect(() => {
    if (!overviewQuery.data) return;
    setSettingsDraft(overviewQuery.data.settings);
  }, [overviewQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => backupsApi.updateSettings({
      enabled: settingsDraft.enabled,
      intervalMinutes: settingsDraft.intervalMinutes,
      retentionDays: settingsDraft.retentionDays,
      directory: settingsDraft.directory,
      components: settingsDraft.components,
      requireSignedBackups: settingsDraft.requireSignedBackups,
      remote: settingsDraft.remote,
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.backups.overview });
    },
  });

  const runMutation = useMutation({
    mutationFn: () => backupsApi.run(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.backups.overview });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: ({ backupId }: { backupId: string }) => backupsApi.restore(backupId, { confirmText: "RESTORE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.backups.overview });
    },
  });

  const importMutation = useMutation({
    mutationFn: (file: File) => backupsApi.importFile(file),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.backups.overview });
      window.alert("Backup imported. You can now restore it from snapshot history.");
    },
  });

  const archiveMutation = useMutation({
    mutationFn: ({ backupId }: { backupId: string }) => backupsApi.archive(backupId, { confirmText: "ARCHIVE" }),
    onSuccess: async (result) => {
      if (previewBackupId === result.backupId) {
        setPreviewBackupId(null);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.backups.overview });
      window.alert(`Backup archived to ${result.archivedPath}.`);
    },
  });

  const unarchiveMutation = useMutation({
    mutationFn: ({ backupId }: { backupId: string }) => backupsApi.unarchive(backupId, { confirmText: "UNARCHIVE" }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.backups.overview });
      window.alert(`Backup ${result.bundleName} returned to active history.`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ backupId }: { backupId: string }) => backupsApi.delete(backupId, { confirmText: "DELETE" }),
    onSuccess: async (result) => {
      if (previewBackupId === result.backupId) {
        setPreviewBackupId(null);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.backups.overview });
      window.alert(`Backup ${result.bundleName} deleted.`);
    },
  });

  const dirty = useMemo(() => {
    if (!overviewQuery.data) return false;
    return JSON.stringify(overviewQuery.data.settings) !== JSON.stringify(settingsDraft);
  }, [overviewQuery.data, settingsDraft]);

  const supportByKey = useMemo(() => {
    const map = new Map<BackupComponentKey, BackupComponentSupport>();
    for (const component of overviewQuery.data?.support ?? []) {
      map.set(component.key, component);
    }
    return map;
  }, [overviewQuery.data]);

  if (overviewQuery.isLoading) {
    return <PageSkeleton variant="backups" />;
  }

  if (overviewQuery.error) {
    return <p className="text-sm text-destructive">{overviewQuery.error.message}</p>;
  }

  const overview = overviewQuery.data;
  if (!overview) {
    return <p className="text-sm text-muted-foreground">Backup manager is unavailable.</p>;
  }

  const latestSnapshotLabel = overview.latestSuccess
    ? relativeTime(overview.latestSuccess.startedAt)
    : "Never";
  const restoreRunning = overview.restore.status === "running";
  const anyMutationError =
    saveMutation.error
    ?? runMutation.error
    ?? restoreMutation.error
    ?? importMutation.error
    ?? archiveMutation.error
    ?? unarchiveMutation.error
    ?? deleteMutation.error;
  const settingsLocked =
    overview.scheduler.running
    || restoreRunning
    || restoreMutation.isPending
    || importMutation.isPending
    || archiveMutation.isPending
    || unarchiveMutation.isPending
    || deleteMutation.isPending;
  const RestoreStatusIcon = restoreStatusIcon(overview.restore.status);
  const archivedCount = overview.backups.filter((backup) => backup.archivedAt).length;
  const visibleBackups = overview.backups.filter((backup) => showArchived || !backup.archivedAt);
  const enabledOptionalComponents = OPTIONAL_COMPONENT_KEYS
    .filter((key) => settingsDraft.components[key])
    .map((key) => supportByKey.get(key)?.label ?? key);
  const sensitiveComponentsEnabled = settingsDraft.components.env || settingsDraft.components.secretsKey;
  const recentAuditEvents = overview.audit.recentEvents.slice().reverse().slice(0, 6);

  const handleDownload = (backupId: string) => {
    window.location.assign(backupsApi.downloadUrl(backupId));
  };

  const handleRestore = (backup: BackupRun) => {
    const confirmation = window.prompt(
      `Type RESTORE to replace the current instance with snapshot ${backup.bundleName}. This action is destructive.`,
    );
    if (confirmation === null) return;
    if (confirmation !== "RESTORE") {
      window.alert("Restore cancelled. Type RESTORE exactly to continue.");
      return;
    }
    restoreMutation.mutate({ backupId: backup.id });
  };

  const handlePreview = (backupId: string) => {
    setPreviewBackupId((current) => current === backupId ? null : backupId);
  };

  const handleArchive = (backup: BackupRun) => {
    const confirmation = window.prompt(
      `Type ARCHIVE to move snapshot ${backup.bundleName} out of active history without deleting the bundle.`,
    );
    if (confirmation === null) return;
    if (confirmation !== "ARCHIVE") {
      window.alert("Archive cancelled. Type ARCHIVE exactly to continue.");
      return;
    }
    archiveMutation.mutate({ backupId: backup.id });
  };

  const handleUnarchive = (backup: BackupRun) => {
    const confirmation = window.prompt(
      `Type UNARCHIVE to return snapshot ${backup.bundleName} to active history.`,
    );
    if (confirmation === null) return;
    if (confirmation !== "UNARCHIVE") {
      window.alert("Unarchive cancelled. Type UNARCHIVE exactly to continue.");
      return;
    }
    unarchiveMutation.mutate({ backupId: backup.id });
  };

  const handleDelete = (backup: BackupRun) => {
    const confirmation = window.prompt(
      `Type DELETE to permanently remove snapshot ${backup.bundleName} from disk.`,
    );
    if (confirmation === null) return;
    if (confirmation !== "DELETE") {
      window.alert("Delete cancelled. Type DELETE exactly to continue.");
      return;
    }
    deleteMutation.mutate({ backupId: backup.id });
  };

  const handleImportSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    importMutation.mutate(file);
  };

  return (
    <div className="space-y-6">
      <input
        ref={importInputRef}
        type="file"
        accept=".tar.gz,.tgz,application/gzip,application/x-gzip,application/octet-stream"
        className="hidden"
        onChange={handleImportSelection}
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Backups</h1>
          <p className="text-sm text-muted-foreground">
            Run instance snapshots, download them, import them on another machine, and restore from retained history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => importInputRef.current?.click()}
            disabled={settingsLocked}
          >
            <Upload className="h-4 w-4" />
            {importMutation.isPending ? "Importing..." : "Import backup"}
          </Button>
          <Button
            variant="outline"
            onClick={() => void queryClient.invalidateQueries({ queryKey: queryKeys.backups.overview })}
            disabled={overviewQuery.isFetching}
          >
            Refresh
          </Button>
          <Button
            onClick={() => runMutation.mutate()}
            disabled={settingsLocked || runMutation.isPending || saveMutation.isPending}
          >
            <Play className="h-4 w-4" />
            {overview.scheduler.running ? "Backup running" : runMutation.isPending ? "Starting..." : "Run backup now"}
          </Button>
        </div>
      </div>

      {overview.scheduler.running ? (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-900 dark:text-blue-200">
          Snapshot <span className="font-mono">{overview.scheduler.activeRunId}</span> is running.
          {overview.scheduler.activeRunStartedAt ? ` Started ${relativeTime(overview.scheduler.activeRunStartedAt)}.` : null}
        </div>
      ) : null}

      {overview.restore.status !== "idle" ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <RestoreStatusIcon className="h-4 w-4" />
              <span>Restore</span>
            </CardTitle>
            <CardDescription>Most API routes pause while restore is running.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge label={overview.restore.status} status={overview.restore.status} />
                  {overview.restore.sourceBundleName ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
                      {overview.restore.sourceBundleName}
                    </span>
                  ) : null}
                  {overview.restore.rollback.status !== "not_needed" ? (
                    <StatusBadge label={`rollback ${overview.restore.rollback.status}`} status={overview.restore.rollback.status} />
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {overview.restore.startedAt ? `Started ${formatDateTime(overview.restore.startedAt)}.` : null}
                  {overview.restore.finishedAt ? ` Finished ${formatDateTime(overview.restore.finishedAt)}.` : null}
                </div>
              </div>
              {restoreRunning ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                  Avoid board writes until restore completes.
                </div>
              ) : null}
            </div>

            {overview.restore.error ? (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200">
                {overview.restore.error}
              </div>
            ) : null}

            {overview.restore.notes ? (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                {overview.restore.notes}
              </div>
            ) : null}

            {overview.restore.rollback.status !== "not_needed" ? (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">Rollback checkpoint</span>
                  <StatusBadge label={overview.restore.rollback.status} status={overview.restore.rollback.status} />
                  {overview.restore.rollback.checkpointBundleName ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {overview.restore.rollback.checkpointBundleName}
                    </span>
                  ) : null}
                </div>
                {overview.restore.rollback.error ? (
                  <div className="mt-1 text-xs text-red-700 dark:text-red-300">{overview.restore.rollback.error}</div>
                ) : null}
              </div>
            ) : null}

            {overview.restore.restoredComponents.length > 0 ? (
              <DetailSection title={`Restored components (${overview.restore.restoredComponents.length})`}>
                <div className="grid gap-2">
                  {COMPONENT_ORDER.map((key) => {
                    const component = overview.restore.restoredComponents.find((item) => item.key === key);
                    if (!component) return null;
                    return (
                      <div key={component.key} className="rounded-md border border-border px-3 py-2 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{component.label}</span>
                          <StatusBadge label={component.status} status={component.status} />
                        </div>
                        {component.notes ? <div className="mt-1 text-xs text-muted-foreground">{component.notes}</div> : null}
                        <div className="mt-1 text-xs text-muted-foreground">
                          {component.absolutePath ? <div className="font-mono break-all">{component.absolutePath}</div> : null}
                          {component.sizeBytes != null ? <div>{formatBytes(component.sizeBytes)}</div> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </DetailSection>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metricLabel(String(overview.stats.totalSnapshots), "Stored snapshots", FolderArchive)}
        {metricLabel(latestSnapshotLabel, "Latest successful backup", CheckCircle2)}
        {metricLabel(String(overview.stats.failedSnapshots), "Failed snapshots", ShieldAlert)}
        {metricLabel(formatBytes(overview.stats.storedBytes), "Retained size", HardDriveDownload)}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(340px,400px)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Backup policy</CardTitle>
              <CardDescription>
                Keep the scheduler and included data clear. Advanced protection settings stay collapsed until you need them.
              </CardDescription>
              <CardAction>
                <Button
                  variant="secondary"
                  onClick={() => saveMutation.mutate()}
                  disabled={!dirty || saveMutation.isPending || settingsLocked}
                >
                  {saveMutation.isPending ? "Saving..." : "Save settings"}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="flex items-start gap-3 rounded-lg border border-border px-3 py-3">
                <Checkbox
                  checked={settingsDraft.enabled}
                  onCheckedChange={(checked) => setSettingsDraft((current) => ({
                    ...current,
                    enabled: checked === true,
                  }))}
                  disabled={settingsLocked}
                />
                <span className="grid gap-1">
                  <span className="text-sm font-medium">Automatic backups</span>
                  <span className="text-xs text-muted-foreground">
                    {overview.scheduler.nextScheduledAt
                      ? `Next scheduler run: ${formatDateTime(overview.scheduler.nextScheduledAt)}`
                      : "Scheduler disabled."}
                  </span>
                </span>
              </label>

              <div className="grid gap-3 md:grid-cols-2">
                <SettingsField label="Interval (minutes)" hint="How often the scheduler creates a snapshot.">
                  <input
                    className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none"
                    type="number"
                    min={1}
                    value={settingsDraft.intervalMinutes}
                    disabled={settingsLocked}
                    onChange={(event) => setSettingsDraft((current) => ({
                      ...current,
                      intervalMinutes: Math.max(1, Number(event.target.value || 1)),
                    }))}
                  />
                </SettingsField>
                <SettingsField label="Retention (days)" hint="Older snapshots are pruned after successful runs.">
                  <input
                    className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none"
                    type="number"
                    min={1}
                    value={settingsDraft.retentionDays}
                    disabled={settingsLocked}
                    onChange={(event) => setSettingsDraft((current) => ({
                      ...current,
                      retentionDays: Math.max(1, Number(event.target.value || 1)),
                    }))}
                  />
                </SettingsField>
              </div>

              <SettingsField
                label="Backup directory"
                hint="Each snapshot gets its own bundle directory with a manifest and copied components."
              >
                <input
                  className="h-10 rounded-md border border-border bg-background px-3 text-sm font-mono outline-none"
                  type="text"
                  value={settingsDraft.directory}
                  disabled={settingsLocked}
                  onChange={(event) => setSettingsDraft((current) => ({
                    ...current,
                    directory: event.target.value,
                  }))}
                />
              </SettingsField>

              <div className="space-y-3 rounded-lg border border-border px-3 py-3">
                <div>
                  <div className="text-sm font-medium">Included data</div>
                  <div className="text-xs text-muted-foreground">
                    Database is always included. Everything else is optional and follows the policy below.
                  </div>
                </div>

                <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  Optional right now: {enabledOptionalComponents.length > 0 ? enabledOptionalComponents.join(", ") : "nothing beyond the database"}.
                </div>

                <div className="grid gap-2">
                  {OPTIONAL_COMPONENT_KEYS.map((key) => {
                    const support = supportByKey.get(key);
                    const checked = settingsDraft.components[key];
                    return (
                      <label key={key} className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                        <Checkbox
                          checked={checked}
                          disabled={settingsLocked || support?.supported === false}
                          onCheckedChange={(value) => setSettingsDraft((current) => ({
                            ...current,
                            components: {
                              ...current.components,
                              [key]: value === true,
                            },
                          }))}
                        />
                        <span className="grid gap-1">
                          <span className="flex items-center gap-2 text-sm font-medium">
                            {support?.label ?? key}
                            {support?.recommended ? (
                              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                                Recommended
                              </span>
                            ) : null}
                          </span>
                          {support?.reason ? <span className="text-xs text-muted-foreground">{support.reason}</span> : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                Imported snapshots age from their import time on this instance, so an old archive is not pruned immediately after transfer.
              </div>

              <DetailSection
                title="Advanced protection"
                description="Signing and offsite replication are usually configured once, then left alone."
              >
                <div className="space-y-4">
                  <div className="space-y-3 rounded-lg border border-border px-3 py-3">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <KeyRound className="h-4 w-4" />
                        <span>Signature policy</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Signed manifests protect against backup tampering. The signing secret is configured outside the UI.
                      </div>
                    </div>

                    <label className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                      <Checkbox
                        checked={settingsDraft.requireSignedBackups}
                        disabled={settingsLocked || !overview.security.signingConfigured}
                        onCheckedChange={(checked) => setSettingsDraft((current) => ({
                          ...current,
                          requireSignedBackups: checked === true,
                        }))}
                      />
                      <span className="grid gap-1">
                        <span className="text-sm font-medium">Require verified signatures for restore/import</span>
                        <span className="text-xs text-muted-foreground">
                          {overview.security.signingConfigured
                            ? `Signing is configured${overview.security.signingKeyId ? ` (key ${overview.security.signingKeyId})` : ""}.`
                            : "Signing secret is not configured on this instance. Set PAPERCLIP_BACKUP_SIGNING_SECRET first."}
                        </span>
                      </span>
                    </label>
                  </div>

                  <div className="space-y-3 rounded-lg border border-border px-3 py-3">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <CloudUpload className="h-4 w-4" />
                        <span>Offsite replication</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Push each completed snapshot to S3-compatible object storage so backup survival is not tied to one host.
                      </div>
                    </div>

                    <SettingsField label="Remote provider" hint="Use `none` to keep only local bundles.">
                      <select
                        className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none"
                        value={settingsDraft.remote.provider}
                        disabled={settingsLocked}
                        onChange={(event) => setSettingsDraft((current) => ({
                          ...current,
                          remote: {
                            ...current.remote,
                            provider: event.target.value === "s3" ? "s3" : "none",
                          },
                        }))}
                      >
                        <option value="none">none</option>
                        <option value="s3">s3</option>
                      </select>
                    </SettingsField>

                    {settingsDraft.remote.provider === "s3" ? (
                      <div className="grid gap-3">
                        <div className="grid gap-3 md:grid-cols-2">
                          <SettingsField label="Bucket">
                            <input
                              className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none"
                              type="text"
                              value={settingsDraft.remote.s3.bucket}
                              disabled={settingsLocked}
                              onChange={(event) => setSettingsDraft((current) => ({
                                ...current,
                                remote: {
                                  ...current.remote,
                                  s3: {
                                    ...current.remote.s3,
                                    bucket: event.target.value,
                                  },
                                },
                              }))}
                            />
                          </SettingsField>
                          <SettingsField label="Region">
                            <input
                              className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none"
                              type="text"
                              value={settingsDraft.remote.s3.region}
                              disabled={settingsLocked}
                              onChange={(event) => setSettingsDraft((current) => ({
                                ...current,
                                remote: {
                                  ...current.remote,
                                  s3: {
                                    ...current.remote.s3,
                                    region: event.target.value,
                                  },
                                },
                              }))}
                            />
                          </SettingsField>
                        </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <SettingsField label="Prefix" hint="Optional folder/prefix inside the bucket.">
                        <input
                          className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none"
                          type="text"
                              value={settingsDraft.remote.s3.prefix}
                              disabled={settingsLocked}
                              onChange={(event) => setSettingsDraft((current) => ({
                                ...current,
                                remote: {
                                  ...current.remote,
                                  s3: {
                                    ...current.remote.s3,
                                    prefix: event.target.value,
                                  },
                                },
                              }))}
                            />
                          </SettingsField>
                          <SettingsField label="Endpoint" hint="Leave empty for AWS S3.">
                            <input
                              className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none"
                              type="text"
                              value={settingsDraft.remote.s3.endpoint ?? ""}
                              disabled={settingsLocked}
                              onChange={(event) => setSettingsDraft((current) => ({
                                ...current,
                                remote: {
                                  ...current.remote,
                                  s3: {
                                    ...current.remote.s3,
                                    endpoint: event.target.value || null,
                                  },
                                },
                              }))}
                          />
                        </SettingsField>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <SettingsField label="Access key id" hint="Leave blank to use the ambient AWS credential chain.">
                          <input
                            className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none"
                            type="text"
                            value={settingsDraft.remote.s3.accessKeyId ?? ""}
                            disabled={settingsLocked}
                            onChange={(event) => setSettingsDraft((current) => ({
                              ...current,
                              remote: {
                                ...current.remote,
                                s3: {
                                  ...current.remote.s3,
                                  accessKeyId: event.target.value || null,
                                },
                              },
                            }))}
                          />
                        </SettingsField>
                        <SettingsField label="Secret access key" hint="Stored only in this instance backup policy.">
                          <input
                            className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none"
                            type="password"
                            value={settingsDraft.remote.s3.secretAccessKey ?? ""}
                            disabled={settingsLocked}
                            onChange={(event) => setSettingsDraft((current) => ({
                              ...current,
                              remote: {
                                ...current.remote,
                                s3: {
                                  ...current.remote.s3,
                                  secretAccessKey: event.target.value || null,
                                },
                              },
                            }))}
                          />
                        </SettingsField>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <SettingsField label="Server-side encryption">
                          <select
                              className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none"
                              value={settingsDraft.remote.s3.serverSideEncryption}
                              disabled={settingsLocked}
                              onChange={(event) => setSettingsDraft((current) => ({
                                ...current,
                                remote: {
                                  ...current.remote,
                                  s3: {
                                    ...current.remote.s3,
                                    serverSideEncryption:
                                      event.target.value === "AES256" || event.target.value === "aws:kms"
                                        ? event.target.value
                                        : "none",
                                  },
                                },
                              }))}
                            >
                              <option value="none">none</option>
                              <option value="AES256">AES256</option>
                              <option value="aws:kms">aws:kms</option>
                            </select>
                          </SettingsField>
                          <SettingsField label="KMS key id" hint="Required only for aws:kms mode.">
                            <input
                              className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none"
                              type="text"
                              value={settingsDraft.remote.s3.kmsKeyId ?? ""}
                              disabled={settingsLocked || settingsDraft.remote.s3.serverSideEncryption !== "aws:kms"}
                              onChange={(event) => setSettingsDraft((current) => ({
                                ...current,
                                remote: {
                                  ...current.remote,
                                  s3: {
                                    ...current.remote.s3,
                                    kmsKeyId: event.target.value || null,
                                  },
                                },
                              }))}
                            />
                          </SettingsField>
                        </div>
                        <div className="grid gap-2">
                          <label className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                            <Checkbox
                              checked={settingsDraft.remote.s3.forcePathStyle}
                              disabled={settingsLocked}
                              onCheckedChange={(checked) => setSettingsDraft((current) => ({
                                ...current,
                                remote: {
                                  ...current.remote,
                                  s3: {
                                    ...current.remote.s3,
                                    forcePathStyle: checked === true,
                                  },
                                },
                              }))}
                            />
                            <span className="grid gap-1">
                              <span className="text-sm font-medium">Force path-style S3 requests</span>
                              <span className="text-xs text-muted-foreground">Useful for MinIO and some S3-compatible endpoints.</span>
                            </span>
                          </label>
                          <label className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                            <Checkbox
                              checked={settingsDraft.remote.s3.deleteFromRemoteOnDelete}
                              disabled={settingsLocked}
                              onCheckedChange={(checked) => setSettingsDraft((current) => ({
                                ...current,
                                remote: {
                                  ...current.remote,
                                  s3: {
                                    ...current.remote.s3,
                                    deleteFromRemoteOnDelete: checked === true,
                                  },
                                },
                              }))}
                            />
                            <span className="grid gap-1">
                              <span className="text-sm font-medium">Delete remote copy when local snapshot is deleted</span>
                              <span className="text-xs text-muted-foreground">Leave off if remote retention is managed outside Paperclip.</span>
                            </span>
                          </label>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </DetailSection>

              {anyMutationError ? (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200">
                  {anyMutationError.message}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Safety</CardTitle>
              <CardDescription>
                The page now keeps only operational status visible by default. Audit trail and full scope stay one click away.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                  <span>Manifest signing</span>
                  <StatusBadge
                    label={overview.security.signingConfigured ? "configured" : "not configured"}
                    status={overview.security.signingConfigured ? "verified" : "missing"}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                  <span>Require signed backups</span>
                  <StatusBadge
                    label={overview.security.signingRequired ? "required" : "optional"}
                    status={overview.security.signingRequired ? "verified" : "skipped"}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                  <span>Offsite replication</span>
                  <StatusBadge
                    label={
                      overview.security.remoteReplicationConfigured
                        ? overview.security.remoteReplicationHealthy === true ? "healthy" : "needs attention"
                        : "not configured"
                    }
                    status={
                      overview.security.remoteReplicationConfigured
                        ? overview.security.remoteReplicationHealthy === true ? "verified" : "error"
                        : "skipped"
                    }
                  />
                </div>
                <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  Consistency mode: writes are paused during backup capture and restore.
                </div>
                <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  Cross-machine restore: `Download` on the source instance, `Import backup` on the destination instance, then `Restore`.
                </div>
                {sensitiveComponentsEnabled ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                    `.env` or secrets key snapshots are enabled. Downloaded bundles should be handled like production credentials.
                  </div>
                ) : null}
              </div>

              <DetailSection title={`Recent audit events (${recentAuditEvents.length})`}>
                {recentAuditEvents.length === 0 ? (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    No backup audit events recorded yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {recentAuditEvents.map((event: BackupAuditEvent) => (
                      <div key={event.id} className="rounded-md border border-border px-3 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{event.action}</span>
                          <StatusBadge
                            label={event.result}
                            status={
                              event.result === "succeeded"
                                ? "verified"
                                : event.result === "failed"
                                ? "failed"
                                : event.result === "blocked"
                                ? "missing"
                                : "skipped"
                            }
                          />
                          <span className="text-muted-foreground">{formatDateTime(event.createdAt)}</span>
                        </div>
                        <div className="mt-1 text-muted-foreground">
                          {event.bundleName ? <span className="font-mono">{event.bundleName}</span> : "instance-level event"}
                          {event.actorId ? ` by ${event.actorId}` : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </DetailSection>

              <DetailSection title="Covered components" description="What this instance can capture when the policy enables it.">
                <div className="space-y-2 text-sm text-muted-foreground">
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-foreground">Database</span>
                      <StatusBadge label="Always included" status="verified" />
                    </div>
                  </div>
                  {COMPONENT_ORDER.map((key) => {
                    const support = supportByKey.get(key);
                    if (!support || key === "database") return null;
                    return (
                      <div key={key} className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
                        <div>
                          <div className="font-medium text-foreground">{support.label}</div>
                          {support.reason ? <div className="text-xs text-muted-foreground">{support.reason}</div> : null}
                        </div>
                        <StatusBadge label={support.supported ? "Supported" : "External"} status={support.supported ? "verified" : "missing"} />
                      </div>
                    );
                  })}
                </div>
              </DetailSection>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {previewBackupId ? (
            <Card>
              <CardHeader>
                <CardTitle>Restore preview</CardTitle>
                <CardDescription>
                  Dry-run validation before you apply a snapshot.
                </CardDescription>
                <CardAction>
                  <Button variant="outline" size="sm" onClick={() => setPreviewBackupId(null)}>
                    Close preview
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                {previewQuery.isLoading ? (
                  <div className="text-sm text-muted-foreground">Loading preview...</div>
                ) : previewQuery.error ? (
                  <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200">
                    {previewQuery.error.message}
                  </div>
                ) : previewQuery.data ? (
                  <RestorePreviewSummary preview={previewQuery.data} />
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Snapshot history</CardTitle>
              <CardDescription>
                Recent snapshots stay compact. Open details only when you need paths, components, or remote-copy metadata.
              </CardDescription>
              {archivedCount > 0 ? (
                <CardAction>
                  <Button variant="outline" size="sm" onClick={() => setShowArchived((current) => !current)}>
                    {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
                  </Button>
                </CardAction>
              ) : null}
            </CardHeader>
            <CardContent>
              {overview.backups.length === 0 ? (
                <EmptyState
                  icon={Archive}
                  message="No backups yet. Run the first snapshot to start tracking history."
                  action="Run backup"
                  onAction={() => runMutation.mutate()}
                />
              ) : visibleBackups.length === 0 ? (
                <EmptyState
                  icon={Archive}
                  message="All stored snapshots are archived. Show archived snapshots to inspect or restore them."
                  action={`Show archived (${archivedCount})`}
                  onAction={() => setShowArchived(true)}
                />
              ) : (
                <div className="space-y-4">
                  {visibleBackups.map((backup) => {
                    const restorePendingForBackup =
                      restoreMutation.isPending && restoreMutation.variables?.backupId === backup.id;
                    const archivePendingForBackup =
                      archiveMutation.isPending && archiveMutation.variables?.backupId === backup.id;
                    const unarchivePendingForBackup =
                      unarchiveMutation.isPending && unarchiveMutation.variables?.backupId === backup.id;
                    const deletePendingForBackup =
                      deleteMutation.isPending && deleteMutation.variables?.backupId === backup.id;
                    const previewLoadingForBackup = previewBackupId === backup.id && previewQuery.isLoading;
                    const remoteUploadHealthy = backup.remoteCopies.some((copy) => copy.status === "uploaded");
                    const remoteUploadFailed = backup.remoteCopies.some((copy) => copy.status === "failed");

                    return (
                      <div key={backup.id} className="rounded-lg border border-border px-4 py-4">
                        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                          <div className="space-y-2">
                            <div className="text-sm font-semibold">{formatDateTime(backup.startedAt)}</div>
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusBadge label={backup.status} status={backup.status} />
                              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                {backup.triggerSource}
                              </span>
                              {backup.origin === "imported" ? <StatusBadge label="imported" status="running" /> : null}
                              {backup.archivedAt ? <StatusBadge label="archived" status="missing" /> : null}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {backup.status === "running"
                                ? `Running for ${durationText(backup)}`
                                : `Finished ${backup.finishedAt ? relativeTime(backup.finishedAt) : relativeTime(backup.startedAt)} in ${durationText(backup)}`}
                              {backup.origin === "imported" && backup.importedAt
                                ? ` Imported ${formatDateTime(backup.importedAt)}${backup.importSourceFilename ? ` from ${backup.importSourceFilename}` : ""}.`
                                : ""}
                              {backup.archivedAt ? ` Archived ${formatDateTime(backup.archivedAt)}.` : ""}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <StatusBadge label={backup.integrity ? "integrity recorded" : "no integrity hash"} status={backup.integrity ? "verified" : "missing"} />
                              <StatusBadge label={backup.signature ? "signed manifest" : "unsigned manifest"} status={backup.signature ? "verified" : "missing"} />
                              {remoteUploadHealthy ? <StatusBadge label="offsite uploaded" status="verified" /> : null}
                              {remoteUploadFailed ? <StatusBadge label="offsite failed" status="failed" /> : null}
                              {backup.containsSensitiveData ? <StatusBadge label="contains secrets" status="failed" /> : null}
                            </div>
                          </div>

                          <div className="grid gap-2 xl:min-w-[320px]">
                            <div className="grid grid-cols-3 gap-2 text-sm">
                              <div className="rounded-md bg-muted/40 px-3 py-2">
                                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Size</div>
                                <div className="font-medium">{formatBytes(backup.totalSizeBytes)}</div>
                              </div>
                              <div className="rounded-md bg-muted/40 px-3 py-2">
                                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Duration</div>
                                <div className="font-medium">{durationText(backup)}</div>
                              </div>
                              <div className="rounded-md bg-muted/40 px-3 py-2">
                                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Pruned</div>
                                <div className="font-medium">{backup.prunedCount}</div>
                              </div>
                            </div>

                            <div className="flex flex-wrap justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handlePreview(backup.id)}
                                disabled={backup.status === "running" || archivePendingForBackup || unarchivePendingForBackup || deletePendingForBackup}
                              >
                                <Eye className="h-4 w-4" />
                                {previewLoadingForBackup ? "Loading..." : previewBackupId === backup.id ? "Hide preview" : "Preview"}
                              </Button>
                              {backup.status !== "running" ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleDownload(backup.id)}
                                  disabled={restoreRunning}
                                >
                                  <Download className="h-4 w-4" />
                                  Download
                                </Button>
                              ) : null}
                              {backup.status !== "running" && !backup.archivedAt ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleArchive(backup)}
                                  disabled={settingsLocked || archivePendingForBackup || unarchivePendingForBackup || deletePendingForBackup}
                                >
                                  <ArchiveX className="h-4 w-4" />
                                  {archivePendingForBackup ? "Archiving..." : "Archive"}
                                </Button>
                              ) : null}
                              {backup.status !== "running" && backup.archivedAt ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleUnarchive(backup)}
                                  disabled={settingsLocked || archivePendingForBackup || unarchivePendingForBackup || deletePendingForBackup}
                                >
                                  <Undo2 className="h-4 w-4" />
                                  {unarchivePendingForBackup ? "Restoring..." : "Unarchive"}
                                </Button>
                              ) : null}
                              {backup.status !== "running" ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleDelete(backup)}
                                  disabled={settingsLocked || archivePendingForBackup || unarchivePendingForBackup || deletePendingForBackup}
                                >
                                  <Trash2 className="h-4 w-4" />
                                  {deletePendingForBackup ? "Deleting..." : "Delete"}
                                </Button>
                              ) : null}
                              {backup.status === "succeeded" ? (
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => handleRestore(backup)}
                                  disabled={settingsLocked || restorePendingForBackup}
                                >
                                  <RotateCcw className="h-4 w-4" />
                                  {restorePendingForBackup ? "Starting..." : "Restore"}
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        </div>

                        {backup.error ? (
                          <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200">
                            {backup.error}
                          </div>
                        ) : null}

                        <div className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                          Restore replaces the current instance state. Download the bundle first if you want an offline copy before applying it.
                        </div>

                        <DetailSection title="Bundle details">
                          <div className="space-y-3">
                            <div className="rounded-md bg-muted/40 px-3 py-2 font-mono text-xs break-all text-muted-foreground">
                              {backup.bundlePath}
                            </div>

                            {backup.remoteCopies.length > 0 ? (
                              <div className="grid gap-2">
                                {backup.remoteCopies.map((copy, index) => (
                                  <div key={`${backup.id}-remote-${index}`} className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-medium text-foreground">{copy.provider}</span>
                                      <StatusBadge label={copy.status} status={copy.status === "uploaded" ? "verified" : "failed"} />
                                    </div>
                                    <div className="mt-1 font-mono break-all">{copy.bucket}/{copy.key}</div>
                                    {copy.notes ? <div className="mt-1 text-red-700 dark:text-red-300">{copy.notes}</div> : null}
                                  </div>
                                ))}
                              </div>
                            ) : null}

                            <div className="grid gap-2">
                              {COMPONENT_ORDER.map((key) => {
                                const component = backup.components.find((item) => item.key === key);
                                if (!component) return null;
                                return (
                                  <div key={component.key} className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 lg:flex-row lg:items-center lg:justify-between">
                                    <div>
                                      <div className="flex items-center gap-2 text-sm font-medium">
                                        {component.label}
                                        <StatusBadge label={component.status} status={component.status} />
                                      </div>
                                      {component.notes ? <div className="mt-1 text-xs text-muted-foreground">{component.notes}</div> : null}
                                    </div>
                                    <div className="text-xs text-muted-foreground lg:text-right">
                                      {component.relativePath ? <div className="font-mono">{component.relativePath}</div> : null}
                                      {component.sizeBytes != null ? <div>{formatBytes(component.sizeBytes)}</div> : null}
                                      {component.itemCount != null ? <div>{component.itemCount} item(s)</div> : null}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </DetailSection>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
