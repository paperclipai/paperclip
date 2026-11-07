import { t, useTranslation, Trans, i18n } from "@/i18n";
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
import {
  routinesApi,
  type RestoreRoutineRevisionResponse,
} from "../api/routines";
import { ApiError } from "../api/client";
import { describeError } from "../api/errors";
import { QueryErrorState, useQueryView } from "./QueryView";
import { queryKeys } from "../lib/queryKeys";
import { buildLineDiff, type DiffRow } from "../lib/line-diff";
import { relativeTime } from "../lib/utils";
import { useToastActions } from "../context/ToastContext";
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
import { Badge } from "@/components/ui/badge";

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
  useTranslation("task-components");
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
  const revisionsView = useQueryView(revisionsQuery);

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
        presentation: { title: { key: "task-components:restoredRevisionAsRevision_0104e4a8", values: { value1: restoredFromNumber, value2: newNumber } }, body: data.secretMaterials.length > 0 ? { key: "final-components-b:historyFeedback.Trigger_enabled_state_was_restored_from_the_snapshot_New_webhook_secre_acff3e" } : { key: "final-components-b:historyFeedback.Trigger_enabled_state_was_restored_from_the_snapshot_80ea8a" } },
        title: t("task-components:restoredRevisionAsRevision_0104e4a8", { value1: restoredFromNumber, value2: newNumber }),
        body: data.secretMaterials.length > 0
          ? "Trigger enabled state was restored from the snapshot. New webhook secrets are available in the banner above."
          : "Trigger enabled state was restored from the snapshot.",
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
        presentation: { title: { key: "task-components:failedToRestoreRevision_2dcf4f54" } },
        title: t("task-components:failedToRestoreRevision_2dcf4f54"),
        body: describeError(error, { action: "restore the revision" }).body,
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

  // A loaded revision list stays on screen through a failed refetch; an outage
  // before the first load shows the skeleton, a real failure shows copy.
  if (revisionsView.kind === "loading" || revisionsView.kind === "reconnecting") {
    return (
      <div className="grid gap-5 md:grid-cols-(--gtc-9)">
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, idx) => (
            <Skeleton key={idx} className="h-10 w-full" />
          ))}
        </div>
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (revisionsView.kind === "error") {
    return (
      <QueryErrorState
        error={revisionsView.error}
        action="load revisions"
        onRetry={revisionsView.retry}
        retrying={revisionsView.isFetching}
      />
    );
  }

  const onlyBootstrapRevision = revisions.length <= 1;

  return (
    <div className="grid gap-5 md:grid-cols-(--gtc-9)">
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
              message={t("final-components-b:RoutineHistoryTab.No_edits_yet_961468")}
            />
            <p className="text-center text-xs text-muted-foreground">{t("task-components:revision1IsTheOnlyHistoryThis_44654bed")}</p>
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
  useTranslation("task-components");
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200"><Trans ns="final-components-b" i18nKey="numeric.RoutineHistoryTab.4ea4c0acaf5b_b7132" values={{ revisionNumber: revisionNumber }} /></p>
          <p className="text-xs text-muted-foreground"><Trans ns="final-components-b" i18nKey="numeric.RoutineHistoryTab.4303b7d5d7e9_7b3ca" values={{ nextRevisionNumber: nextRevisionNumber }} /></p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onReturn} disabled={pending}>{t("task-components:returnToCurrent_2e6cf99a")}</Button>
          <Button size="sm" onClick={onRestore} disabled={pending}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />{t("task-components:restoreAsNewRevision_b5a56640")}</Button>
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
  useTranslation("task-components");
  const labels = dirtyFields.length > 0
    ? dirtyFields.map((field) => field.label)
    : [t("final-components-b:RoutineHistoryTab.the_routine_af1ec2")];
  const fieldsText = formatDirtyFieldList(labels);
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">{t("task-components:unsavedRoutineEdits_16e48398")}</p>
          <p className="text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_a1779582bbcc" components={{ part1: <>{fieldsText}</> }} /></p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onDiscard}>{t("task-components:discardChanges_f9bfa3dc")}</Button>
          <Button size="sm" onClick={onSave}>{t("task-components:saveAndContinue_6880daf1")}</Button>
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
  useTranslation("task-components");
  return (
    <aside className="space-y-1">
      <header className="flex items-center justify-between pb-2">
        <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:revisions_da80b1d5")}</p>
        <span className="text-(length:--text-micro) text-muted-foreground"><Trans ns="final-components-b" i18nKey="numeric.RoutineHistoryTab.8d34cb941496_1af9d" values={{ totalRevisions: totalRevisions }} /></span>
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
              <span><Trans ns="final-components-b" i18nKey="numeric.RoutineHistoryTab.136630b66eb2_77b70" values={{ revisionNumber: revision.revisionNumber }} /></span>
              {isCurrent && (
                <Badge variant="outline" className="border-border px-1.5 text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("task-components:current_e0d1b682")}</Badge>
              )}
              {revision.restoredFromRevisionId && (
                <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 px-1.5 text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-amber-800 dark:text-amber-200">{t("task-components:restored_5d561a1e")}</Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {relativeTime(revision.createdAt)} • {getActorLabel(revision)}
              {revision.changeSummary ? ` • ${revision.changeSummary}` : ""}
            </div>
          </button>
        );
      })}
      {totalRevisions > revisions.length && !showOlder && (
        <Button variant="ghost" size="sm" className="w-full" onClick={onShowOlder}><Trans ns="final-components-b" i18nKey="numeric.RoutineHistoryTab.49db236a63fc_82be2" values={{ count: totalRevisions - revisions.length }} /></Button>
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
  useTranslation("task-components");
  const snapshot = revision.snapshot.routine;
  const triggers = revision.snapshot.triggers;
  const currentSnapshot = currentRevision?.snapshot.routine ?? null;
  const restoreLabel = isHistorical ? t("task-components:restoreThisRevision_e0a9d24c") : t("task-components:restoreThisRevision_e0a9d24c");
  const cardWrapper = `rounded-md border transition-colors duration-1000 ${
    highlighted ? "border-emerald-500/40 bg-emerald-500/10" : "border-border"
  }`;

  const envSummary = summarizeEnv(snapshot.env ?? null);
  const envDiffers = !!currentSnapshot
    && JSON.stringify(normalizeEnv(currentSnapshot.env ?? null))
      !== JSON.stringify(normalizeEnv(snapshot.env ?? null));
  const fieldRows: Array<{ key: string; label: string; value: string; differs: boolean }> = [
    {
      key: "title",
      label: t("task-components:title_7e8cd205"),
      value: snapshot.title,
      differs: !!currentSnapshot && currentSnapshot.title !== snapshot.title,
    },
    {
      key: "priority",
      label: t("task-components:priority_d60dbba0"),
      value: snapshot.priority,
      differs: !!currentSnapshot && currentSnapshot.priority !== snapshot.priority,
    },
    {
      key: "status",
      label: t("task-components:status_920e413c"),
      value: snapshot.status,
      differs: !!currentSnapshot && currentSnapshot.status !== snapshot.status,
    },
    {
      key: "assigneeAgentId",
      label: t("task-components:defaultAgent_94da52ec"),
      value: resolveAgentName(snapshot.assigneeAgentId, agents),
      differs: !!currentSnapshot && currentSnapshot.assigneeAgentId !== snapshot.assigneeAgentId,
    },
    {
      key: "projectId",
      label: t("task-components:project_98595978"),
      value: resolveProjectName(snapshot.projectId, projects),
      differs: !!currentSnapshot && currentSnapshot.projectId !== snapshot.projectId,
    },
    {
      key: "concurrencyPolicy",
      label: t("task-components:concurrency_8708492f"),
      value: snapshot.concurrencyPolicy.replaceAll("_", " "),
      differs: !!currentSnapshot && currentSnapshot.concurrencyPolicy !== snapshot.concurrencyPolicy,
    },
    {
      key: "catchUpPolicy",
      label: t("task-components:catchUp_1c2d0f8e"),
      value: snapshot.catchUpPolicy.replaceAll("_", " "),
      differs: !!currentSnapshot && currentSnapshot.catchUpPolicy !== snapshot.catchUpPolicy,
    },
    {
      key: "env",
      label: t("task-components:env_494d9aa0"),
      value: envSummary,
      differs: envDiffers,
    },
  ];

  return (
    <div className="space-y-4">
      <header className={`${cardWrapper} p-4 space-y-2`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <p className="text-sm font-medium"><Trans ns="final-components-b" i18nKey="numeric.RoutineHistoryTab.136630b66eb2_77b70" values={{ revisionNumber: revision.revisionNumber }} /></p>
            <p className="text-xs text-muted-foreground truncate"><Trans ns="task-components" i18nKey="sentence_c29b0afc4d93" components={{ part1: <>{relativeTime(revision.createdAt)}</>, part2: <>{getActorLabel(revision)}</>, part3: <>{revision.changeSummary ? ` · ${revision.changeSummary}` : ""}</> }} /></p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onCompare}>
              <Search className="mr-1.5 h-3.5 w-3.5" />{t("task-components:compareWithCurrent_095f9ab7")}</Button>
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
        <p className="pb-2 text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:structuredFields_9ad6fd58")}</p>
        <div className="grid gap-3 md:grid-cols-2 divide-y md:divide-y-0 divide-border">
          {fieldRows.map((row) => (
            <div key={row.key} className="space-y-1 p-2">
              <p className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">{row.label}</p>
              <p className="text-sm">
                {row.value || <span className="text-muted-foreground">—</span>}
                {row.differs && (
                  <Badge variant="outline" className="ml-2 border-amber-500/40 bg-amber-500/10 px-1.5 text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-amber-800 dark:text-amber-200">{t("task-components:differsFromCurrent_6f73b4b9")}</Badge>
                )}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className={`${cardWrapper} p-3 space-y-2`}>
        <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:description_526e0087")}</p>
        <div className="rounded-md bg-background/40 p-3 text-sm leading-7">
          {snapshot.description ? (
            <MarkdownBody>{snapshot.description}</MarkdownBody>
          ) : (
            <span className="text-muted-foreground">{t("task-components:noDescription_bcd8cc53")}</span>
          )}
        </div>
      </div>

      <div className={`${cardWrapper} p-3 space-y-2`}>
        <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground"><Trans ns="final-components-b" i18nKey="numeric.RoutineHistoryTab.17fb8eb46438_1a699" values={{ count: triggers.length }} /></p>
        {triggers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("task-components:noTriggersInThisRevision_30a4fef6")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {triggers.map((trigger) => (
              <li key={trigger.id} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline" className="border-border text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                  {trigger.kind}
                </Badge>
                <span className="font-medium">{trigger.label ?? trigger.kind}</span>
                <span className="text-xs text-muted-foreground">
                  {summarizeTriggerSnapshot(trigger)}
                </span>
                <span
                  className={`ml-auto text-xs ${trigger.enabled ? "text-emerald-400" : "text-muted-foreground"}`}
                >
                  {trigger.enabled ? t("task-components:enabled_fb9cf756") : t("final-components-b:RoutineHistoryTab.disabled_17eb3c")}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t("task-components:webhookSecretsAreNotStoredInRevisions_a2c8439f")}</p>
      </div>

      {snapshot.variables.length > 0 && (
        <div className={`${cardWrapper} p-3 space-y-2`}>
          <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground"><Trans ns="final-components-b" i18nKey="numeric.RoutineHistoryTab.8a20256f7739_7f705" values={{ count: snapshot.variables.length }} /></p>
          <ul className="divide-y divide-border">
            {snapshot.variables.map((variable) => (
              <li key={variable.name} className="py-2 flex items-center justify-between text-sm">
                <span className="font-mono text-xs">{variable.name}</span>
                <span className="text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_7e37ba1a3199" components={{ part1: <>{formatVariableDefault(variable)}</> }} /></span>
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
  useTranslation("task-components");
  const newRevisionNumber = currentRevisionNumber + 1;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle><Trans ns="final-components-b" i18nKey="numeric.RoutineHistoryTab.adee6b8f26d9_b4b87" values={{ revisionNumber: target.revisionNumber }} /></DialogTitle>
          <DialogDescription><Trans ns="final-components-b" i18nKey="numeric.RoutineHistoryTab.86c08a93aee6_2ba77" values={{ newRevisionNumber: newRevisionNumber, revisionNumber: target.revisionNumber, totalCount: target.revisionNumber, currentRevisionNumber: currentRevisionNumber }} /></DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-sm">
          <li className="flex items-start gap-2">
            <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />{t("task-components:routineFieldValuesVariablesAndScheduleCron_4e1b2bb6")}</li>
          {envDiffCounts.total > 0 && (
            <li className="flex items-start gap-2"><Trans ns="task-components" i18nKey="sentence_d3d1e7e67917" components={{ part1: <>{<span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />}</>, part2: <>{formatEnvDiffCounts(envDiffCounts)}</> }} /></li>
          )}
          <li className="flex items-start gap-2">
            <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />{t("task-components:previousRunHistoryIsPreserved_37857ccf")}</li>
          {recreatedWebhookLabels.map((label) => (
            <li key={label} className="flex items-start gap-2 text-amber-800 dark:text-amber-200"><Trans ns="task-components" i18nKey="sentence_f34fa3887d45" components={{ part1: <>{<span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />}</>, part2: <>{label}</> }} /></li>
          ))}
        </ul>
        <div className="space-y-1.5">
          <Label htmlFor="restore-change-summary" className="text-xs">{t("task-components:changeSummaryOptional_704fc4c0")}</Label>
          <Input
            id="restore-change-summary"
            value={changeSummary}
            placeholder={t("task-components:whyAreYouRestoringVisibleInHistory_9093cbf2")}
            onChange={(event) => onChangeSummaryChange(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>{t("task-components:cancel_19766ed6")}</Button>
          <Button onClick={onConfirm} disabled={pending}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {pending ? t("task-components:restoring_5a4918e0") : t("task-components:restoreAsRevision_2902fad0", { value1: newRevisionNumber })}
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
  useTranslation("task-components");
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
    () => (left && right ? computeFieldChanges(left, right, agents, projects, secrets) : []),
    [left, right, agents, projects, secrets, i18n.resolvedLanguage],
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
      <DialogContent className="!max-w-(--pct-90) w-full max-h-(--sz-85vh) overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("task-components:compareRoutineRevisions_53caf5e9")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-3">
          <RevisionPicker
            label={t("task-components:old_bca97160")}
            value={leftId}
            onChange={setLeftId}
            revisions={revisions}
            tone="red"
          />
          <RevisionPicker
            label={t("task-components:new_18fdd549")}
            value={rightId}
            onChange={setRightId}
            revisions={revisions}
            tone="green"
          />
        </div>
        <div className="overflow-auto flex-1 space-y-4">
          <section className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:fieldChanges_ecfa72a2")}</p>
            {fieldChanges.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("task-components:noStructuralFieldChanges_d9af89b8")}</p>
            ) : (
              <table className="w-full text-sm border border-border rounded-md overflow-hidden">
                <thead>
                  <tr className="text-xs uppercase tracking-wide bg-muted/30 text-muted-foreground">
                    <th className="px-3 py-2 text-left">{t("task-components:field_f45fc1df")}</th>
                    <th className="px-3 py-2 text-left">{t("task-components:oldValue_a7c253b4")}</th>
                    <th className="px-3 py-2 text-left">{t("task-components:newValue_7ca9b97d")}</th>
                  </tr>
                </thead>
                <tbody>
                  {fieldChanges.map((change) => (
                    <tr key={change.field} className="border-t border-border/60">
                      <td className="px-3 py-2 align-top text-xs font-medium">{change.field}</td>
                      <td className="px-3 py-2 align-top text-xs text-red-700 dark:text-red-300">
                        {change.oldValue ?? "—"}
                      </td>
                      <td className="px-3 py-2 align-top text-xs text-emerald-700 dark:text-emerald-300">
                        {change.newValue ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:descriptionDiff_0ec05d96")}</p>
            <DiffTable rows={descriptionDiff} />
          </section>
        </div>
        <DialogFooter className="justify-between sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("task-components:close_7d9eb7ac")}</Button>
          {leftIsHistorical && left && (
            <Button onClick={() => onRestore(left)}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {t("final-components-b:Restore_rev_revision_as_new_revision_10cf3f", { revision: left.revisionNumber })}
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
  useTranslation("task-components");
  const toneClass = tone === "red"
    ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
    : "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300";
  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline"
        className={`text-(length:--text-nano) uppercase tracking-wider ${toneClass}`}
      >
        {label}
      </Badge>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 min-w-(--sz-12rem) rounded-md border border-border/60 bg-background px-2 text-xs"
      >
        {revisions.map((revision) => (
          <option key={revision.id} value={revision.id}><Trans ns="final-components-b" i18nKey="numeric.RoutineHistoryTab.a75e7ba95bff_77b70" values={{ revisionNumber: revision.revisionNumber }} components={{ part2: <>{relativeTime(revision.createdAt)}</>, part3: <>{revision.changeSummary ? ` • ${revision.changeSummary}` : ""}</> }} /></option>
        ))}
      </select>
    </div>
  );
}

function DiffTable({ rows }: { rows: DiffRow[] }) {
  useTranslation("task-components");
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("task-components:noDescriptionOnEitherRevision_010f554f")}</p>;
  }
  if (rows.every((row) => row.kind === "context")) {
    return <p className="text-sm text-muted-foreground">{t("task-components:descriptionsAreIdentical_5982a8d2")}</p>;
  }
  const lineClassesByKind: Record<DiffRow["kind"], string> = {
    context: "bg-transparent",
    removed: "bg-red-500/10 text-red-900 dark:text-red-100",
    added: "bg-green-500/10 text-green-900 dark:text-green-100",
  };
  const markerByKind: Record<DiffRow["kind"], string> = {
    context: " ",
    removed: "-",
    added: "+",
  };
  return (
    <div className="rounded-md border border-border text-xs font-mono leading-6 overflow-hidden">
      <div className="grid grid-cols-(--gtc-1) border-b border-border/60 bg-muted/30 px-3 py-2 text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
        <span>{t("task-components:old_bca97160")}</span>
        <span>{t("task-components:new_18fdd549")}</span>
        <span />
        <span>{t("task-components:content_47bd2907")}</span>
      </div>
      {rows.map((row, index) => (
        <div
          key={`${row.kind}-${index}-${row.oldLineNumber ?? "x"}-${row.newLineNumber ?? "x"}`}
          className={`grid grid-cols-(--gtc-1) gap-0 border-b border-border/30 px-3 ${lineClassesByKind[row.kind]}`}
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

function getActorLabel(revision: RoutineRevision): string {
  if (revision.createdByUserId) return t("task-components:board_859169b3");
  if (revision.createdByAgentId) return t("task-components:agent_d4f0bc5a");
  return t("task-components:system_bbc5e661");
}

function resolveAgentName(agentId: string | null, lookup: AgentLookup) {
  if (!agentId) return t("final-components-b:Unassigned_14d33b");
  return lookup.get(agentId)?.name ?? agentId;
}

function resolveProjectName(projectId: string | null, lookup: ProjectLookup) {
  if (!projectId) return t("final-components-b:No_project_f34c2b");
  return lookup.get(projectId)?.name ?? projectId;
}

function summarizeTriggerSnapshot(trigger: RoutineRevisionSnapshotTriggerV1): string {
  if (trigger.kind === "schedule") {
    return [trigger.cronExpression, trigger.timezone].filter(Boolean).join(" · ");
  }
  if (trigger.kind === "webhook") {
    const replay = trigger.replayWindowSec != null ? `replay ${trigger.replayWindowSec}s` : "";
    return [trigger.signingMode, replay].filter(Boolean).join(" · ");
  }
  return "API";
}

function displayTriggerSnapshot(trigger: RoutineRevisionSnapshotTriggerV1): string {
  if (trigger.kind === "schedule") {
    return [trigger.cronExpression, trigger.timezone].filter(Boolean).join(" · ");
  }
  if (trigger.kind === "webhook") {
    const replay = trigger.replayWindowSec != null ? t("final-components-b:replay_seconds_s_0053f5", { seconds: trigger.replayWindowSec }) : "";
    return [trigger.signingMode, replay].filter(Boolean).join(" · ");
  }
  return "API";
}

function formatVariableDefault(variable: RoutineVariable): string {
  if (variable.defaultValue == null) return "—";
  return String(variable.defaultValue);
}

function formatDirtyFieldList(labels: string[]): string {
  if (labels.length === 0) return t("final-components-b:RoutineHistoryTab.the_routine_af1ec2");
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return t("final-components-b:first_and_last_35feea", { first: labels[0], last: labels[1] });
  return t("final-components-b:rest_and_last_4225d2", { rest: labels.slice(0, -1).join(i18n.resolvedLanguage === "zh-CN" ? "、" : ", "), last: labels[labels.length - 1] });
}

function collectWebhookTriggerDifferences(
  target: RoutineRevision,
  current: RoutineRevision,
): string[] {
  const currentIds = new Set(current.snapshot.triggers.map((t) => t.id));
  return target.snapshot.triggers
    .filter((trigger) => trigger.kind === "webhook" && !currentIds.has(trigger.id))
    .map((trigger) => trigger.label ?? t("final-components-b:RoutineHistoryTab.webhook_9fd09d"));
}

function describeSnapshotField(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}


const SNAPSHOT_ENUM_KEYS: Record<string, Record<string, string>> = {
  "priority": {
    "critical": "final-components-b:history.priority.critical_a2eae8",
    "high": "final-components-b:history.priority.high_caceca",
    "medium": "final-components-b:history.priority.medium_b4a9db",
    "low": "final-components-b:history.priority.low_558d47"
  },
  "status": {
    "active": "final-components-b:history.status.active_2aac20",
    "paused": "final-components-b:history.status.paused_b1856c",
    "archived": "final-components-b:history.status.archived_94efb4",
    "draft": "final-components-b:history.status.draft_15dc63"
  },
  "concurrencyPolicy": {
    "coalesce_if_active": "final-components-b:history.concurrencyPolicy.coalesce_if_active_941b10",
    "always_enqueue": "final-components-b:history.concurrencyPolicy.always_enqueue_6dc77f",
    "skip_if_active": "final-components-b:history.concurrencyPolicy.skip_if_active_985d51"
  },
  "catchUpPolicy": {
    "skip_missed": "final-components-b:history.catchUpPolicy.skip_missed_869e98",
    "enqueue_missed_with_cap": "final-components-b:history.catchUpPolicy.enqueue_missed_with_cap_f49b7b"
  }
};

function computeFieldChanges(
  left: RoutineRevision,
  right: RoutineRevision,
  agents: AgentLookup,
  projects: ProjectLookup,
  secrets: SecretLookup,
): Array<{ field: string; oldValue: string | null; newValue: string | null }> {
  const oldRoutine = left.snapshot.routine;
  const newRoutine = right.snapshot.routine;
  const changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
  const compareScalar = (
    _field: string,
    label: string,
    oldVal: unknown,
    newVal: unknown,
    transform: (value: unknown) => string = (value) => {
      const keys = SNAPSHOT_ENUM_KEYS[_field];
      return typeof value === "string" && keys && Object.hasOwn(keys, value) ? t(keys[value]) : describeSnapshotField(value);
    },
  ) => {
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({ field: label, oldValue: transform(oldVal), newValue: transform(newVal) });
    }
  };
  compareScalar("title", t("final-components-b:Title_7e8cd2"), oldRoutine.title, newRoutine.title);
  compareScalar("priority", t("final-components-b:Priority_d60dbb"), oldRoutine.priority, newRoutine.priority);
  compareScalar(
    "assigneeAgentId",
    t("final-components-b:Default_agent_94da52"),
    resolveAgentName(oldRoutine.assigneeAgentId, agents),
    resolveAgentName(newRoutine.assigneeAgentId, agents),
  );
  compareScalar(
    "projectId",
    t("final-components-b:Project_985959"),
    resolveProjectName(oldRoutine.projectId, projects),
    resolveProjectName(newRoutine.projectId, projects),
  );
  compareScalar("concurrencyPolicy", t("final-components-b:Concurrency_870849"), oldRoutine.concurrencyPolicy, newRoutine.concurrencyPolicy);
  compareScalar("catchUpPolicy", t("final-components-b:Catch_up_1c2d0f"), oldRoutine.catchUpPolicy, newRoutine.catchUpPolicy);
  compareScalar("status", t("final-components-b:Status_920e41"), oldRoutine.status, newRoutine.status);
  if (JSON.stringify(oldRoutine.variables) !== JSON.stringify(newRoutine.variables)) {
    changes.push({
      field: t("final-components-b:Variables_02db55"),
      oldValue: summarizeVariables(oldRoutine.variables),
      newValue: summarizeVariables(newRoutine.variables),
    });
  }
  compareEnv(oldRoutine.env ?? null, newRoutine.env ?? null, secrets, changes);
  compareTriggers(left.snapshot.triggers, right.snapshot.triggers, changes);
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

function formatVersionSelector(version: SecretVersionSelector | undefined): string {
  if (version == null || version === "latest") return t("task-components:latest_5e1e2bca");
  return `v${version}`;
}

function describeSecretRef(ref: EnvSecretRefBinding, secrets: SecretLookup): string {
  const secret = secrets.get(ref.secretId);
  const name = secret?.name ?? t("final-components-b:missing_secret_5a9ab2");
  return `${name} ${formatVersionSelector(ref.version)}`;
}

function describeEnvBinding(binding: EnvBinding | undefined, secrets: SecretLookup): string {
  if (binding === undefined) return "—";
  const ref = asSecretRef(binding);
  if (ref) return `secret_ref → ${describeSecretRef(ref, secrets)}`;
  return t("final-components-b:plain_set_713958");
}

function summarizeEnv(env: RoutineEnvConfig | null): string {
  const entries = Object.entries(normalizeEnv(env));
  if (entries.length === 0) return "";
  const secretCount = entries.filter(([, binding]) => envBindingKind(binding) === "secret_ref").length;
  if (secretCount === 0) return t("final-components-b:count_keys_c772a3", { count: entries.length });
  return t(secretCount === 1 ? "integration-regressions:envOneSecret" : "integration-regressions:envManySecrets", { count: entries.length, secretCount });
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

function formatEnvDiffCounts(counts: EnvDiffCounts): string {
  const parts: string[] = [];
  if (counts.added > 0) parts.push(t("final-components-b:count_keys_added_0a1f36", { count: counts.added }));
  if (counts.removed > 0) parts.push(t("final-components-b:count_keys_removed_946a3b", { count: counts.removed }));
  if (counts.changed > 0) parts.push(t("final-components-b:count_keys_changed_5e1c94", { count: counts.changed }));
  return parts.join(", ");
}

function compareEnv(
  oldEnv: RoutineEnvConfig | null,
  newEnv: RoutineEnvConfig | null,
  secrets: SecretLookup,
  changes: Array<{ field: string; oldValue: string | null; newValue: string | null }>,
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
        field: t("final-components-b:Env_added_name_67601d", { name: key }),
        oldValue: "—",
        newValue: describeEnvBinding(newBinding, secrets),
      });
      continue;
    }
    if (!inNew && inOld) {
      changes.push({
        field: t("final-components-b:Env_removed_name_82e15d", { name: key }),
        oldValue: describeEnvBinding(oldBinding, secrets),
        newValue: "—",
      });
      continue;
    }
    if (JSON.stringify(oldBinding) === JSON.stringify(newBinding)) continue;
    const oldKind = envBindingKind(oldBinding);
    const newKind = envBindingKind(newBinding);
    if (oldKind !== newKind) {
      changes.push({
        field: t("final-components-b:Env_name_binding_kind_790d99", { name: key }),
        oldValue: describeEnvBinding(oldBinding, secrets),
        newValue: describeEnvBinding(newBinding, secrets),
      });
      continue;
    }
    if (newKind === "secret_ref") {
      const oldRef = asSecretRef(oldBinding)!;
      const newRef = asSecretRef(newBinding)!;
      if (oldRef.secretId !== newRef.secretId) {
        changes.push({
          field: t("final-components-b:Env_name_secret_491998", { name: key }),
          oldValue: describeEnvBinding(oldBinding, secrets),
          newValue: describeEnvBinding(newBinding, secrets),
        });
        continue;
      }
      changes.push({
        field: t("final-components-b:Env_name_version_d4e40f", { name: key }),
        oldValue: describeSecretRef(oldRef, secrets),
        newValue: describeSecretRef(newRef, secrets),
      });
      continue;
    }
    changes.push({
      field: t("final-components-b:Env_name_value_0cbc0e", { name: key }),
      oldValue: t("final-components-b:plain_set_713958"),
      newValue: t("final-components-b:plain_changed_63c9e0"),
    });
  }
}

function summarizeVariables(variables: RoutineVariable[]): string {
  if (variables.length === 0) return t("final-components-b:RoutineHistoryTab.none_552e42");
  return variables
    .map((variable) => `${variable.name}=${formatVariableDefault(variable)}`)
    .join(", ");
}

function compareTriggers(
  oldTriggers: RoutineRevisionSnapshotTriggerV1[],
  newTriggers: RoutineRevisionSnapshotTriggerV1[],
  changes: Array<{ field: string; oldValue: string | null; newValue: string | null }>,
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
        field: t("final-components-b:Trigger_removed_trigger_9063cd", { trigger: pair.old.label ?? pair.old.kind }),
        oldValue: displayTriggerSnapshot(pair.old),
        newValue: null,
      });
    } else if (!pair.old && pair.next) {
      changes.push({
        field: t("final-components-b:Trigger_added_trigger_f67705", { trigger: pair.next.label ?? pair.next.kind }),
        oldValue: null,
        newValue: displayTriggerSnapshot(pair.next),
      });
    } else if (pair.old && pair.next) {
      const oldSummary = summarizeTriggerSnapshot(pair.old);
      const newSummary = summarizeTriggerSnapshot(pair.next);
      if (oldSummary !== newSummary || pair.old.enabled !== pair.next.enabled) {
        changes.push({
          field: t("final-components-b:Trigger_trigger_b5806c", { trigger: pair.next.label ?? pair.next.kind }),
          oldValue: `${displayTriggerSnapshot(pair.old)} (${pair.old.enabled ? t("final-components-b:enabled_fb9cf7") : t("final-components-b:RoutineHistoryTab.disabled_17eb3c")})`,
          newValue: `${displayTriggerSnapshot(pair.next)} (${pair.next.enabled ? t("final-components-b:enabled_fb9cf7") : t("final-components-b:RoutineHistoryTab.disabled_17eb3c")})`,
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
