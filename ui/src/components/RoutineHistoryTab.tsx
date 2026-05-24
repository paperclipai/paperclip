import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History as HistoryIcon, RotateCcw, Search } from "lucide-react";
import type {
  CompanySecret,
  EnvBinding,
  EnvSecretRefBinding,
  Routine,
  RoutineEnvConfig,
  RoutineRevision,
  RoutineRevisionSnapshotTriggerV1,
  RoutineVariable,
  SecretVersionSelector,
} from "@paperclipai/shared";
import type { TFunction } from "i18next";
import {
  routinesApi,
  type RestoreRoutineRevisionResponse,
} from "../api/routines";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { buildLineDiff, type DiffRow } from "../lib/line-diff";
import { relativeTime } from "../lib/utils";
import { useToastActions } from "../context/ToastContext";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "./EmptyState";
import { MarkdownBody } from "./MarkdownBody";

type AgentLookup = Map<string, { id: string; name: string }>;
type ProjectLookup = Map<string, { id: string; name: string }>;
type SecretLookup = Map<string, CompanySecret>;

type DirtyFieldDescriptor = {
  key: string;
  label: string;
};

type Props = {
  routine: Routine;
  isEditDirty: boolean;
  dirtyFields: DirtyFieldDescriptor[];
  onDiscardEdits: () => void;
  onSaveEdits: () => void;
  agents: AgentLookup;
  projects: ProjectLookup;
  secrets?: CompanySecret[];
  onRestoreSecretMaterials: (response: RestoreRoutineRevisionResponse) => void;
  onRestored?: (response: RestoreRoutineRevisionResponse) => void;
};

