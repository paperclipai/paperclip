import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DELIVERY_STAGES,
  type DeliveryEventState,
  type DeliveryStageSnapshotV1,
  type ExternalOperationV1,
} from "@paperclipai/shared";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { ApiError } from "../api/client";
import { deliveryApi } from "../api/delivery";
import { useToastActions } from "../context/ToastContext";
import {
  deliveryAuthorityPresentation,
  deliverySnapshotFreshness,
  deliveryStageLabel,
  deliveryStateLabel,
} from "../lib/delivery-truth";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

type IssueDeliveryTruthPanelProps = {
  issueId: string;
  canPublishControlUpdate: boolean;
};

const AUTHORITY_TONE_CLASSES = {
  verified: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  asserted: "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  claimed: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  unverified: "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  empty: "border-border bg-muted/30 text-muted-foreground",
} as const;

const STATE_TONE_CLASSES: Record<DeliveryEventState, string> = {
  unknown: "text-muted-foreground",
  pending: "text-amber-700 dark:text-amber-300",
  succeeded: "text-emerald-700 dark:text-emerald-300",
  failed: "text-red-700 dark:text-red-300",
  rolled_back: "text-orange-700 dark:text-orange-300",
  accepted: "text-emerald-700 dark:text-emerald-300",
  rejected: "text-red-700 dark:text-red-300",
  skipped: "text-muted-foreground",
};

function stateIcon(state: DeliveryEventState) {
  if (state === "succeeded" || state === "accepted") return CheckCircle2;
  if (state === "failed" || state === "rejected") return XCircle;
  if (state === "pending") return Loader2;
  return CircleDashed;
}

function shortCandidate(value: string | null) {
  if (!value) return "Unknown";
  return value.length > 12 ? value.slice(0, 12) : value;
}

function formatTimestamp(value: Date | null) {
  if (!value) return null;
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) return null;
  return timestamp.toLocaleString();
}

