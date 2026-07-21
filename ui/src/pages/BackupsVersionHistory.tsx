import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Cloud,
  Download,
  GitCommitHorizontal,
  History,
  Link2,
  Link2Off,
  Loader2,
  RefreshCcw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SecretBindingPicker, type SecretBindingValue } from "@/components/SecretBindingPicker";
import { stateRepoApi } from "@/api/stateRepo";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { timeAgo } from "@/lib/timeAgo";
import { ApiError } from "@/api/client";
import { cn } from "@/lib/utils";

type Tone = "ok" | "warn" | "danger" | "neutral";

const TONE_STYLES: Record<Tone, { badge: string; dot: string; icon: string }> = {
  ok: {
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
    icon: "text-emerald-600 dark:text-emerald-400",
  },
  warn: {
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
    icon: "text-amber-600 dark:text-amber-400",
  },
  danger: {
    badge: "border-destructive/30 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
    icon: "text-destructive",
  },
  neutral: {
    badge: "border-border bg-muted/40 text-muted-foreground",
    dot: "bg-muted-foreground/50",
    icon: "text-muted-foreground",
  },
};

function StatusPill({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE_STYLES[tone].badge,
      )}
    >
      <span className={cn("size-1.5 rounded-full", TONE_STYLES[tone].dot)} />
      {label}
    </span>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

