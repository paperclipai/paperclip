import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Braces,
  Clock3,
  Edit3,
  KeyRound,
  Play,
  Plus,
  X,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { cn } from "@/lib/utils";
import { t, useTranslation } from "@/i18n";
import { nextCronFires, previewFirePolicies } from "../../lib/cron-fires";
import { timeAgo } from "../../lib/timeAgo";
import { EmptyState } from "../EmptyState";
import { InlineEntitySelector } from "../InlineEntitySelector";
import { AgentIcon } from "../AgentIconPicker";
import { MarkdownEditor } from "../MarkdownEditor";
import { ScheduleEditor, getScheduleCronValidation } from "../ScheduleEditor";
import { RoutineVariablesEditor, RoutineVariablesHint } from "../RoutineVariablesEditor";
import { RoutineTriggerCard } from "../RoutineTriggerCard";
import { EnvVarEditor } from "../EnvVarEditor";
import { createDefaultNewTrigger, useRoutineDetail } from "./context";
import type { EnvBinding, RoutineDetail as RoutineDetailType } from "@paperclipai/shared";

const getConcurrencyPolicyOptions = () => [
  {
    value: "coalesce_if_active",
    title: t("components.editableSections.concurrencyCoalesceTitle", {
      defaultValue: "Coalesce if active",
    }),
    description: t("components.editableSections.concurrencyCoalesceDescription", {
      defaultValue: "Keep one follow-up run queued while an active run is still working.",
    }),
  },
  {
    value: "always_enqueue",
    title: t("components.editableSections.concurrencyAlwaysTitle", {
      defaultValue: "Always enqueue",
    }),
    description: t("components.editableSections.concurrencyAlwaysDescription", {
      defaultValue: "Queue every trigger occurrence, even if several runs stack up.",
    }),
  },
  {
    value: "skip_if_active",
    title: t("components.editableSections.concurrencySkipTitle", {
      defaultValue: "Skip if active",
    }),
    description: t("components.editableSections.concurrencySkipDescription", {
      defaultValue: "Drop overlapping trigger occurrences while the routine is already active.",
    }),
  },
];

const getCatchUpPolicyOptions = () => [
  {
    value: "skip_missed",
    title: t("components.editableSections.catchUpSkipTitle", {
      defaultValue: "Skip missed",
    }),
    description: t("components.editableSections.catchUpSkipDescription", {
      defaultValue: "Ignore schedule windows that were missed while paused.",
    }),
  },
  {
    value: "enqueue_missed_with_cap",
    title: t("components.editableSections.catchUpEnqueueTitle", {
      defaultValue: "Enqueue missed with cap",
    }),
    description: t("components.editableSections.catchUpEnqueueDescription", {
      defaultValue: "Catch up missed schedule windows in capped batches after recovery.",
    }),
  },
];

const triggerKinds = ["schedule", "webhook"];
const signingModes = ["bearer", "hmac_sha256", "github_hmac", "none"];
const getSigningModeDescriptions = (): Record<string, string> => ({
  bearer: t("components.editableSections.signingModeBearer", {
    defaultValue: "Expect a shared bearer token in the Authorization header.",
  }),
  hmac_sha256: t("components.editableSections.signingModeHmacSha256", {
    defaultValue: "Expect an HMAC SHA-256 signature over the request using the shared secret.",
  }),
  github_hmac: t("components.editableSections.signingModeGithubHmac", {
    defaultValue: "Accept GitHub-style X-Hub-Signature-256 header (HMAC over raw body, no timestamp).",
  }),
  none: t("components.editableSections.signingModeNone", {
    defaultValue: "No authentication — the webhook URL itself acts as a shared secret.",
  }),
});
const SIGNING_MODES_WITHOUT_REPLAY_WINDOW = new Set(["github_hmac", "none"]);

