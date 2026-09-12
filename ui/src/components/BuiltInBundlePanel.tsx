import { t, useTranslation } from "@/i18n";
import type { ReactNode } from "react";

import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ResourceStatusChip, type ResourceStatusVariant } from "@/components/ResourceStatusChip";
import { cn } from "@/lib/utils";
import type {
  BuiltInAgentState,
  BuiltInManagedResourceKind,
  BuiltInManagedResourceState,
} from "@/api/builtInAgents";

/**
 * Bundle status panel for a bundle-backed built-in agent (Reflection Coach —
 * [PAP-13099], ux-spec §3–§8). Renders one row per managed resource
 * (adapter · skill · instructions · routine, dependency order) with a readiness
 * chip, drift chip, inline copy, and the wireable per-resource actions.
 *
 * Presentational: the parent owns queries/mutations and passes handlers. The
 * confirm-before-mutate dialogs and copy live here (ux-spec §8). Adapter
 * readiness is derived from the agent lifecycle `status` (there is no adapter
 * resource in `resources[]`); skill/instructions/routine come from
 * `state.resources`.
 *
 * Both "apply an available stock update" and "reset drifted edits" route
 * through the same scoped reset (`onResetResource(kind)` →
 * `built-in-agents/:key/reset { resources: [kind] }`), which re-materializes
 * that one resource to Paperclip's newest shipped default without touching
 * adapter credentials or the other resources.
 */

function findResource(
  resources: BuiltInManagedResourceState[] | undefined,
  kind: BuiltInManagedResourceKind,
): BuiltInManagedResourceState | undefined {
  return resources?.find((resource) => resource.resourceKind === kind);
}

// Only known stock display copy is localized; custom or changed server text stays verbatim.
function bundleDisplayText(key: string, field: "routineTitle" | "scheduleLabel", source: string): string {
  if (key !== "reflection-coach") return source;
  if (field === "routineTitle" && source === "Review recent agent trajectories for coaching proposals") {
    return t("localizationAgentManagement.reflectionRoutineTitle");
  }
  if (field === "scheduleLabel" && source === "Weekly · Mon 09:00 UTC") {
    return t("localizationAgentManagement.reflectionSchedule");
  }
  return source;
}

/** Readiness chip for a materialized resource. */
function readinessVariant(resource: BuiltInManagedResourceState): ResourceStatusVariant {
  if (resource.stockStatus === "missing") return "missing";
  return "ready";
}

/** Drift chip shown alongside a `ready` readiness chip, or `null`. */
function driftVariant(resource: BuiltInManagedResourceState): ResourceStatusVariant | null {
  if (resource.stockStatus === "missing") return null; // readiness wins; drift suppressed
  if (resource.stockStatus === "stock_update_available") return "update_available";
  if (resource.stockStatus === "operator_modified") return "drifted";
  return null;
}

interface ResourceActionCopy {
  title: string;
  body: string;
  confirmLabel: string;
  triggerLabel: string;
}

/** Confirm-dialog copy per drift state (ux-spec §8 copy deck). */
function resourceActionCopy(
  resource: BuiltInManagedResourceState,
  label: string,
): ResourceActionCopy | null {
  if (resource.stockStatus === "stock_update_available") {
    return {
      title: t("localizationAgentManagement.updateResourceTitle", { label }),
      body: t("localizationAgentManagement.updateResourceBody"),
      confirmLabel: t("pages.secrets.actions.update"),
      triggerLabel: t("pages.secrets.actions.update"),
    };
  }
  if (resource.stockStatus === "operator_modified") {
    return {
      title: t("localizationAgentManagement.resetResourceTitle", { label }),
      body: t("localizationAgentManagement.resetResourceBody"),
      confirmLabel: t("localizationAgentManagement.resetResourceConfirm", { label }),
      triggerLabel: t("workspaces.actions.reset"),
    };
  }
  if (resource.stockStatus === "missing") {
    return {
      title: t("localizationAgentManagement.recreateResourceTitle", { label }),
      body: t("localizationAgentManagement.recreateResourceBody"),
      confirmLabel: t("localizationAgentManagement.recreate162"),
      triggerLabel: t("localizationAgentManagement.recreate162"),
    };
  }
  return null;
}