export function BackupsVersionHistory() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [remoteUrl, setRemoteUrl] = useState("");
  const [tokenBinding, setTokenBinding] = useState<SecretBindingValue | null>(null);
  const [editingRemote, setEditingRemote] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Backups & version history" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const enabled = !!selectedCompanyId;

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });
  const logQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.stateRepo.log(selectedCompanyId) : ["state-repo", "log", "__none__"],
    queryFn: () => stateRepoApi.log(selectedCompanyId!),
    enabled,
  });
  const mirrorHealthQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.stateRepo.health(selectedCompanyId) : ["state-repo", "health", "__none__"],
    queryFn: () => stateRepoApi.health(selectedCompanyId!),
    enabled,
  });
  const remoteQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.stateRepo.remote(selectedCompanyId) : ["state-repo", "remote", "__none__"],
    queryFn: () => stateRepoApi.getRemote(selectedCompanyId!),
    enabled,
  });

  const remote = remoteQuery.data?.remote ?? null;
  const mirrorHealth = mirrorHealthQuery.data ?? null;
  const commits = logQuery.data?.commits ?? [];

  useEffect(() => {
    if (remote && !editingRemote) {
      setRemoteUrl(remote.remoteUrl);
      setTokenBinding(
        remote.secretId
          ? { secretId: remote.secretId, version: remote.secretVersion === null ? "latest" : (remote.secretVersion as never) }
          : null,
      );
    }
  }, [remote, editingRemote]);

  const invalidateMirror = async () => {
    if (!selectedCompanyId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.stateRepo.health(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.stateRepo.remote(selectedCompanyId) }),
    ]);
  };

  const saveRemoteMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      await stateRepoApi.setRemote(selectedCompanyId, {
        remoteUrl: remoteUrl.trim(),
        secretId: tokenBinding?.secretId ?? null,
        secretVersion:
          tokenBinding?.version === undefined || tokenBinding?.version === "latest"
            ? "latest"
            : String(tokenBinding.version),
      });
      return stateRepoApi.testMirror(selectedCompanyId);
    },
    onSuccess: async () => {
      setEditingRemote(false);
      await invalidateMirror();
      pushToast({ title: "Repository connected", body: "First mirror push succeeded.", tone: "success" });
    },
    onError: (error) => {
      void invalidateMirror();
      pushToast({ title: "Connection test failed", body: errorMessage(error, "Push failed."), tone: "error" });
    },
  });

  const testMutation = useMutation({
    mutationFn: () => stateRepoApi.testMirror(selectedCompanyId!),
    onSuccess: async () => {
      await invalidateMirror();
      pushToast({ title: "Push succeeded", body: "The mirror is up to date.", tone: "success" });
    },
    onError: (error) => {
      void invalidateMirror();
      pushToast({ title: "Push failed", body: errorMessage(error, "Push failed."), tone: "error" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => stateRepoApi.disconnectRemote(selectedCompanyId!),
    onSuccess: async () => {
      setEditingRemote(false);
      setRemoteUrl("");
      setTokenBinding(null);
      await invalidateMirror();
      pushToast({ title: "Repository disconnected", tone: "info" });
    },
    onError: (error) => pushToast({ title: "Failed to disconnect", body: errorMessage(error, ""), tone: "error" }),
  });

  const snapshot = healthQuery.data?.stateSnapshot;
  const dbBackup = healthQuery.data?.databaseBackup;

  const snapshotTone: Tone = !snapshot?.enabled
    ? "neutral"
    : snapshot.status === "ok"
      ? "ok"
      : "warn";
  const dbBackupTone: Tone = !dbBackup?.enabled ? "neutral" : dbBackup.status === "ok" ? "ok" : "warn";

  const mirrorTone: Tone = !mirrorHealth?.configured
    ? "neutral"
    : mirrorHealth.failure
      ? "danger"
      : mirrorHealth.healthy
        ? "ok"
        : "warn";

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Select a company to view backups and version history.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">Backups &amp; version history</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Durability and change history for this company's agent instructions, skills, and memory.
            Snapshots protect the whole instance; the state repository keeps an attributed, restorable
            history you can mirror to your own git host.
          </p>
        </div>
        <a
          href="https://docs.paperclip.ing/runbooks/restore"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <History className="size-3.5" />
          Restore runbook
        </a>
      </div>

      {/* Snapshot health */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Snapshot health
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <HealthCard
            icon={ShieldCheck}
            title="Instance-state snapshot"
            tone={snapshotTone}
            statusLabel={!snapshot?.enabled ? "Not configured" : snapshot.status === "ok" ? "Healthy" : "Attention"}
            loading={healthQuery.isLoading}
            detail={
              !snapshot?.enabled
                ? "Encrypted instance snapshots are not enabled on this instance."
                : (snapshot.latestSnapshot?.finishedAt as string | undefined)
                  ? `Last snapshot ${timeAgo(snapshot.latestSnapshot!.finishedAt as string)}`
                  : "Awaiting the first successful snapshot."
            }
            warnings={snapshot?.warnings ?? []}
          />
          <HealthCard
            icon={Cloud}
            title="Database backup"
            tone={dbBackupTone}
            statusLabel={!dbBackup?.enabled ? "Not configured" : dbBackup.status === "ok" ? "Healthy" : "Attention"}
            loading={healthQuery.isLoading}
            detail={
              !dbBackup?.enabled
                ? "Scheduled database backups are not enabled on this instance."
                : dbBackup.latestBackup
                  ? `Last backup ${timeAgo(dbBackup.latestBackup.mtime)} · ${(dbBackup.latestBackup.sizeBytes / 1e6).toFixed(1)} MB`
                  : "Awaiting the first successful backup."
            }
            warnings={dbBackup?.warnings ?? []}
          />
        </div>
      </section>

      {/* Version history */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Version history
          </h2>
          <a
            href={stateRepoApi.bundleHref(selectedCompanyId)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Download className="size-3.5" />
            Export bundle
          </a>
        </div>
        <Card className="overflow-hidden py-0">
          {logQuery.isLoading ? (
            <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading history…
            </div>
          ) : commits.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center">
              <GitCommitHorizontal className="size-6 text-muted-foreground/60" />
              <p className="text-sm font-medium">No history yet</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                The state repository records a commit whenever an agent's instructions, skills, or memory
                change. Edits will appear here with who changed what, and when.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {commits.map((commit) => (
                <li key={commit.hash} className="flex items-start gap-3 px-4 py-2.5 hover:bg-accent/40">
                  <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{commit.subject}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground/80">{commit.author}</span>
                      {" · "}
                      {commit.date ? timeAgo(commit.date) : "unknown time"}
                    </p>
                  </div>
                  <code className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">{commit.shortHash}</code>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* Connect your repo */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Connect your repository
        </h2>
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Link2 className="size-4" />
                  Mirror to your own git host
                </CardTitle>
                <CardDescription>
                  Paperclip pushes a one-way mirror of the state repository to your remote after every
                  change. Your remote is a copy — Paperclip never force-pushes and never rewrites your
                  history.
                </CardDescription>
              </div>
              {mirrorHealth?.configured && (
                <StatusPill
                  tone={mirrorTone}
                  label={mirrorHealth.failure ? "Push failing" : mirrorHealth.healthy ? "Connected" : "Not tested"}
                />
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {remote && !editingRemote ? (
              <>
                <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Remote URL</span>
                    <code className="truncate font-mono text-xs">{remote.remoteUrl}</code>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Push token</span>
                    <span className="text-xs">
                      {remote.secretId ? "Company secret bound" : "None (public/anonymous remote)"}
                    </span>
                  </div>
                </div>
                {mirrorHealth?.failure ? (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <div>
                      <p className="font-medium">Last push failed</p>
                      <p className="mt-0.5 break-words font-mono opacity-90">{mirrorHealth.failure}</p>
                    </div>
                  </div>
                ) : mirrorHealth?.success ? (
                  <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-4 shrink-0" />
                    <span>Last pushed {timeAgo(mirrorHealth.success.pushedAt)} — mirror is up to date.</span>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
                    {testMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />}
                    Test connection
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingRemote(true)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => disconnectMutation.mutate()}
                    disabled={disconnectMutation.isPending}
                  >
                    <Link2Off className="size-3.5" />
                    Disconnect
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="state-repo-remote-url">
                    Remote URL
                  </label>
                  <Input
                    id="state-repo-remote-url"
                    placeholder="https://github.com/your-org/paperclip-state.git"
                    value={remoteUrl}
                    onChange={(event) => setRemoteUrl(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Must be an <code className="font-mono">https://</code> URL. Create an empty repository first;
                    Paperclip pushes into it.
                  </p>
                </div>
                <SecretBindingPicker
                  label="Push token (company secret)"
                  value={tokenBinding}
                  onChange={setTokenBinding}
                  placeholder="Select a token secret"
                  emptyHint="Store a fine-grained token (contents: write, single repo) as a company secret, then bind it here."
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => saveRemoteMutation.mutate()}
                    disabled={!remoteUrl.trim() || saveRemoteMutation.isPending}
                  >
                    {saveRemoteMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
                    Connect &amp; test
                  </Button>
                  {remote && (
                    <Button size="sm" variant="ghost" onClick={() => setEditingRemote(false)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function HealthCard({
  icon: Icon,
  title,
  tone,
  statusLabel,
  detail,
  warnings,
  loading,
}: {
  icon: typeof ShieldCheck;
  title: string;
  tone: Tone;
  statusLabel: string;
  detail: string;
  warnings: Array<{ code: string; message: string }>;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Icon className={cn("size-4", TONE_STYLES[tone].icon)} />
            {title}
          </CardTitle>
          {loading ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : tone === "neutral" ? (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <CircleSlash className="size-3" />
              {statusLabel}
            </Badge>
          ) : (
            <StatusPill tone={tone} label={statusLabel} />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">{detail}</p>
        {warnings.length > 0 && (
          <ul className="space-y-1">
            {warnings.map((warning) => (
              <li key={warning.code} className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span>{warning.message}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