function conflictCurrentRevision(error: ApiError) {
  if (!error.body || typeof error.body !== "object") return null;
  const details = (error.body as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const revision = (details as { currentRevision?: unknown }).currentRevision;
  return typeof revision === "string" ? revision : null;
}

function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

function DeliveryStageRow({ stage }: { stage: DeliveryStageSnapshotV1 }) {
  const authority = deliveryAuthorityPresentation(stage.authority);
  const StateIcon = stateIcon(stage.state);
  const observedAt = formatTimestamp(stage.observedAt);
  const providerUrl = safeExternalUrl(stage.providerUrl);
  return (
    <div className="grid min-w-0 grid-cols-[minmax(7.5rem,1fr)_minmax(6rem,0.75fr)] gap-x-3 gap-y-1 border-b border-border/50 px-3 py-2 last:border-b-0 sm:grid-cols-[minmax(8.5rem,1.1fr)_minmax(6rem,0.7fr)_minmax(9rem,1.2fr)]">
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-foreground">{deliveryStageLabel(stage.stage)}</div>
        {observedAt ? <div className="truncate text-[10px] text-muted-foreground">{observedAt}</div> : null}
      </div>
      <div className={cn("flex items-center gap-1.5 text-xs font-medium capitalize", STATE_TONE_CLASSES[stage.state])}>
        <StateIcon className={cn("h-3.5 w-3.5", stage.state === "pending" && "animate-spin")} aria-hidden="true" />
        <span>{deliveryStateLabel(stage.state)}</span>
        {stage.eventId && stage.stale ? (
          <span title="This evidence is stale" className="text-amber-600 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3" aria-label="Stale evidence" />
          </span>
        ) : null}
      </div>
      <div className="col-span-2 flex min-w-0 items-center justify-between gap-2 sm:col-span-1">
        <span
          className={cn(
            "inline-flex min-w-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
            AUTHORITY_TONE_CLASSES[authority.tone],
          )}
          title={authority.description}
        >
          <span className="truncate">{authority.label}</span>
        </span>
        {providerUrl ? (
          <a
            href={providerUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            title={`Open ${stage.provider ?? "provider"} evidence`}
          >
            {stage.provider ?? "Evidence"}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        ) : stage.provider ? (
          <span className="truncate text-[10px] text-muted-foreground">{stage.provider}</span>
        ) : null}
      </div>
    </div>
  );
}

const VERIFICATION_TONE_CLASSES: Record<ExternalOperationV1["verificationStatus"], string> = {
  verified: "text-emerald-700 dark:text-emerald-300",
  mismatch: "text-red-700 dark:text-red-300",
  error: "text-red-700 dark:text-red-300",
  unverified: "text-muted-foreground",
};

function ExternalOperationRow({ operation }: { operation: ExternalOperationV1 }) {
  const operationUrl = safeExternalUrl(operation.url);
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-t border-border/50 px-3 py-2 first:border-t-0">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium text-foreground">{operation.provider}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{deliveryStageLabel(operation.stage)}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
          <span className="truncate">{operation.externalId}</span>
          {operation.candidateSha ? <code>{shortCandidate(operation.candidateSha)}</code> : null}
          {operation.environment ? <span>{operation.environment}</span> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={cn("text-[10px] font-medium capitalize", VERIFICATION_TONE_CLASSES[operation.verificationStatus])}>
          {operation.verificationStatus}
        </span>
        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium capitalize text-muted-foreground">
          {operation.state}
        </span>
        {operationUrl ? (
          <a href={operationUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
            <ExternalLink className="h-3.5 w-3.5" aria-label="Open external operation" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function IssueDeliveryTruthPanel({
  issueId,
  canPublishControlUpdate,
}: IssueDeliveryTruthPanelProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [advisoryNote, setAdvisoryNote] = useState("");
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const snapshotKey = useMemo(() => queryKeys.issues.deliverySnapshot(issueId), [issueId]);
  const operationsKey = useMemo(() => queryKeys.issues.externalOperations(issueId), [issueId]);

  const snapshotQuery = useQuery({
    queryKey: snapshotKey,
    queryFn: () => deliveryApi.getSnapshot(issueId),
    staleTime: 0,
    refetchInterval: 30_000,
    retry: false,
  });
  const operationsQuery = useQuery({
    queryKey: operationsKey,
    queryFn: () => deliveryApi.listExternalOperations(issueId),
    staleTime: 0,
    refetchInterval: 30_000,
    retry: false,
  });

  const publishUpdate = useMutation({
    mutationFn: () => {
      if (!snapshotQuery.data) throw new Error("Delivery snapshot is not loaded.");
      return deliveryApi.publishControlUpdate(issueId, {
        snapshotRevision: snapshotQuery.data.revision,
        note: advisoryNote.trim() || null,
      });
    },
    onMutate: () => setConflictMessage(null),
    onSuccess: (result) => {
      queryClient.setQueryData(snapshotKey, result.snapshot);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
      setAdvisoryNote("");
      pushToast({
        title: "Delivery update published",
        body: "The server rendered the comment from the current evidence snapshot.",
        tone: "success",
      });
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        const revision = conflictCurrentRevision(error);
        setConflictMessage(
          revision
            ? `Evidence changed before publish. Refreshed to revision ${revision.slice(0, 12)}.`
            : "Evidence changed before publish. The panel has been refreshed; review it and publish again.",
        );
        await Promise.all([snapshotQuery.refetch(), operationsQuery.refetch()]);
        pushToast({
          title: "Delivery snapshot changed",
          body: "Review the refreshed evidence before publishing again.",
          tone: "warn",
        });
        return;
      }
      pushToast({
        title: "Delivery update not published",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const snapshot = snapshotQuery.data;
  const operations = operationsQuery.data ?? [];
  const freshness = snapshot ? deliverySnapshotFreshness(snapshot) : null;
  const isRefreshing = snapshotQuery.isFetching || operationsQuery.isFetching;

  const refresh = async () => {
    setConflictMessage(null);
    await Promise.all([snapshotQuery.refetch(), operationsQuery.refetch()]);
  };

  if (snapshotQuery.isLoading) {
    return (
      <section className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/15 px-3 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading delivery truth…
      </section>
    );
  }

  if (snapshotQuery.error || !snapshot) {
    return (
      <section className="flex items-start justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-3">
        <div className="flex items-start gap-2 text-xs text-red-700 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{snapshotQuery.error instanceof Error ? snapshotQuery.error.message : "Delivery evidence is unavailable."}</span>
        </div>
        <Button size="xs" variant="outline" onClick={() => void refresh()}>Retry</Button>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border/70 bg-background/50" aria-labelledby={`delivery-truth-${issueId}`}>
      <div className="flex flex-col gap-3 border-b border-border/60 px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
            <h2 id={`delivery-truth-${issueId}`} className="text-sm font-semibold text-foreground">Delivery truth</h2>
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
              {snapshot.watermark.eventCount} {snapshot.watermark.eventCount === 1 ? "event" : "events"}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>Candidate <code className="text-foreground">{shortCandidate(snapshot.candidateSha)}</code></span>
            <span>Environment <strong className="font-medium text-foreground">{snapshot.environment ?? "Unknown"}</strong></span>
            <span title={snapshot.revision}>Revision <code>{snapshot.revision.slice(0, 12)}</code></span>
          </div>
        </div>
        <Button size="xs" variant="ghost" onClick={() => void refresh()} disabled={isRefreshing}>
          {isRefreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Refresh
        </Button>
      </div>

      {conflictMessage ? (
        <div className="flex items-start gap-2 border-b border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {conflictMessage}
        </div>
      ) : null}
      {freshness?.hasStaleEvidence ? (
        <div className="flex items-start gap-2 border-b border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {freshness.staleStageCount} {freshness.staleStageCount === 1 ? "stage has" : "stages have"} stale evidence. Refresh or re-verify the provider operation before relying on it.
        </div>
      ) : null}

      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.44fr)]">
        <div className="min-w-0 lg:border-r lg:border-border/60">
          <div className="grid grid-cols-[minmax(7.5rem,1fr)_minmax(6rem,0.75fr)] gap-x-3 border-b border-border/50 bg-muted/20 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid-cols-[minmax(8.5rem,1.1fr)_minmax(6rem,0.7fr)_minmax(9rem,1.2fr)]">
            <span>Stage</span><span>State</span><span className="hidden sm:block">Authority</span>
          </div>
          {DELIVERY_STAGES.map((stage) => (
            <DeliveryStageRow key={stage} stage={snapshot.stages[stage]} />
          ))}
        </div>

        <div className="min-w-0 border-t border-border/60 lg:border-t-0">
          <div className="border-b border-border/50 bg-muted/20 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            External operations
          </div>
          {operationsQuery.error ? (
            <div className="px-3 py-3 text-xs text-red-700 dark:text-red-300">External operations could not be loaded.</div>
          ) : operations.length > 0 ? (
            operations.map((operation) => <ExternalOperationRow key={operation.id} operation={operation} />)
          ) : (
            <div className="px-3 py-3 text-xs leading-5 text-muted-foreground">No tracked provider operations. Stage claims remain explicitly unverified until a provider observation is recorded.</div>
          )}
        </div>
      </div>

      <div className="border-t border-border/60 bg-muted/10 px-3 py-3">
        <div className="flex flex-wrap gap-1.5" aria-label="Delivery evidence authority legend">
          {(["provider_verified", "paperclip_verified", "user_asserted", "agent_claim", "legacy_unverified"] as const).map((authorityValue) => {
            const authority = deliveryAuthorityPresentation(authorityValue);
            return (
              <span key={authorityValue} className={cn("rounded-full border px-2 py-0.5 text-[10px]", AUTHORITY_TONE_CLASSES[authority.tone])} title={authority.description}>
                {authority.label}
              </span>
            );
          })}
        </div>

        {canPublishControlUpdate ? (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 text-[11px] font-medium text-muted-foreground">
              Advisory note <span className="font-normal">(optional; never treated as evidence)</span>
              <Textarea
                value={advisoryNote}
                onChange={(event) => setAdvisoryNote(event.target.value)}
                placeholder="Context for readers, separate from the server-rendered facts…"
                className="mt-1 min-h-16 resize-y bg-background text-xs"
                maxLength={4_000}
              />
            </label>
            <Button
              size="sm"
              onClick={() => publishUpdate.mutate()}
              disabled={publishUpdate.isPending || isRefreshing}
              title="Publish a server-rendered issue comment from this exact snapshot revision"
            >
              {publishUpdate.isPending ? <Loader2 className="animate-spin" /> : <Send />}
              Publish snapshot update
            </Button>
          </div>
        ) : (
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            Board editors and authorized factory participants can publish a server-rendered control update from this exact snapshot revision.
          </p>
        )}
      </div>
    </section>
  );
}