function ResourceActionButton({
  resource,
  label,
  onConfirm,
  pending,
}: {
  resource: BuiltInManagedResourceState;
  label: string;
  onConfirm: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const copy = resourceActionCopy(resource, label);
  if (!copy) return null;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={pending}>
          {pending ? t("pages.auth.working") : copy.triggerLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("pages.cliAuth.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{copy.confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConfirmActionButton({
  title,
  body,
  triggerLabel,
  confirmLabel,
  pending,
  onConfirm,
}: {
  title: string;
  body: string;
  triggerLabel: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={pending}>
          {pending ? t("pages.auth.working") : triggerLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("pages.cliAuth.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface BundleRowProps {
  label: string;
  secondary?: string;
  chips: ReactNode;
  detail?: ReactNode;
  detailTone?: "muted" | "error";
  actions?: ReactNode;
}

function BundleRow({ label, secondary, chips, detail, detailTone = "muted", actions }: BundleRowProps) {
  useTranslation();
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {secondary && (
            <span className="text-(length:--text-micro) text-muted-foreground">{secondary}</span>
          )}
          {chips}
        </div>
        {detail && (
          <p
            className={cn(
              "text-(length:--text-micro) leading-snug",
              detailTone === "error" ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
            )}
          >
            {detail}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

function driftDetail(resource: BuiltInManagedResourceState): string | undefined {
  switch (resource.stockStatus) {
    case "operator_modified":
      return t("localizationAgentManagement.youVeEditedThisYourChangesAreKeptUntilYouReset163");
    case "stock_update_available":
      return t("localizationAgentManagement.paperclipShippedANewerDefault164");
    case "missing":
      return t("localizationAgentManagement.notMaterializedYetRecreateItFromTheShippedDefault165");
    default:
      return undefined;
  }
}

export interface BuiltInBundlePanelProps {
  state: BuiltInAgentState;
  /** Route ref used to link View › actions to the agent's tabs. */
  agentRef: string;
  /** Opens the adapter configure modal. */
  onConfigure: () => void;
  /** Scoped reset for one resource (apply update / reset drift / recreate). */
  onResetResource: (kind: BuiltInManagedResourceKind) => void;
  /** Trigger the managed routine once without enabling its weekly schedule. */
  onRunRoutine?: (routineKey: string) => void;
  /** Enable the managed routine's weekly schedule. */
  onEnableSchedule?: (routineKey: string) => void;
  /** Disable the managed routine's weekly schedule. */
  onDisableSchedule?: (routineKey: string) => void;
  /** The resource kind whose reset is currently in flight, if any. */
  resettingResource?: BuiltInManagedResourceKind | null;
  routineActionPending?: "run" | "enable" | "disable" | null;
  className?: string;
}

export function BuiltInBundlePanel({
  state,
  agentRef,
  onConfigure,
  onResetResource,
  onRunRoutine,
  onEnableSchedule,
  onDisableSchedule,
  resettingResource = null,
  routineActionPending = null,
  className,
}: BuiltInBundlePanelProps) {
  const { t } = useTranslation();
  const { status, definition, resources } = state;
  const bundle = definition.bundle;
  if (!bundle) return null;

  const adapterReady = status === "ready" || status === "paused";

  // --- Adapter row (derived from the agent lifecycle status) -----------------
  let adapterChip: ResourceStatusVariant = "ready";
  let adapterDetail: string | undefined;
  if (status === "pending_approval") {
    adapterChip = "pending_approval";
    adapterDetail = t("localizationAgentManagement.waitingOnBoardHireApprovalBeforeThisCoachCanRun166");
  } else if (!adapterReady) {
    adapterChip = "needs_setup";
    adapterDetail = t("localizationAgentManagement.pickAnAdapterThisCoachCanRunOn167");
  }

  const skill = findResource(resources, "skill");
  const instructions = findResource(resources, "instructions");
  const routine = findResource(resources, "routine");
  const scheduleEnabled = routine?.scheduleEnabled === true;
  const routineKey = bundle.routine.routineKey;
  const scheduleLabel = bundle.routine.scheduleLabel
    ? bundleDisplayText(definition.key, "scheduleLabel", bundle.routine.scheduleLabel)
    : t("localizationAgentManagement.weeklySchedule168");
  const proposalIssueRef = routine?.pendingUpdateIssueIdentifier ?? routine?.pendingUpdateIssueId ?? null;
  const proposalHref = proposalIssueRef && routine?.pendingUpdateInteractionId
    ? `/issues/${proposalIssueRef}#interaction-${routine.pendingUpdateInteractionId}`
    : null;

  const renderResourceRow = (
    kind: BuiltInManagedResourceKind,
    label: string,
    secondary: string,
    viewHref: string,
    resource: BuiltInManagedResourceState,
  ) => {
    const drift = driftVariant(resource);
    return (
      <BundleRow
        key={kind}
        label={label}
        secondary={secondary}
        chips={
          <>
            <ResourceStatusChip variant={readinessVariant(resource)} />
            {drift && <ResourceStatusChip variant={drift} />}
          </>
        }
        detail={driftDetail(resource)}
        actions={
          <>
            <Button asChild variant="link" size="sm">
              <Link to={viewHref}>{t("localizationSkills.view220")}</Link>
            </Button>
            <ResourceActionButton
              resource={resource}
              label={label}
              onConfirm={() => onResetResource(kind)}
              pending={resettingResource === kind}
            />
          </>
        }
      />
    );
  };

  return (
    <section className={cn("space-y-2", className)} aria-label={t("localizationAgentManagement.bundleStatus169")}>
      <h3 className="text-sm font-medium">{t("localizationAgentManagement.bundleStatus169")}</h3>

      <div className="divide-y rounded-lg border px-4">
        {/* Adapter — no resource entry; readiness is the agent lifecycle. */}
        <BundleRow
          label={t("localizationAgents.ui38_Adapter")}
          chips={<ResourceStatusChip variant={adapterChip} />}
          detail={adapterDetail}
          actions={
            <Button variant="outline" size="sm" onClick={onConfigure}>{t("localizationRoutines.configure")}</Button>
          }
        />

        {skill &&
          renderResourceRow(
            "skill",
            t("localizationSkills.skill615"),
            bundle.skill.displayName || skill.resourceKey,
            `/agents/${agentRef}/skills`,
            skill,
          )}

        {instructions &&
          renderResourceRow(
            "instructions",
            t("pages.agentDetail.breadcrumbInstructions"),
            bundle.instructions.entryFile,
            `/agents/${agentRef}/instructions`,
            instructions,
          )}

        {/* Routine — zero-token-by-default; the weekly schedule ships off. */}
        <BundleRow
          label={t("pages.secrets.targets.routine")}
          secondary={bundleDisplayText(definition.key, "routineTitle", bundle.routine.title)}
          chips={
            <>
              <ResourceStatusChip
                variant={scheduleEnabled ? "schedule_on" : "schedule_off"}
                label={scheduleEnabled ? scheduleLabel : undefined}
              />
              {routine && driftVariant(routine) && (
                <ResourceStatusChip variant={driftVariant(routine)!} />
              )}
            </>
          }
          detail={
            scheduleEnabled
              ? t("localizationAgentManagement.theWeeklyScheduleIsEnabledAndCanCreateBackgroundWork174")
              : t("localizationAgentManagement.nothingRunsUntilYouEnableTheWeeklyScheduleItCostsZeroTo175")
          }
          actions={
            routine ? (
              <>
                {onRunRoutine && (
                  <ConfirmActionButton
                    title={t("localizationAgentManagement.runReflectionCoachOnce176")}
                    body={t("localizationAgentManagement.paperclipWillCreateOneRoutineTaskNowThisDoesNotEnableTh177")}
                    triggerLabel={t("localizationAgentManagement.runOnce178")}
                    confirmLabel={t("localizationAgentManagement.runOnce178")}
                    pending={routineActionPending === "run"}
                    onConfirm={() => onRunRoutine(routineKey)}
                  />
                )}
                {scheduleEnabled
                  ? onDisableSchedule && (
                    <ConfirmActionButton
                      title={t("localizationAgentManagement.disableTheWeeklySchedule179")}
                      body={t("localizationAgentManagement.paperclipWillStopFutureScheduledReflectionCoachRunsManu180")}
                      triggerLabel={t("localizationAgentManagement.disableSchedule181")}
                      confirmLabel={t("localizationAgentManagement.disableSchedule181")}
                      pending={routineActionPending === "disable"}
                      onConfirm={() => onDisableSchedule(routineKey)}
                    />
                  )
                  : onEnableSchedule && (
                    <ConfirmActionButton
                      title={t("localizationAgentManagement.enableTheWeeklySchedule182")}
                      body={t("localizationAgentManagement.paperclipWillAllowReflectionCoachToCreateRoutineTasksOn183")}
                      triggerLabel={t("localizationAgentManagement.enableWeekly184")}
                      confirmLabel={t("localizationAgentManagement.enableWeekly184")}
                      pending={routineActionPending === "enable"}
                      onConfirm={() => onEnableSchedule(routineKey)}
                    />
                  )}
                {driftVariant(routine) && (
                  <ResourceActionButton
                    resource={routine}
                    label={t("localizationAgentManagement.routineResource")}
                    onConfirm={() => onResetResource("routine")}
                    pending={resettingResource === "routine"}
                  />
                )}
              </>
            ) : undefined
          }
        />
        {proposalHref && (
          <BundleRow
            label={t("localizationAgentManagement.proposal185")}
            chips={<ResourceStatusChip variant="proposal_pending" />}
            detail={t("localizationAgentManagement.aProposedReflectionCoachUpdateIsWaitingForReview186")}
            actions={
              <Button asChild variant="link" size="sm">
                <Link to={proposalHref}>{t("localizationAgentManagement.reviewProposal187")}</Link>
              </Button>
            }
          />
        )}
      </div>
    </section>
  );
}