export function RoutineHistoryTab({
  routine,
  isEditDirty,
  dirtyFields,
  onDiscardEdits,
  onSaveEdits,
  agents,
  projects,
  secrets,
  onRestoreSecretMaterials,
  onRestored,
}: Props) {
  const { t } = useTranslation();
  const secretLookup = useMemo<SecretLookup>(
    () => new Map((secrets ?? []).map((secret) => [secret.id, secret])),
    [secrets],
  );
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [highlightedRevisionId, setHighlightedRevisionId] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [restoreSummary, setRestoreSummary] = useState("");

  const revisionsQuery = useQuery({
    queryKey: queryKeys.routines.revisions(routine.id),
    queryFn: () => routinesApi.listRevisions(routine.id),
  });

  const revisions = useMemo(() => revisionsQuery.data ?? [], [revisionsQuery.data]);
  const sortedRevisions = useMemo(
    () => [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber),
    [revisions],
  );
  const currentRevision = useMemo(
    () => sortedRevisions.find((r) => r.id === routine.latestRevisionId) ?? sortedRevisions[0] ?? null,
    [sortedRevisions, routine.latestRevisionId],
  );

  useEffect(() => {
    if (selectedRevisionId === null && currentRevision) {
      setSelectedRevisionId(currentRevision.id);
    }
  }, [currentRevision, selectedRevisionId]);

  const selectedRevision = useMemo(
    () => sortedRevisions.find((r) => r.id === selectedRevisionId) ?? null,
    [sortedRevisions, selectedRevisionId],
  );
  const isHistoricalSelected = !!selectedRevision && selectedRevision.id !== routine.latestRevisionId;
  const visibleRevisions = useMemo(() => {
    if (showOlder || sortedRevisions.length <= 8) return sortedRevisions;
    return sortedRevisions.slice(0, 8);
  }, [sortedRevisions, showOlder]);

  const restoreMutation = useMutation({
    mutationFn: (input: { revisionId: string; changeSummary: string }) =>
      routinesApi.restoreRevision(routine.id, input.revisionId, {
        changeSummary: input.changeSummary.trim() || null,
      }),
    onSuccess: async (data) => {
      const restoredFromNumber = data.restoredFromRevisionNumber;
      const newNumber = data.revision.revisionNumber;
      pushToast({
        title: t("routineHistory.toast.restoredTitle", {
          defaultValue: "Restored revision {{from}} as revision {{to}}",
          from: restoredFromNumber,
          to: newNumber,
        }),
        body: data.secretMaterials.length > 0
          ? t("routineHistory.toast.restoredBodyWithSecrets", {
              defaultValue:
                "Trigger enabled state was restored from the snapshot. New webhook secrets are available in the banner above.",
            })
          : t("routineHistory.toast.restoredBody", {
              defaultValue: "Trigger enabled state was restored from the snapshot.",
            }),
        tone: "success",
      });
      onRestoreSecretMaterials(data);
      onRestored?.(data);
      setConfirmOpen(false);
      setRestoreSummary("");
      setSelectedRevisionId(data.revision.id);
      setHighlightedRevisionId(data.revision.id);
      window.setTimeout(() => {
        setHighlightedRevisionId((current) =>
          current === data.revision.id ? null : current,
        );
      }, 3000);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routine.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.runs(routine.id) }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.activity(routine.companyId, routine.id),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(routine.companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.revisions(routine.id) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: t("routineHistory.toast.restoreFailedTitle", {
          defaultValue: "Failed to restore revision",
        }),
        body: error instanceof Error
          ? error.message
          : t("routineHistory.toast.restoreFailedBody", {
              defaultValue: "Paperclip could not restore the revision.",
            }),
        tone: "error",
      });
    },
  });

  const handleSelectRevision = (revisionId: string) => {
    if (isEditDirty) return;
    setSelectedRevisionId(revisionId);
  };

  const handleReturnToCurrent = () => {
    if (currentRevision) setSelectedRevisionId(currentRevision.id);
  };

  const openRestoreConfirm = () => {
    if (!selectedRevision || !isHistoricalSelected) return;
    setRestoreSummary("");
    setConfirmOpen(true);
  };

  const confirmRestore = () => {
    if (!selectedRevision) return;
    restoreMutation.mutate({
      revisionId: selectedRevision.id,
      changeSummary: restoreSummary,
    });
  };

  if (revisionsQuery.isLoading) {
    return (
      <div className="grid gap-5 md:grid-cols-[300px_minmax(0,1fr)]">
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, idx) => (
            <Skeleton key={idx} className="h-10 w-full" />
          ))}
        </div>
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (revisionsQuery.error) {
    return (
      <div className="rounded-md border border-l-2 border-l-destructive border-border p-4 space-y-3">
        <div>
          <p className="text-sm font-medium">
            {t("routineHistory.loadError.title", {
              defaultValue: "Could not load revisions",
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {revisionsQuery.error instanceof Error
              ? revisionsQuery.error.message
              : t("routineHistory.loadError.unknown", {
                  defaultValue: "Unknown error loading revisions.",
                })}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => revisionsQuery.refetch()}>
          {t("routineHistory.retry", { defaultValue: "Retry" })}
        </Button>
      </div>
    );
  }

  const onlyBootstrapRevision = revisions.length <= 1;

  return (
    <div className="grid gap-5 md:grid-cols-[300px_minmax(0,1fr)]">
      <RevisionList
        revisions={visibleRevisions}
        latestRevisionId={routine.latestRevisionId}
        selectedRevisionId={selectedRevisionId}
        highlightedRevisionId={highlightedRevisionId}
        isEditDirty={isEditDirty}
        totalRevisions={sortedRevisions.length}
        onSelect={handleSelectRevision}
        onShowOlder={() => setShowOlder(true)}
        showOlder={showOlder}
      />
      <div className="space-y-4 min-w-0">
        {isEditDirty && (
          <ConflictBanner
            dirtyFields={dirtyFields}
            onDiscard={onDiscardEdits}
            onSave={onSaveEdits}
          />
        )}
        {!isEditDirty && onlyBootstrapRevision ? (
          <div className="space-y-2">
            <EmptyState
              icon={HistoryIcon}
              message={t("routineHistory.emptyState.noEdits", {
                defaultValue: "No edits yet",
              })}
            />
            <p className="text-center text-xs text-muted-foreground">
              {t("routineHistory.emptyState.description", {
                defaultValue:
                  "Revision 1 is the only history this routine has. Saving an edit creates the first additional revision.",
              })}
            </p>
          </div>
        ) : (
          selectedRevision && (
            <>
              {isHistoricalSelected && currentRevision && (
                <HistoricalPreviewBanner
                  revisionNumber={selectedRevision.revisionNumber}
                  nextRevisionNumber={currentRevision.revisionNumber + 1}
                  onReturn={handleReturnToCurrent}
                  onRestore={openRestoreConfirm}
                  pending={restoreMutation.isPending}
                />
              )}
              <RevisionPreview
                revision={selectedRevision}
                currentRevision={currentRevision}
                isHistorical={isHistoricalSelected}
                agents={agents}
                projects={projects}
                onCompare={() => setDiffOpen(true)}
                onRestore={openRestoreConfirm}
                restorePending={restoreMutation.isPending}
                highlighted={highlightedRevisionId === selectedRevision.id}
              />
            </>
          )
        )}
      </div>

      {selectedRevision && currentRevision && (
        <RestoreConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          target={selectedRevision}
          currentRevisionNumber={currentRevision.revisionNumber}
          changeSummary={restoreSummary}
          onChangeSummaryChange={setRestoreSummary}
          onConfirm={confirmRestore}
          pending={restoreMutation.isPending}
          recreatedWebhookLabels={collectWebhookTriggerDifferences(
            selectedRevision,
            currentRevision,
          )}
          envDiffCounts={summarizeEnvDiffCounts(
            currentRevision.snapshot.routine.env ?? null,
            selectedRevision.snapshot.routine.env ?? null,
          )}
        />
      )}

      {currentRevision && selectedRevision && (
        <RoutineRevisionDiffModal
          open={diffOpen}
          onOpenChange={setDiffOpen}
          revisions={sortedRevisions}
          initialOldRevisionId={selectedRevision.id}
          initialNewRevisionId={currentRevision.id}
          agents={agents}
          projects={projects}
          secrets={secretLookup}
          onRestore={(rev) => {
            setSelectedRevisionId(rev.id);
            setDiffOpen(false);
            setRestoreSummary("");
            setConfirmOpen(true);
          }}
        />
      )}
    </div>
  );
}

function HistoricalPreviewBanner({
  revisionNumber,
  nextRevisionNumber,
  onReturn,
  onRestore,
  pending,
}: {
  revisionNumber: number;
  nextRevisionNumber: number;
  onReturn: () => void;
  onRestore: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium text-amber-200">
            {t("routineHistory.viewingRevision", {
              defaultValue: "Viewing revision {{n}} (read-only)",
              n: revisionNumber,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("routineHistory.historicalBanner.description", {
              defaultValue:
                "Restoring this revision creates a new revision {{n}} with the same content. History stays append-only.",
              n: nextRevisionNumber,
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onReturn} disabled={pending}>
            {t("routineHistory.returnToCurrent", { defaultValue: "Return to current" })}
          </Button>
          <Button size="sm" onClick={onRestore} disabled={pending}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {t("routineHistory.restoreAsNewRevision", {
              defaultValue: "Restore as new revision",
            })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConflictBanner({
  dirtyFields,
  onDiscard,
  onSave,
}: {
  dirtyFields: DirtyFieldDescriptor[];
  onDiscard: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const labels = dirtyFields.length > 0
    ? dirtyFields.map((field) => field.label)
    : [t("routineHistory.theRoutine", { defaultValue: "the routine" })];
  const fieldsText = formatDirtyFieldList(labels, t);
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium text-amber-200">
            {t("routineHistory.unsavedEditsTitle", {
              defaultValue: "Unsaved routine edits",
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("routineHistory.unsavedEditsBody", {
              defaultValue:
                "You changed {{fields}} but haven't saved yet. Save or discard before previewing or restoring an older revision.",
              fields: fieldsText,
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onDiscard}>
            {t("routineHistory.discardChanges", { defaultValue: "Discard changes" })}
          </Button>
          <Button size="sm" onClick={onSave}>
            {t("routineHistory.saveAndContinue", { defaultValue: "Save and continue" })}
          </Button>
        </div>
      </div>
      {dirtyFields.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {dirtyFields.map((field) => (
            <li key={field.key} className="flex items-center gap-2">
              <span className="h-1 w-1 rounded-full bg-amber-400" />
              {field.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RevisionList({
  revisions,
  latestRevisionId,
  selectedRevisionId,
  highlightedRevisionId,
  isEditDirty,
  totalRevisions,
  onSelect,
  onShowOlder,
  showOlder,
}: {
  revisions: RoutineRevision[];
  latestRevisionId: string | null;
  selectedRevisionId: string | null;
  highlightedRevisionId: string | null;
  isEditDirty: boolean;
  totalRevisions: number;
  onSelect: (revisionId: string) => void;
  onShowOlder: () => void;
  showOlder: boolean;
}) {
  const { t } = useTranslation();
  return (
    <aside className="space-y-1">
      <header className="flex items-center justify-between pb-2">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {t("routineHistory.revisions", { defaultValue: "Revisions" })}
        </p>
        <span className="text-[11px] text-muted-foreground">
          {t("routineHistory.totalCount", {
            defaultValue: "{{count}} total",
            count: totalRevisions,
          })}
        </span>
      </header>
      {revisions.map((revision) => {
        const isSelected = revision.id === selectedRevisionId;
        const isCurrent = revision.id === latestRevisionId;
        const isHistorical = !isCurrent;
        const isHighlighted = revision.id === highlightedRevisionId;
        const blockedByEdits = isEditDirty && isHistorical;
        const baseClass = "w-full rounded-md border px-3 py-2 text-left transition-colors";
        const stateClass = isHighlighted
          ? "border-emerald-500/40 bg-emerald-500/10"
          : isSelected && isHistorical
          ? "border-amber-500/40 bg-amber-500/10"
          : isSelected
          ? "border-border bg-accent/40"
          : blockedByEdits
          ? "border-amber-500/30 bg-amber-500/5 opacity-70 cursor-not-allowed"
          : "border-border/60 hover:bg-accent/40";
        return (
          <button
            key={revision.id}
            type="button"
            disabled={blockedByEdits}
            onClick={() => onSelect(revision.id)}
            className={`${baseClass} ${stateClass}`}
            data-testid={`revision-row-${revision.revisionNumber}`}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <span>
                {t("routineHistory.revShort", {
                  defaultValue: "rev {{n}}",
                  n: revision.revisionNumber,
                })}
              </span>
              {isCurrent && (
                <span className="rounded-full border border-border px-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  {t("routineHistory.currentBadge", { defaultValue: "Current" })}
                </span>
              )}
              {revision.restoredFromRevisionId && (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] uppercase tracking-[0.12em] text-amber-200">
                  {t("routineHistory.restoredBadge", { defaultValue: "Restored" })}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {relativeTime(revision.createdAt)} • {getActorLabel(revision, t)}
              {revision.changeSummary ? ` • ${revision.changeSummary}` : ""}
            </div>
          </button>
        );
      })}
      {totalRevisions > revisions.length && !showOlder && (
        <Button variant="ghost" size="sm" className="w-full" onClick={onShowOlder}>
          {t("routineHistory.showOlder", {
            defaultValue: "Show {{count}} older…",
            count: totalRevisions - revisions.length,
          })}
        </Button>
      )}
    </aside>
  );
}

function RevisionPreview({
  revision,
  currentRevision,
  isHistorical,
  agents,
  projects,
  onCompare,
  onRestore,
  restorePending,
  highlighted,
}: {
  revision: RoutineRevision;
  currentRevision: RoutineRevision | null;
  isHistorical: boolean;
  agents: AgentLookup;
  projects: ProjectLookup;
  onCompare: () => void;
  onRestore: () => void;
  restorePending: boolean;
  highlighted: boolean;
}) {
  const { t } = useTranslation();
  const snapshot = revision.snapshot.routine;
  const triggers = revision.snapshot.triggers;
  const currentSnapshot = currentRevision?.snapshot.routine ?? null;
  const restoreLabel = t("routineHistory.restoreThisRevision", {
    defaultValue: "Restore this revision",
  });
  const cardWrapper = `rounded-md border transition-colors duration-1000 ${
    highlighted ? "border-emerald-500/40 bg-emerald-500/10" : "border-border"
  }`;

  const envSummary = summarizeEnv(snapshot.env ?? null, t);
  const envDiffers = !!currentSnapshot
    && JSON.stringify(normalizeEnv(currentSnapshot.env ?? null))
      !== JSON.stringify(normalizeEnv(snapshot.env ?? null));
  const fieldRows: Array<{ key: string; label: string; value: string; differs: boolean }> = [
    {
      key: "title",
      label: t("routineHistory.field.title", { defaultValue: "Title" }),
      value: snapshot.title,
      differs: !!currentSnapshot && currentSnapshot.title !== snapshot.title,
    },
    {
      key: "priority",
      label: t("routineHistory.field.priority", { defaultValue: "Priority" }),
      value: snapshot.priority,
      differs: !!currentSnapshot && currentSnapshot.priority !== snapshot.priority,
    },
    {
      key: "status",
      label: t("routineHistory.field.status", { defaultValue: "Status" }),
      value: snapshot.status,
      differs: !!currentSnapshot && currentSnapshot.status !== snapshot.status,
    },
    {
      key: "assigneeAgentId",
      label: t("routineHistory.field.defaultAgent", { defaultValue: "Default agent" }),
      value: resolveAgentName(snapshot.assigneeAgentId, agents, t),
      differs: !!currentSnapshot && currentSnapshot.assigneeAgentId !== snapshot.assigneeAgentId,
    },
    {
      key: "projectId",
      label: t("routineHistory.field.project", { defaultValue: "Project" }),
      value: resolveProjectName(snapshot.projectId, projects, t),
      differs: !!currentSnapshot && currentSnapshot.projectId !== snapshot.projectId,
    },
    {
      key: "concurrencyPolicy",
      label: t("routineHistory.field.concurrency", { defaultValue: "Concurrency" }),
      value: snapshot.concurrencyPolicy.replaceAll("_", " "),
      differs: !!currentSnapshot && currentSnapshot.concurrencyPolicy !== snapshot.concurrencyPolicy,
    },
    {
      key: "catchUpPolicy",
      label: t("routineHistory.field.catchUp", { defaultValue: "Catch-up" }),
      value: snapshot.catchUpPolicy.replaceAll("_", " "),
      differs: !!currentSnapshot && currentSnapshot.catchUpPolicy !== snapshot.catchUpPolicy,
    },
    {
      key: "env",
      label: t("routineHistory.field.env", { defaultValue: "Env" }),
      value: envSummary,
      differs: envDiffers,
    },
  ];

  return (
    <div className="space-y-4">
      <header className={`${cardWrapper} p-4 space-y-2`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <p className="text-sm font-medium">
              {t("routineHistory.revShort", {
                defaultValue: "rev {{n}}",
                n: revision.revisionNumber,
              })}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {t("routineHistory.savedBy", {
                defaultValue: "Saved {{when}} by {{actor}}",
                when: relativeTime(revision.createdAt),
                actor: getActorLabel(revision, t),
              })}
              {revision.changeSummary ? ` · ${revision.changeSummary}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onCompare}>
              <Search className="mr-1.5 h-3.5 w-3.5" />
              {t("routineHistory.compareWithCurrent", {
                defaultValue: "Compare with current",
              })}
            </Button>
            <Button
              size="sm"
              onClick={onRestore}
              disabled={!isHistorical || restorePending}
              aria-label={restoreLabel}
              className={!isHistorical ? "text-muted-foreground/60" : undefined}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {restoreLabel}
            </Button>
          </div>
        </div>
      </header>

      <div className={`${cardWrapper} p-3`}>
        <p className="pb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {t("routineHistory.structuredFields", { defaultValue: "Structured fields" })}
        </p>
        <div className="grid gap-3 md:grid-cols-2 divide-y md:divide-y-0 divide-border">
          {fieldRows.map((row) => (
            <div key={row.key} className="space-y-1 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{row.label}</p>
              <p className="text-sm">
                {row.value || <span className="text-muted-foreground">—</span>}
                {row.differs && (
                  <span className="ml-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] uppercase tracking-[0.12em] text-amber-200">
                    {t("routineHistory.differsFromCurrent", {
                      defaultValue: "differs from current",
                    })}
                  </span>
                )}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className={`${cardWrapper} p-3 space-y-2`}>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {t("routineHistory.description", { defaultValue: "Description" })}
        </p>
        <div className="rounded-md bg-background/40 p-3 text-sm leading-7">
          {snapshot.description ? (
            <MarkdownBody>{snapshot.description}</MarkdownBody>
          ) : (
            <span className="text-muted-foreground">
              {t("routineHistory.noDescription", { defaultValue: "No description" })}
            </span>
          )}
        </div>
      </div>

      <div className={`${cardWrapper} p-3 space-y-2`}>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {t("routineHistory.triggersHeading", {
            defaultValue: "Triggers ({{count}})",
            count: triggers.length,
          })}
        </p>
        {triggers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("routineHistory.noTriggers", {
              defaultValue: "No triggers in this revision.",
            })}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {triggers.map((trigger) => (
              <li key={trigger.id} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  {trigger.kind}
                </span>
                <span className="font-medium">{trigger.label ?? trigger.kind}</span>
                <span className="text-xs text-muted-foreground">
                  {summarizeTriggerSnapshot(trigger, t)}
                </span>
                <span
                  className={`ml-auto text-xs ${trigger.enabled ? "text-emerald-400" : "text-muted-foreground"}`}
                >
                  {trigger.enabled
                    ? t("routineHistory.triggerEnabled", { defaultValue: "enabled" })
                    : t("routineHistory.triggerDisabled", { defaultValue: "disabled" })}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {t("routineHistory.webhookSecretsNote", {
            defaultValue:
              "Webhook secrets are not stored in revisions. If a restored webhook trigger needs re-creation, Paperclip mints fresh secret material at restore time.",
          })}
        </p>
      </div>

      {snapshot.variables.length > 0 && (
        <div className={`${cardWrapper} p-3 space-y-2`}>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {t("routineHistory.variablesHeading", {
              defaultValue: "Variables ({{count}})",
              count: snapshot.variables.length,
            })}
          </p>
          <ul className="divide-y divide-border">
            {snapshot.variables.map((variable) => (
              <li key={variable.name} className="py-2 flex items-center justify-between text-sm">
                <span className="font-mono text-xs">{variable.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t("routineHistory.variableDefault", {
                    defaultValue: "default: {{value}}",
                    value: formatVariableDefault(variable),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RestoreConfirmDialog({
  open,
  onOpenChange,
  target,
  currentRevisionNumber,
  changeSummary,
  onChangeSummaryChange,
  onConfirm,
  pending,
  recreatedWebhookLabels,
  envDiffCounts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: RoutineRevision;
  currentRevisionNumber: number;
  changeSummary: string;
  onChangeSummaryChange: (value: string) => void;
  onConfirm: () => void;
  pending: boolean;
  recreatedWebhookLabels: string[];
  envDiffCounts: EnvDiffCounts;
}) {
  const { t } = useTranslation();
  const newRevisionNumber = currentRevisionNumber + 1;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("routineHistory.restoreDialog.title", {
              defaultValue: "Restore revision {{n}}?",
              n: target.revisionNumber,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("routineHistory.restoreDialog.description", {
              defaultValue:
                "This creates a new revision {{newN}} with the same content as revision {{targetN}}. Revisions {{targetN}}–{{currentN}} stay in history and are not modified.",
              newN: newRevisionNumber,
              targetN: target.revisionNumber,
              currentN: currentRevisionNumber,
            })}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-sm">
          <li className="flex items-start gap-2">
            <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {t("routineHistory.restoreDialog.fieldsRevert", {
              defaultValue: "Routine field values, variables, and schedule cron will revert.",
            })}
          </li>
          {envDiffCounts.total > 0 && (
            <li className="flex items-start gap-2">
              <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {t("routineHistory.restoreDialog.secretsRevert", {
                defaultValue: "Routine secrets will revert: {{summary}}.",
                summary: formatEnvDiffCounts(envDiffCounts, t),
              })}
            </li>
          )}
          <li className="flex items-start gap-2">
            <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {t("routineHistory.restoreDialog.runHistoryPreserved", {
              defaultValue: "Previous run history is preserved.",
            })}
          </li>
          {recreatedWebhookLabels.map((label) => (
            <li key={label} className="flex items-start gap-2 text-amber-200">
              <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
              {t("routineHistory.restoreDialog.webhookRecreated", {
                defaultValue:
                  "The webhook trigger {{label}} will be recreated with a new URL and secret. Paperclip will show the secret once after restore — copy it before closing.",
                label,
              })}
            </li>
          ))}
        </ul>
        <div className="space-y-1.5">
          <Label htmlFor="restore-change-summary" className="text-xs">
            {t("routineHistory.restoreDialog.changeSummaryLabel", {
              defaultValue: "Change summary (optional)",
            })}
          </Label>
          <Input
            id="restore-change-summary"
            value={changeSummary}
            placeholder={t("routineHistory.restoreDialog.changeSummaryPlaceholder", {
              defaultValue: "Why are you restoring? Visible in history.",
            })}
            onChange={(event) => onChangeSummaryChange(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("routineHistory.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {pending
              ? t("routineHistory.restoring", { defaultValue: "Restoring…" })
              : t("routineHistory.restoreAsRevisionN", {
                  defaultValue: "Restore as revision {{n}}",
                  n: newRevisionNumber,
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoutineRevisionDiffModal({
  open,
  onOpenChange,
  revisions,
  initialOldRevisionId,
  initialNewRevisionId,
  agents,
  projects,
  secrets,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revisions: RoutineRevision[];
  initialOldRevisionId: string;
  initialNewRevisionId: string;
  agents: AgentLookup;
  projects: ProjectLookup;
  secrets: SecretLookup;
  onRestore: (revision: RoutineRevision) => void;
}) {
  const { t } = useTranslation();
  const [leftId, setLeftId] = useState<string>(initialOldRevisionId);
  const [rightId, setRightId] = useState<string>(initialNewRevisionId);

  useEffect(() => {
    if (open) {
      setLeftId(initialOldRevisionId);
      setRightId(initialNewRevisionId);
    }
  }, [open, initialOldRevisionId, initialNewRevisionId]);

  const left = revisions.find((r) => r.id === leftId) ?? null;
  const right = revisions.find((r) => r.id === rightId) ?? null;
  const fieldChanges = useMemo(
    () => (left && right ? computeFieldChanges(left, right, agents, projects, secrets, t) : []),
    [left, right, agents, projects, secrets, t],
  );
  const descriptionDiff = useMemo<DiffRow[]>(
    () => (left && right
      ? buildLineDiff(left.snapshot.routine.description ?? "", right.snapshot.routine.description ?? "")
      : []),
    [left, right],
  );
  const newest = revisions[0] ?? null;
  const leftIsHistorical = !!left && !!newest && left.id !== newest.id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[90%] w-full max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {t("routineHistory.compareDialog.title", {
              defaultValue: "Compare routine revisions",
            })}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-3">
          <RevisionPicker
            label={t("routineHistory.compareDialog.oldLabel", { defaultValue: "Old" })}
            value={leftId}
            onChange={setLeftId}
            revisions={revisions}
            tone="red"
          />
          <RevisionPicker
            label={t("routineHistory.compareDialog.newLabel", { defaultValue: "New" })}
            value={rightId}
            onChange={setRightId}
            revisions={revisions}
            tone="green"
          />
        </div>
        <div className="overflow-auto flex-1 space-y-4">
          <section className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              {t("routineHistory.fieldChanges", { defaultValue: "Field changes" })}
            </p>
            {fieldChanges.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("routineHistory.noFieldChanges", {
                  defaultValue: "No structural field changes.",
                })}
              </p>
            ) : (
              <table className="w-full text-sm border border-border rounded-md overflow-hidden">
                <thead>
                  <tr className="text-xs uppercase tracking-wide bg-muted/30 text-muted-foreground">
                    <th className="px-3 py-2 text-left">
                      {t("routineHistory.tableHeader.field", { defaultValue: "Field" })}
                    </th>
                    <th className="px-3 py-2 text-left">
                      {t("routineHistory.tableHeader.oldValue", { defaultValue: "Old value" })}
                    </th>
                    <th className="px-3 py-2 text-left">
                      {t("routineHistory.tableHeader.newValue", { defaultValue: "New value" })}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {fieldChanges.map((change) => (
                    <tr key={change.field} className="border-t border-border/60">
                      <td className="px-3 py-2 align-top text-xs font-medium">{change.field}</td>
                      <td className="px-3 py-2 align-top text-xs text-red-300">
                        {change.oldValue ?? "—"}
                      </td>
                      <td className="px-3 py-2 align-top text-xs text-emerald-300">
                        {change.newValue ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              {t("routineHistory.descriptionDiff", { defaultValue: "Description diff" })}
            </p>
            <DiffTable rows={descriptionDiff} />
          </section>
        </div>
        <DialogFooter className="justify-between sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("routineHistory.close", { defaultValue: "Close" })}
          </Button>
          {leftIsHistorical && left && (
            <Button onClick={() => onRestore(left)}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {t("routineHistory.restoreRevAsNew", {
                defaultValue: "Restore rev {{n}} as new revision",
                n: left.revisionNumber,
              })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevisionPicker({
  label,
  value,
  onChange,
  revisions,
  tone,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  revisions: RoutineRevision[];
  tone: "red" | "green";
}) {
  const { t } = useTranslation();
  const toneClass = tone === "red"
    ? "border-red-500/30 bg-red-500/10 text-red-300"
    : "border-green-500/30 bg-green-500/10 text-green-300";
  return (
    <div className="flex items-center gap-2">
      <span
        className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${toneClass}`}
      >
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 min-w-[12rem] rounded-md border border-border/60 bg-background px-2 text-xs"
      >
        {revisions.map((revision) => (
          <option key={revision.id} value={revision.id}>
            {t("routineHistory.revOption", {
              defaultValue: "rev {{n}} — {{when}}",
              n: revision.revisionNumber,
              when: relativeTime(revision.createdAt),
            })}
            {revision.changeSummary ? ` • ${revision.changeSummary}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

function DiffTable({ rows }: { rows: DiffRow[] }) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("routineHistory.diff.noDescription", {
          defaultValue: "No description on either revision.",
        })}
      </p>
    );
  }
  if (rows.every((row) => row.kind === "context")) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("routineHistory.diff.identical", {
          defaultValue: "Descriptions are identical.",
        })}
      </p>
    );
  }
  const lineClassesByKind: Record<DiffRow["kind"], string> = {
    context: "bg-transparent",
    removed: "bg-red-500/10 text-red-100",
    added: "bg-green-500/10 text-green-100",
  };
  const markerByKind: Record<DiffRow["kind"], string> = {
    context: " ",
    removed: "-",
    added: "+",
  };
  return (
    <div className="rounded-md border border-border text-xs font-mono leading-6 overflow-hidden">
      <div className="grid grid-cols-[56px_56px_24px_minmax(0,1fr)] border-b border-border/60 bg-muted/30 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>{t("routineHistory.diff.old", { defaultValue: "Old" })}</span>
        <span>{t("routineHistory.diff.new", { defaultValue: "New" })}</span>
        <span />
        <span>{t("routineHistory.diff.content", { defaultValue: "Content" })}</span>
      </div>
      {rows.map((row, index) => (
        <div
          key={`${row.kind}-${index}-${row.oldLineNumber ?? "x"}-${row.newLineNumber ?? "x"}`}
          className={`grid grid-cols-[56px_56px_24px_minmax(0,1fr)] gap-0 border-b border-border/30 px-3 ${lineClassesByKind[row.kind]}`}
        >
          <span className="select-none border-r border-border/30 pr-3 text-right text-muted-foreground">
            {row.oldLineNumber ?? ""}
          </span>
          <span className="select-none border-r border-border/30 px-3 text-right text-muted-foreground">
            {row.newLineNumber ?? ""}
          </span>
          <span className="select-none px-3 text-center text-muted-foreground">
            {markerByKind[row.kind]}
          </span>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-0 text-inherit">
            {row.text.length > 0 ? row.text : " "}
          </pre>
        </div>
      ))}
    </div>
  );
}

function getActorLabel(revision: RoutineRevision, t: TFunction): string {
  if (revision.createdByUserId) {
    return t("routineHistory.actor.board", { defaultValue: "board" });
  }
  if (revision.createdByAgentId) {
    return t("routineHistory.actor.agent", { defaultValue: "agent" });
  }
  return t("routineHistory.actor.system", { defaultValue: "system" });
}

function resolveAgentName(agentId: string | null, lookup: AgentLookup, t: TFunction) {
  if (!agentId) return t("routineHistory.unassigned", { defaultValue: "Unassigned" });
  return lookup.get(agentId)?.name ?? agentId;
}

function resolveProjectName(projectId: string | null, lookup: ProjectLookup, t: TFunction) {
  if (!projectId) return t("routineHistory.noProject", { defaultValue: "No project" });
  return lookup.get(projectId)?.name ?? projectId;
}

function summarizeTriggerSnapshot(
  trigger: RoutineRevisionSnapshotTriggerV1,
  t: TFunction,
): string {
  if (trigger.kind === "schedule") {
    return [trigger.cronExpression, trigger.timezone].filter(Boolean).join(" · ");
  }
  if (trigger.kind === "webhook") {
    const replay = trigger.replayWindowSec != null
      ? t("routineHistory.trigger.replay", {
          defaultValue: "replay {{seconds}}s",
          seconds: trigger.replayWindowSec,
        })
      : "";
    return [trigger.signingMode, replay].filter(Boolean).join(" · ");
  }
  return t("routineHistory.trigger.api", { defaultValue: "API" });
}

function formatVariableDefault(variable: RoutineVariable): string {
  if (variable.defaultValue == null) return "—";
  return String(variable.defaultValue);
}

function formatDirtyFieldList(labels: string[], t: TFunction): string {
  if (labels.length === 0) {
    return t("routineHistory.theRoutine", { defaultValue: "the routine" });
  }
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) {
    return t("routineHistory.list.two", {
      defaultValue: "{{first}} and {{second}}",
      first: labels[0],
      second: labels[1],
    });
  }
  return t("routineHistory.list.many", {
    defaultValue: "{{leading}}, and {{last}}",
    leading: labels.slice(0, -1).join(", "),
    last: labels[labels.length - 1],
  });
}

function collectWebhookTriggerDifferences(
  target: RoutineRevision,
  current: RoutineRevision,
): string[] {
  const currentIds = new Set(current.snapshot.triggers.map((t) => t.id));
  return target.snapshot.triggers
    .filter((trigger) => trigger.kind === "webhook" && !currentIds.has(trigger.id))
    .map((trigger) => trigger.label ?? "webhook");
}

function describeSnapshotField(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function computeFieldChanges(
  left: RoutineRevision,
  right: RoutineRevision,
  agents: AgentLookup,
  projects: ProjectLookup,
  secrets: SecretLookup,
  t: TFunction,
): Array<{ field: string; oldValue: string | null; newValue: string | null }> {
  const oldRoutine = left.snapshot.routine;
  const newRoutine = right.snapshot.routine;
  const changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
  const compareScalar = (
    _field: string,
    label: string,
    oldVal: unknown,
    newVal: unknown,
    transform: (value: unknown) => string = describeSnapshotField,
  ) => {
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({ field: label, oldValue: transform(oldVal), newValue: transform(newVal) });
    }
  };
  compareScalar(
    "title",
    t("routineHistory.field.title", { defaultValue: "Title" }),
    oldRoutine.title,
    newRoutine.title,
  );
  compareScalar(
    "priority",
    t("routineHistory.field.priority", { defaultValue: "Priority" }),
    oldRoutine.priority,
    newRoutine.priority,
  );
  compareScalar(
    "assigneeAgentId",
    t("routineHistory.field.defaultAgent", { defaultValue: "Default agent" }),
    resolveAgentName(oldRoutine.assigneeAgentId, agents, t),
    resolveAgentName(newRoutine.assigneeAgentId, agents, t),
  );
  compareScalar(
    "projectId",
    t("routineHistory.field.project", { defaultValue: "Project" }),
    resolveProjectName(oldRoutine.projectId, projects, t),
    resolveProjectName(newRoutine.projectId, projects, t),
  );
  compareScalar(
    "concurrencyPolicy",
    t("routineHistory.field.concurrency", { defaultValue: "Concurrency" }),
    oldRoutine.concurrencyPolicy,
    newRoutine.concurrencyPolicy,
  );
  compareScalar(
    "catchUpPolicy",
    t("routineHistory.field.catchUp", { defaultValue: "Catch-up" }),
    oldRoutine.catchUpPolicy,
    newRoutine.catchUpPolicy,
  );
  compareScalar(
    "status",
    t("routineHistory.field.status", { defaultValue: "Status" }),
    oldRoutine.status,
    newRoutine.status,
  );
  if (JSON.stringify(oldRoutine.variables) !== JSON.stringify(newRoutine.variables)) {
    changes.push({
      field: t("routineHistory.field.variables", { defaultValue: "Variables" }),
      oldValue: summarizeVariables(oldRoutine.variables),
      newValue: summarizeVariables(newRoutine.variables),
    });
  }
  compareEnv(oldRoutine.env ?? null, newRoutine.env ?? null, secrets, changes, t);
  compareTriggers(left.snapshot.triggers, right.snapshot.triggers, changes, t);
  return changes;
}

function normalizeEnv(env: RoutineEnvConfig | null): Record<string, EnvBinding> {
  if (!env) return {};
  return env;
}

function envBindingKind(binding: EnvBinding): "plain" | "secret_ref" {
  if (typeof binding === "string") return "plain";
  if (binding && typeof binding === "object" && "type" in binding && binding.type === "secret_ref") {
    return "secret_ref";
  }
  return "plain";
}

function asSecretRef(binding: EnvBinding): EnvSecretRefBinding | null {
  if (typeof binding === "string") return null;
  if (binding && typeof binding === "object" && "type" in binding && binding.type === "secret_ref") {
    return binding;
  }
  return null;
}

function formatVersionSelector(
  version: SecretVersionSelector | undefined,
  t: TFunction,
): string {
  if (version == null || version === "latest") {
    return t("routineHistory.versionLatest", { defaultValue: "latest" });
  }
  return `v${version}`;
}

function describeSecretRef(ref: EnvSecretRefBinding, secrets: SecretLookup, t: TFunction): string {
  const secret = secrets.get(ref.secretId);
  const name = secret?.name ?? "<missing-secret>";
  return `${name} ${formatVersionSelector(ref.version, t)}`;
}

function describeEnvBinding(
  binding: EnvBinding | undefined,
  secrets: SecretLookup,
  t: TFunction,
): string {
  if (binding === undefined) return "—";
  const ref = asSecretRef(binding);
  if (ref) return `secret_ref → ${describeSecretRef(ref, secrets, t)}`;
  return t("routineHistory.env.plainSet", { defaultValue: "plain (set)" });
}

function summarizeEnv(env: RoutineEnvConfig | null, t: TFunction): string {
  const entries = Object.entries(normalizeEnv(env));
  if (entries.length === 0) return "";
  const secretCount = entries.filter(([, binding]) => envBindingKind(binding) === "secret_ref").length;
  if (secretCount === 0) {
    return t("routineHistory.env.keysOnly", {
      defaultValue: "{{count}} key",
      defaultValue_plural: "{{count}} keys",
      count: entries.length,
    });
  }
  return t("routineHistory.env.keysWithSecrets", {
    defaultValue: "{{count}} keys ({{secrets}} secret refs)",
    count: entries.length,
    secrets: secretCount,
  });
}

type EnvDiffCounts = {
  added: number;
  removed: number;
  changed: number;
  total: number;
};

function summarizeEnvDiffCounts(
  current: RoutineEnvConfig | null,
  target: RoutineEnvConfig | null,
): EnvDiffCounts {
  const currentRec = normalizeEnv(current);
  const targetRec = normalizeEnv(target);
  let added = 0;
  let removed = 0;
  let changed = 0;
  const keys = new Set<string>([...Object.keys(currentRec), ...Object.keys(targetRec)]);
  for (const key of keys) {
    const inCurrent = key in currentRec;
    const inTarget = key in targetRec;
    if (inTarget && !inCurrent) {
      added += 1;
      continue;
    }
    if (!inTarget && inCurrent) {
      removed += 1;
      continue;
    }
    if (JSON.stringify(currentRec[key]) !== JSON.stringify(targetRec[key])) {
      changed += 1;
    }
  }
  return { added, removed, changed, total: added + removed + changed };
}

function formatEnvDiffCounts(counts: EnvDiffCounts, t: TFunction): string {
  const parts: string[] = [];
  if (counts.added > 0) {
    parts.push(
      t("routineHistory.env.added", {
        defaultValue: "{{count}} keys added",
        count: counts.added,
      }),
    );
  }
  if (counts.removed > 0) {
    parts.push(
      t("routineHistory.env.removed", {
        defaultValue: "{{count}} keys removed",
        count: counts.removed,
      }),
    );
  }
  if (counts.changed > 0) {
    parts.push(
      t("routineHistory.env.changed", {
        defaultValue: "{{count}} keys changed",
        count: counts.changed,
      }),
    );
  }
  return parts.join(", ");
}

function compareEnv(
  oldEnv: RoutineEnvConfig | null,
  newEnv: RoutineEnvConfig | null,
  secrets: SecretLookup,
  changes: Array<{ field: string; oldValue: string | null; newValue: string | null }>,
  t: TFunction,
) {
  const oldRec = normalizeEnv(oldEnv);
  const newRec = normalizeEnv(newEnv);
  const keys = new Set<string>([...Object.keys(oldRec), ...Object.keys(newRec)]);
  const sortedKeys = [...keys].sort();
  for (const key of sortedKeys) {
    const oldBinding = oldRec[key];
    const newBinding = newRec[key];
    const inOld = key in oldRec;
    const inNew = key in newRec;
    if (inNew && !inOld) {
      changes.push({
        field: t("routineHistory.envChange.added", {
          defaultValue: "Env added ({{key}})",
          key,
        }),
        oldValue: "—",
        newValue: describeEnvBinding(newBinding, secrets, t),
      });
      continue;
    }
    if (!inNew && inOld) {
      changes.push({
        field: t("routineHistory.envChange.removed", {
          defaultValue: "Env removed ({{key}})",
          key,
        }),
        oldValue: describeEnvBinding(oldBinding, secrets, t),
        newValue: "—",
      });
      continue;
    }
    if (JSON.stringify(oldBinding) === JSON.stringify(newBinding)) continue;
    const oldKind = envBindingKind(oldBinding);
    const newKind = envBindingKind(newBinding);
    if (oldKind !== newKind) {
      changes.push({
        field: t("routineHistory.envChange.bindingKind", {
          defaultValue: "Env {{key}} binding kind",
          key,
        }),
        oldValue: describeEnvBinding(oldBinding, secrets, t),
        newValue: describeEnvBinding(newBinding, secrets, t),
      });
      continue;
    }
    if (newKind === "secret_ref") {
      const oldRef = asSecretRef(oldBinding)!;
      const newRef = asSecretRef(newBinding)!;
      if (oldRef.secretId !== newRef.secretId) {
        changes.push({
          field: t("routineHistory.envChange.secret", {
            defaultValue: "Env {{key}} secret",
            key,
          }),
          oldValue: describeEnvBinding(oldBinding, secrets, t),
          newValue: describeEnvBinding(newBinding, secrets, t),
        });
        continue;
      }
      changes.push({
        field: t("routineHistory.envChange.version", {
          defaultValue: "Env {{key}} version",
          key,
        }),
        oldValue: describeSecretRef(oldRef, secrets, t),
        newValue: describeSecretRef(newRef, secrets, t),
      });
      continue;
    }
    changes.push({
      field: t("routineHistory.envChange.value", {
        defaultValue: "Env {{key}} value",
        key,
      }),
      oldValue: t("routineHistory.env.plainSet", { defaultValue: "plain (set)" }),
      newValue: t("routineHistory.env.plainChanged", { defaultValue: "plain (changed)" }),
    });
  }
}

function summarizeVariables(variables: RoutineVariable[]): string {
  if (variables.length === 0) return "(none)";
  return variables
    .map((variable) => `${variable.name}=${formatVariableDefault(variable)}`)
    .join(", ");
}

function compareTriggers(
  oldTriggers: RoutineRevisionSnapshotTriggerV1[],
  newTriggers: RoutineRevisionSnapshotTriggerV1[],
  changes: Array<{ field: string; oldValue: string | null; newValue: string | null }>,
  t: TFunction,
) {
  const byId = new Map<string, { old?: RoutineRevisionSnapshotTriggerV1; next?: RoutineRevisionSnapshotTriggerV1 }>();
  for (const trigger of oldTriggers) byId.set(trigger.id, { old: trigger });
  for (const trigger of newTriggers) {
    const existing = byId.get(trigger.id) ?? {};
    byId.set(trigger.id, { ...existing, next: trigger });
  }
  for (const [, pair] of byId) {
    if (pair.old && !pair.next) {
      changes.push({
        field: t("routineHistory.triggerChange.removed", {
          defaultValue: "Trigger removed ({{label}})",
          label: pair.old.label ?? pair.old.kind,
        }),
        oldValue: summarizeTriggerSnapshot(pair.old, t),
        newValue: null,
      });
    } else if (!pair.old && pair.next) {
      changes.push({
        field: t("routineHistory.triggerChange.added", {
          defaultValue: "Trigger added ({{label}})",
          label: pair.next.label ?? pair.next.kind,
        }),
        oldValue: null,
        newValue: summarizeTriggerSnapshot(pair.next, t),
      });
    } else if (pair.old && pair.next) {
      const oldSummary = summarizeTriggerSnapshot(pair.old, t);
      const newSummary = summarizeTriggerSnapshot(pair.next, t);
      if (oldSummary !== newSummary || pair.old.enabled !== pair.next.enabled) {
        const enabledLabel = t("routineHistory.triggerEnabled", { defaultValue: "enabled" });
        const disabledLabel = t("routineHistory.triggerDisabled", { defaultValue: "disabled" });
        changes.push({
          field: t("routineHistory.triggerChange.label", {
            defaultValue: "Trigger {{label}}",
            label: pair.next.label ?? pair.next.kind,
          }),
          oldValue: `${oldSummary} (${pair.old.enabled ? enabledLabel : disabledLabel})`,
          newValue: `${newSummary} (${pair.next.enabled ? enabledLabel : disabledLabel})`,
        });
      }
    }
  }
}

export function isUpdateConflictError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409;
}

export type RoutineHistoryDirtyFieldDescriptor = DirtyFieldDescriptor;
export type RoutineHistoryAgentLookup = AgentLookup;
export type RoutineHistoryProjectLookup = ProjectLookup;
