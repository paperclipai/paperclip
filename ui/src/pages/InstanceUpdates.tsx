import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock3,
  ExternalLink,
  GitBranch,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { InstancePreUpdateBackupStatus, InstanceUpdateStatus } from "@paperclipai/shared";
import { instanceUpdatesApi } from "../api/instanceUpdates";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function statusTone(status: InstanceUpdateStatus) {
  if (!status.settings.updateChecksEnabled) return "muted";
  if (status.status === "offline") return "warn";
  if (status.updateAvailable) return status.backup.valid ? "success" : "warn";
  return "success";
}

function backupReasonLabel(backup: InstancePreUpdateBackupStatus) {
  switch (backup.reason) {
    case "none":
      return backup.valid ? "Backup gate ready" : "Backup gate not required";
    case "missing":
      return "No matching pre-update backup";
    case "failed":
      return "Last pre-update backup failed";
    case "stale":
      return "Pre-update backup expired";
    case "target_mismatch":
      return "Backup target version mismatch";
    case "external_storage_unverified":
      return "External storage acknowledgement required";
    default:
      return "Backup gate pending";
  }
}

function Pill({
  tone,
  children,
}: {
  tone: "success" | "warn" | "muted";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        tone === "success" && "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
        tone === "warn" && "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200",
        tone === "muted" && "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function PropertyRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-sm">{value}</span>
    </div>
  );
}

function SafeUpdateInstructions({ status }: { status: InstanceUpdateStatus }) {
  if (!status.updateAvailable) {
    return (
      <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        Safe update steps will appear when a stable update is available.
      </div>
    );
  }

  if (!status.backup.valid) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-100">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>Create a valid pre-update backup before following update steps.</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-100">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>Backup gate passed for v{status.latestVersion}. Manual updates are safe to start from the same checkout or deployment shell.</span>
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`# npm install
npm install -g paperclipai@${status.latestVersion}
paperclipai run

# source checkout
git fetch origin
git checkout v${status.latestVersion}
pnpm install
pnpm build
pnpm paperclipai run`}
      </pre>
      <p className="text-xs text-muted-foreground">
        Raw shell updates can bypass Paperclip's guard. Keep the backup manifest path handy before changing core files.
      </p>
    </div>
  );
}