export function OverviewSection() {
  const { t } = useTranslation();
  const ctx = useRoutineDetail();
  const {
    routine,
    editDraft,
    setEditDraft,
    assigneeOptions,
    projectOptions,
    recentAssigneeIds,
    recentProjectIds,
    agentById,
    projectById,
    currentAssignee,
    currentProject,
    mentionOptions,
    assigneeSelectorRef,
    projectSelectorRef,
    descriptionEditorRef,
    routineRuns,
    activity,
    saveRoutine,
    navigateToSection,
  } = ctx;

  const activeTriggers = routine.triggers.length;
  const nextFire = useMemo(() => {
    const upcoming = routine.triggers
      .filter((trigger) => trigger.kind === "schedule" && trigger.nextRunAt)
      .map((trigger) => new Date(trigger.nextRunAt as Date))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return upcoming ? upcoming.toLocaleString() : null;
  }, [routine.triggers]);
  const boundSecrets = editDraft.env ? Object.keys(editDraft.env).length : 0;
  const lastRun = (routineRuns ?? [])[0] ?? null;
  const recentActivity = (activity ?? []).slice(0, 5);

  return (
    <div className="space-y-6">
      {/* Assignment row */}
      <div className="overflow-x-auto overscroll-x-contain">
        <div className="inline-flex min-w-full flex-wrap items-center gap-2 text-sm text-muted-foreground sm:min-w-max sm:flex-nowrap">
          <span>{t("components.editableSections.assignmentFor", { defaultValue: "For" })}</span>
          <InlineEntitySelector
            ref={assigneeSelectorRef}
            value={editDraft.assigneeAgentId}
            options={assigneeOptions}
            recentOptionIds={recentAssigneeIds}
            placeholder={t("components.editableSections.assigneePlaceholder", { defaultValue: "Assignee" })}
            noneLabel={t("components.editableSections.assigneeNoneLabel", { defaultValue: "No assignee" })}
            searchPlaceholder={t("components.editableSections.assigneeSearchPlaceholder", { defaultValue: "Search assignees..." })}
            emptyMessage={t("components.editableSections.assigneeEmptyMessage", { defaultValue: "No assignees found." })}
            onChange={(assigneeAgentId) =>
              setEditDraft((current) => ({ ...current, assigneeAgentId }))
            }
            onConfirm={() => {
              if (editDraft.projectId) {
                descriptionEditorRef.current?.focus();
              } else {
                projectSelectorRef.current?.focus();
              }
            }}
            renderTriggerValue={(option) =>
              option ? (
                currentAssignee ? (
                  <>
                    <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{option.label}</span>
                  </>
                ) : (
                  <span className="truncate">{option.label}</span>
                )
              ) : (
                <span className="text-muted-foreground">{t("components.editableSections.assigneePlaceholder", { defaultValue: "Assignee" })}</span>
              )
            }
            renderOption={(option) => {
              if (!option.id) return <span className="truncate">{option.label}</span>;
              const assignee = agentById.get(option.id);
              return (
                <>
                  {assignee ? (
                    <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
          <span>{t("components.editableSections.assignmentIn", { defaultValue: "in" })}</span>
          <InlineEntitySelector
            ref={projectSelectorRef}
            value={editDraft.projectId}
            options={projectOptions}
            recentOptionIds={recentProjectIds}
            placeholder={t("components.editableSections.projectPlaceholder", { defaultValue: "Project" })}
            noneLabel={t("components.editableSections.projectNoneLabel", { defaultValue: "No project" })}
            searchPlaceholder={t("components.editableSections.projectSearchPlaceholder", { defaultValue: "Search projects..." })}
            emptyMessage={t("components.editableSections.projectEmptyMessage", { defaultValue: "No projects found." })}
            onChange={(projectId) => setEditDraft((current) => ({ ...current, projectId }))}
            onConfirm={() => descriptionEditorRef.current?.focus()}
            renderTriggerValue={(option) =>
              option && currentProject ? (
                <>
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: currentProject.color ?? "#64748b" }}
                  />
                  <span className="truncate">{option.label}</span>
                </>
              ) : (
                <span className="text-muted-foreground">{t("components.editableSections.projectPlaceholder", { defaultValue: "Project" })}</span>
              )
            }
            renderOption={(option) => {
              if (!option.id) return <span className="truncate">{option.label}</span>;
              const project = projectById.get(option.id);
              return (
                <>
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: project?.color ?? "#64748b" }}
                  />
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
        </div>
      </div>

      {!routine.assigneeAgentId ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-900 dark:text-amber-200">
          {t("components.editableSections.defaultAgentRequired", {
            defaultValue:
              "Default agent required. This routine can stay as a draft and still run manually, but automation stays paused until you assign a default agent.",
          })}
        </div>
      ) : null}

      {/* Instructions */}
      <MarkdownEditor
        ref={descriptionEditorRef}
        value={editDraft.description}
        onChange={(description) => setEditDraft((current) => ({ ...current, description }))}
        placeholder={t("components.editableSections.instructionsPlaceholder", { defaultValue: "Add instructions..." })}
        bordered={false}
        contentClassName="min-h-[120px] text-[15px] leading-7"
        mentions={mentionOptions}
        onSubmit={() => {
          if (!saveRoutine.isPending && editDraft.title.trim()) {
            saveRoutine.mutate();
          }
        }}
      />

      {/* Variables peek */}
      <div className="space-y-3">
        <RoutineVariablesHint />
        <RoutineVariablesEditor
          title={editDraft.title}
          description={editDraft.description}
          value={editDraft.variables}
          onChange={(variables) => setEditDraft((current) => ({ ...current, variables }))}
        />
      </div>

      {/* Summary cards */}
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard
          icon={Clock3}
          label={t("components.editableSections.summaryTriggersLabel", { defaultValue: "Triggers" })}
          value={
            activeTriggers === 0
              ? t("components.editableSections.summaryNone", { defaultValue: "None" })
              : t("components.editableSections.summaryTriggersActive", {
                  count: activeTriggers,
                  defaultValue: "{{count}} active",
                })
          }
          hint={
            nextFire
              ? t("components.editableSections.summaryNextFire", {
                  time: nextFire,
                  defaultValue: "Next fire {{time}}",
                })
              : t("components.editableSections.summaryNoSchedule", { defaultValue: "No schedule" })
          }
          to={() => navigateToSection("triggers")}
          ariaLabel={t("components.editableSections.summaryTriggersAria", {
            count: activeTriggers,
            defaultValue: "{{count}} triggers. Open triggers.",
          })}
        />
        <SummaryCard
          icon={KeyRound}
          label={t("components.editableSections.summarySecretsLabel", { defaultValue: "Secrets" })}
          value={
            boundSecrets === 0
              ? t("components.editableSections.summaryNone", { defaultValue: "None" })
              : t("components.editableSections.summarySecretsBound", {
                  count: boundSecrets,
                  defaultValue: "{{count}} bound",
                })
          }
          hint={t("components.editableSections.summaryManageSecrets", { defaultValue: "Manage bound secrets" })}
          to={() => navigateToSection("secrets")}
          ariaLabel={t("components.editableSections.summarySecretsAria", {
            count: boundSecrets,
            defaultValue: "{{count}} secrets bound. Open secrets.",
          })}
        />
        <SummaryCard
          icon={Play}
          label={t("components.editableSections.summaryLastRunLabel", { defaultValue: "Last run" })}
          value={lastRun ? lastRun.status.replaceAll("_", " ") : t("components.editableSections.summaryNoRuns", { defaultValue: "No runs" })}
          hint={lastRun ? timeAgo(lastRun.triggeredAt) : t("components.editableSections.summaryTriggerRun", { defaultValue: "Trigger a run" })}
          to={() => navigateToSection("runs")}
          ariaLabel={
            lastRun
              ? t("components.editableSections.summaryLastRunAria", {
                  status: lastRun.status,
                  defaultValue: "Last run {{status}}. Open runs.",
                })
              : t("components.editableSections.summaryNoRunsAria", { defaultValue: "No runs. Open runs." })
          }
        />
      </div>

      {/* Recent activity */}
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("components.editableSections.recentActivity", { defaultValue: "Recent activity" })}
        </p>
        {recentActivity.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("components.editableSections.noActivityYet", { defaultValue: "No activity yet." })}</p>
        ) : (
          <div className="divide-y divide-border/60">
            {recentActivity.map((event) => (
              <div key={event.id} className="flex items-center gap-2 py-1.5 text-xs">
                <Badge variant="outline" className="shrink-0 font-mono">
                  {event.action}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {event.details && Object.keys(event.details).length > 0
                    ? Object.keys(event.details).slice(0, 3).join(" · ")
                    : ""}
                </span>
                <span className="shrink-0 text-muted-foreground/60">{timeAgo(event.createdAt)}</span>
              </div>
            ))}
            <button
              type="button"
              onClick={() => navigateToSection("activity")}
              className="flex items-center gap-1 pt-2 text-xs text-muted-foreground hover:text-foreground"
            >
              {t("components.editableSections.viewAllActivity", { defaultValue: "View all activity" })} <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  hint,
  to,
  ariaLabel,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
  hint: string;
  to: () => void;
  ariaLabel: string;
}) {
  return (
    <button type="button" onClick={to} aria-label={ariaLabel} className="text-left">
      <Card className="gap-2 p-4 transition-colors hover:border-border hover:bg-accent/30">
        <CardContent className="space-y-1 p-0">
          <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
            <Icon className="h-3.5 w-3.5" />
            {label}
            <ArrowRight className="ml-auto h-3.5 w-3.5 text-muted-foreground/60" />
          </div>
          <p className="text-lg font-semibold">{value}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </CardContent>
      </Card>
    </button>
  );
}

export function TriggersSection() {
  const { t } = useTranslation();
  const ctx = useRoutineDetail();
  const { routine, newTrigger, setNewTrigger, createTrigger, updateTrigger, deleteTrigger, rotateTrigger } = ctx;
  const [addOpen, setAddOpen] = useState(false);
  const signingModeDescriptions = getSigningModeDescriptions();
  const [newScheduleEditorValid, setNewScheduleEditorValid] = useState(true);
  const newScheduleValidation = useMemo(
    () => newTrigger.kind === "schedule" ? getScheduleCronValidation(newTrigger.cronExpression) : null,
    [newTrigger.cronExpression, newTrigger.kind],
  );
  const addDisabled =
    createTrigger.isPending ||
    (newScheduleValidation ? !newScheduleValidation.valid || !newScheduleEditorValid : false);

  useEffect(() => {
    if (newTrigger.kind !== "schedule") setNewScheduleEditorValid(true);
  }, [newTrigger.kind]);

  return (
    <div className="space-y-4">
      {/* Add-trigger drawer header (§3.2) */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">
          {routine.triggers.length === 0
            ? t("components.editableSections.noTriggersYetShort", { defaultValue: "No triggers yet" })
            : t("components.editableSections.triggerCount", {
                count: routine.triggers.length,
                defaultValue: "{{count}} trigger",
                defaultValue_other: "{{count}} triggers",
              })}
        </p>
        <Button
          size="sm"
          variant={addOpen ? "secondary" : "default"}
          onClick={() => setAddOpen((open) => !open)}
          aria-expanded={addOpen}
        >
          {addOpen ? (
            <>
              <X className="mr-1.5 h-3.5 w-3.5" />
              {t("components.editableSections.cancel", { defaultValue: "Cancel" })}
            </>
          ) : (
            <>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t("components.editableSections.newTrigger", { defaultValue: "New trigger" })}
            </>
          )}
        </Button>
      </div>

      {/* Add trigger form — expand-on-click drawer */}
      {addOpen ? (
      <div className="space-y-3 rounded-lg border border-border p-4">
        <p className="text-sm font-medium">{t("components.editableSections.addTrigger", { defaultValue: "Add trigger" })}</p>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("components.editableSections.kindLabel", { defaultValue: "Kind" })}</Label>
            <Select
              value={newTrigger.kind}
              onValueChange={(kind) => setNewTrigger((current) => ({ ...current, kind }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {triggerKinds.map((kind) => (
                  <SelectItem key={kind} value={kind} disabled={kind === "webhook"}>
                    {kind}
                    {kind === "webhook" ? t("components.editableSections.comingSoonSuffix", { defaultValue: " — COMING SOON" }) : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {newTrigger.kind === "schedule" && (
            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-xs">{t("components.editableSections.scheduleLabel", { defaultValue: "Schedule" })}</Label>
              <ScheduleEditor
                value={newTrigger.cronExpression}
                onChange={(cronExpression) =>
                  setNewTrigger((current) => ({ ...current, cronExpression }))
                }
                onValidityChange={setNewScheduleEditorValid}
              />
            </div>
          )}
          {newTrigger.kind === "webhook" && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("components.editableSections.signingModeLabel", { defaultValue: "Signing mode" })}</Label>
                <Select
                  value={newTrigger.signingMode}
                  onValueChange={(signingMode) =>
                    setNewTrigger((current) => ({ ...current, signingMode }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {signingModes.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {mode}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {signingModeDescriptions[newTrigger.signingMode]}
                </p>
              </div>
              {!SIGNING_MODES_WITHOUT_REPLAY_WINDOW.has(newTrigger.signingMode) && (
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("components.editableSections.replayWindowLabel", { defaultValue: "Replay window (seconds)" })}</Label>
                  <Input
                    value={newTrigger.replayWindowSec}
                    onChange={(event) =>
                      setNewTrigger((current) => ({ ...current, replayWindowSec: event.target.value }))
                    }
                  />
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>
            {t("components.editableSections.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            size="sm"
            onClick={() =>
              createTrigger.mutate(undefined, {
                onSuccess: () => {
                  setNewTrigger(createDefaultNewTrigger());
                  setAddOpen(false);
                },
              })
            }
            disabled={addDisabled}
          >
            {createTrigger.isPending
              ? t("components.editableSections.adding", { defaultValue: "Adding..." })
              : t("components.editableSections.addTrigger", { defaultValue: "Add trigger" })}
          </Button>
        </div>
      </div>
      ) : null}

      {/* Existing triggers */}
      {routine.triggers.length === 0 ? (
        <EmptyState
          icon={Clock3}
          message={t("components.editableSections.noTriggersYet", { defaultValue: "No triggers yet." })}
          action={t("components.editableSections.addSchedule", { defaultValue: "Add a schedule" })}
          onAction={() => setAddOpen(true)}
        />
      ) : (
        <div className="space-y-3">
          {routine.triggers.map((trigger) => (
            <RoutineTriggerCard
              key={trigger.id}
              trigger={trigger}
              onSave={(id, patch) => updateTrigger.mutate({ id, patch })}
              onRotate={(id) => rotateTrigger.mutate(id)}
              onDelete={(id) => deleteTrigger.mutate(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function VariablesSection() {
  const { t } = useTranslation();
  const ctx = useRoutineDetail();
  const { editDraft, setEditDraft, navigateToSection } = ctx;
  const hasVariables = editDraft.variables.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-md border border-border bg-muted/20 px-4 py-3 text-xs">
        <span className="flex-1 text-muted-foreground">
          {t("components.editableSections.variablesHintPrefix", {
            defaultValue: "Variables are auto-detected from ",
          })}
          <code className="font-mono">{"{{placeholders}}"}</code>
          {t("components.editableSections.variablesHintSuffix", {
            defaultValue:
              " in the title & instructions. The variable name is read-only — rename by editing the placeholder.",
          })}
        </span>
        <Button variant="secondary" size="sm" onClick={() => navigateToSection("overview")}>
          <Edit3 className="mr-1.5 h-3.5 w-3.5" />
          {t("components.editableSections.editInstructions", { defaultValue: "Edit instructions" })}
        </Button>
      </div>

      {hasVariables ? (
        <RoutineVariablesEditor
          title={editDraft.title}
          description={editDraft.description}
          value={editDraft.variables}
          onChange={(variables) => setEditDraft((current) => ({ ...current, variables }))}
        />
      ) : (
        <EmptyState
          icon={Braces}
          message={t("components.editableSections.noVariablesYet", {
            token: "{{placeholder}}",
            defaultValue:
              "No variables yet. Add a {{token}} in the title or instructions to create one.",
          })}
          action={t("components.editableSections.editInstructions", { defaultValue: "Edit instructions" })}
          onAction={() => navigateToSection("overview")}
        />
      )}
    </div>
  );
}

export function SecretsSection() {
  const { t } = useTranslation();
  const ctx = useRoutineDetail();
  const { editDraft, setEditDraft, availableSecrets, createSecret, secretMessage, copySecretValue } = ctx;

  // Project/company-scoped secrets that already see real usage, surfaced as
  // quick-bind chips (§3.4). Ranked by reference count then recency.
  const recentlyUsedSecrets = useMemo(
    () =>
      [...availableSecrets]
        .filter((secret) => secret.status === "active")
        .sort((a, b) => {
          const refDelta = (b.referenceCount ?? 0) - (a.referenceCount ?? 0);
          if (refDelta !== 0) return refDelta;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        })
        .slice(0, 8),
    [availableSecrets],
  );

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        {t("components.editableSections.secretsIntroPrefix", {
          defaultValue:
            "Routine secrets apply to every task this routine creates. They override matching keys in project and agent env. ",
        })}
        <span className="font-mono">PAPERCLIP_*</span>
        {t("components.editableSections.secretsIntroSuffix", { defaultValue: " names are reserved." })}
      </div>

      {secretMessage ? (
        <div className="space-y-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 text-sm">
          <div>
            <p className="font-medium">{secretMessage.title}</p>
            <p className="text-xs text-muted-foreground">
              {t("components.editableSections.secretSaveNow", {
                defaultValue: "Save this now. Paperclip will not show the secret value again.",
              })}
            </p>
          </div>
          <div className="space-y-3">
            {secretMessage.entries.map((entry, index) => (
              <div key={`${entry.webhookUrl}-${index}`} className="space-y-2">
                <div className="flex items-center gap-2">
                  <Input value={entry.webhookUrl} readOnly className="flex-1" />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      copySecretValue(
                        t("components.editableSections.webhookUrlLabel", { defaultValue: "Webhook URL" }),
                        entry.webhookUrl,
                      )
                    }
                  >
                    {t("components.editableSections.copyUrlButton", { defaultValue: "URL" })}
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Input value={entry.webhookSecret} readOnly className="flex-1" />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      copySecretValue(
                        t("components.editableSections.webhookSecretLabel", { defaultValue: "Webhook secret" }),
                        entry.webhookSecret,
                      )
                    }
                  >
                    {t("components.editableSections.copySecretButton", { defaultValue: "Secret" })}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <EnvVarEditor
        value={(editDraft.env ?? {}) as Record<string, EnvBinding>}
        secrets={availableSecrets}
        recentlyUsedSecrets={recentlyUsedSecrets}
        onCreateSecret={async (name, value) => createSecret.mutateAsync({ name, value })}
        onChange={(env) => setEditDraft((current) => ({ ...current, env: env ?? null }))}
      />
    </div>
  );
}

export function DeliverySection() {
  const { t } = useTranslation();
  const ctx = useRoutineDetail();
  const { editDraft, setEditDraft, routine } = ctx;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {t("components.editableSections.concurrencyHeading", { defaultValue: "Concurrency" })}
        </p>
        <RadioCardGroup
          ariaLabel={t("components.editableSections.concurrencyPolicyAria", { defaultValue: "Concurrency policy" })}
          value={editDraft.concurrencyPolicy}
          onValueChange={(concurrencyPolicy) =>
            setEditDraft((current) => ({ ...current, concurrencyPolicy }))
          }
          options={getConcurrencyPolicyOptions()}
        />
      </div>
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {t("components.editableSections.catchUpHeading", { defaultValue: "Catch-up" })}
        </p>
        <RadioCardGroup
          ariaLabel={t("components.editableSections.catchUpPolicyAria", { defaultValue: "Catch-up policy" })}
          value={editDraft.catchUpPolicy}
          onValueChange={(catchUpPolicy) =>
            setEditDraft((current) => ({ ...current, catchUpPolicy }))
          }
          options={getCatchUpPolicyOptions()}
        />
      </div>
      <NextFiresPreview
        triggers={routine.triggers}
        concurrencyPolicy={editDraft.concurrencyPolicy}
      />
    </div>
  );
}

const dispositionToneClass: Record<string, string> = {
  queued: "text-emerald-600 dark:text-emerald-400",
  coalesced: "text-amber-600 dark:text-amber-400",
  skipped: "text-muted-foreground",
};

/**
 * "Next 5 fires" preview (§3.5) — the strongest "what does this policy mean?"
 * surface. Picks the soonest-firing schedule trigger, computes its next fires
 * client-side, and annotates each with how the chosen concurrency policy would
 * treat it.
 */
function NextFiresPreview({
  triggers,
  concurrencyPolicy,
}: {
  triggers: RoutineDetailType["triggers"];
  concurrencyPolicy: string;
}) {
  const { t } = useTranslation();
  const preview = useMemo(() => {
    const schedule = triggers
      .filter((trigger) => trigger.kind === "schedule" && trigger.enabled && trigger.cronExpression)
      .map((trigger) => {
        const fires = nextCronFires(trigger.cronExpression, 5, {
          timeZone: trigger.timezone ?? "UTC",
        });
        return { trigger, fires };
      })
      .filter((entry) => entry.fires.length > 0)
      .sort((a, b) => a.fires[0]!.getTime() - b.fires[0]!.getTime())[0];
    if (!schedule) return null;
    return {
      timeZone: schedule.trigger.timezone ?? "UTC",
      entries: previewFirePolicies(schedule.fires, concurrencyPolicy),
    };
  }, [triggers, concurrencyPolicy]);

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {t("components.editableSections.next5Fires", { defaultValue: "Next 5 fires" })}
      </p>
      {preview ? (
        <>
          <div className="space-y-1.5 rounded-lg border border-border p-3 font-mono text-xs">
            {preview.entries.map((entry, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="text-muted-foreground/40">·</span>
                <span className="tabular-nums">{formatFireTime(entry.at, preview.timeZone)}</span>
                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                <span className={cn("font-medium", dispositionToneClass[entry.disposition])}>
                  {entry.label}
                </span>
                {entry.note ? (
                  <span className="truncate text-muted-foreground/60">({entry.note})</span>
                ) : null}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground/60">
            {t("components.editableSections.previewTimezoneNote", {
              timeZone: preview.timeZone,
              defaultValue:
                "Preview assumes the previous run is still in flight when the next fires. Times shown in {{timeZone}}.",
            })}
          </p>
        </>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          {t("components.editableSections.noScheduleTriggerPreview", {
            defaultValue:
              "No enabled schedule trigger to preview. Add a schedule in Triggers to see how this policy treats upcoming fires.",
          })}
        </p>
      )}
    </div>
  );
}

function formatFireTime(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(date)
      .replace(",", "");
  } catch {
    return date.toISOString();
  }
}