export function InstanceUpdates() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [ackExternalStorage, setAckExternalStorage] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Updates" },
    ]);
  }, [setBreadcrumbs]);

  const statusQuery = useQuery({
    queryKey: queryKeys.instance.updateStatus,
    queryFn: () => instanceUpdatesApi.getStatus(),
    retry: false,
  });

  const checkMutation = useMutation({
    mutationFn: () => instanceUpdatesApi.checkNow(),
    onSuccess: async () => {
      pushToast({ title: "Update check complete", tone: "success" });
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.updateStatus });
    },
    onError: (error) => {
      pushToast({
        title: "Update check failed",
        body: error instanceof Error ? error.message : "Could not check for updates.",
        tone: "error",
      });
    },
  });

  const backupMutation = useMutation({
    mutationFn: (status: InstanceUpdateStatus) =>
      instanceUpdatesApi.createPreUpdateBackup({
        targetVersion: status.latestVersion,
        acknowledgeExternalStorage: ackExternalStorage,
      }),
    onSuccess: async (backup) => {
      pushToast({
        title: "Pre-update backup created",
        body: backup.backupDir,
        tone: backup.status === "succeeded" ? "success" : "warn",
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.updateStatus });
    },
    onError: (error) => {
      pushToast({
        title: "Backup failed",
        body: error instanceof Error ? error.message : "Could not create the pre-update backup.",
        tone: "error",
      });
    },
  });

  if (statusQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading update status...</div>;
  }

  if (statusQuery.error || !statusQuery.data) {
    return (
      <div className="text-sm text-destructive">
        {statusQuery.error instanceof Error ? statusQuery.error.message : "Failed to load update status."}
      </div>
    );
  }

  const status = statusQuery.data;
  const tone = statusTone(status);
  const latestLabel = status.latestVersion ? `v${status.latestVersion}` : "Unknown";
  const backupButtonDisabled =
    backupMutation.isPending ||
    !status.updateAvailable ||
    (status.backup.externalStorageRequiresAcknowledgement && !ackExternalStorage);

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Updates</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Check stable Paperclip releases and create a guarded pre-update backup before changing core files.
        </p>
      </div>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={tone}>
                {status.status === "update_available"
                  ? "Update available"
                  : status.status === "offline"
                    ? "Check offline"
                    : status.status === "disabled"
                      ? "Checks disabled"
                      : "Up to date"}
              </Pill>
              {status.releaseUrl ? (
                <a
                  href={status.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  Release notes
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </div>
            <div>
              <h2 className="text-sm font-semibold">
                Current v{status.currentVersion} · Latest {latestLabel}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Last checked {formatDateTime(status.checkedAt)}
                {status.error ? ` · ${status.error}` : ""}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={checkMutation.isPending}
            onClick={() => checkMutation.mutate()}
          >
            <RefreshCw className={cn("h-4 w-4", checkMutation.isPending && "animate-spin")} />
            {checkMutation.isPending ? "Checking..." : "Check now"}
          </Button>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.75fr)]">
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Archive className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold">Pre-update backup</h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  A valid backup must match the target version and be less than 24 hours old.
                </p>
              </div>
              <Pill tone={status.backup.valid ? "success" : "warn"}>
                {status.backup.valid ? "Ready" : "Required"}
              </Pill>
            </div>

            <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
              <div className="flex items-start gap-2 text-sm">
                {status.backup.valid ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                )}
                <div>
                  <div className="font-medium">{backupReasonLabel(status.backup)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Target {status.backup.targetVersion ? `v${status.backup.targetVersion}` : "none"}
                    {status.backup.expiresAt ? ` · expires ${formatDateTime(status.backup.expiresAt)}` : ""}
                  </div>
                </div>
              </div>
            </div>

            {status.backup.latest ? (
              <div className="space-y-1 rounded-md border border-border bg-background/60 px-3 py-2">
                <PropertyRow label="Latest backup" value={formatDateTime(status.backup.latest.createdAt)} />
                <PropertyRow label="Manifest" value={<span className="break-all font-mono text-xs">{status.backup.latest.manifestPath}</span>} />
                <PropertyRow label="Database" value={status.backup.latest.databaseBackupFile ? <span className="break-all font-mono text-xs">{status.backup.latest.databaseBackupFile}</span> : "Not captured"} />
              </div>
            ) : null}

            {status.backup.externalStorageRequiresAcknowledgement ? (
              <label className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-100">
                <Checkbox
                  checked={ackExternalStorage}
                  onCheckedChange={(checked) => setAckExternalStorage(checked === true)}
                  className="mt-0.5"
                />
                <span>
                  External object storage is not copied by Paperclip. I will verify the configured bucket/prefix separately before updating.
                </span>
              </label>
            ) : null}

            <Button
              disabled={backupButtonDisabled}
              onClick={() => backupMutation.mutate(status)}
            >
              <Archive className="h-4 w-4" />
              {backupMutation.isPending ? "Creating backup..." : "Create pre-update backup"}
            </Button>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-5">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Local install</h2>
            </div>
            <div className="space-y-1">
              <PropertyRow label="Branch" value={status.install.gitBranch ?? "Not a git checkout"} />
              <PropertyRow label="SHA" value={status.install.gitSha ?? "Unknown"} />
              <PropertyRow
                label="Core edits"
                value={
                  status.install.gitDirty === null
                    ? "Unknown"
                    : status.install.gitDirty
                      ? "Uncommitted changes detected"
                      : "Clean"
                }
              />
              <PropertyRow label="Repository" value={status.install.gitRepositoryRoot ? <span className="break-all font-mono text-xs">{status.install.gitRepositoryRoot}</span> : "Unknown"} />
            </div>
            {status.install.gitDirty ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Core edits can conflict with upstream updates. Commit or stash deliberate work before rebasing or checking out a release.</span>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Safe manual update</h2>
          </div>
          <SafeUpdateInstructions status={status} />
        </div>
      </section>
    </div>
  );
}
