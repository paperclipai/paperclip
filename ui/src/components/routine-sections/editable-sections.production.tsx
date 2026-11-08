import { displayStatusLabel } from "../StatusBadge";
import { t, useTranslation, Trans } from "@/i18n";
import { AgentAvatar } from "@/components/AgentAvatar";
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
import { nextCronFires, previewFirePolicies } from "../../lib/cron-fires";
import { timeAgo } from "../../lib/timeAgo";
import { EmptyState } from "../EmptyState";
import { InlineEntitySelector } from "../InlineEntitySelector";
import { DocumentAnnotationsCountChip, IssueDocumentAnnotations } from "../IssueDocumentAnnotations";
import { MarkdownEditor } from "../MarkdownEditor";
import { ScheduleEditor, getScheduleCronValidation } from "../ScheduleEditor";
import { RoutineVariablesEditor, RoutineVariablesHint } from "../RoutineVariablesEditor";
import { RoutineTriggerCard } from "../RoutineTriggerCard";
import { EnvironmentVariablesEditor } from "../environment-variables-editor";
import { createDefaultNewTrigger, useRoutineDetail } from "./context";
import type { EnvBinding, RoutineDetail as RoutineDetailType } from "@paperclipai/shared";

const concurrencyPolicyOptions = [
  {
    value: "coalesce_if_active",
    get title() { return t("task-components:coalesceIfActive_ee3319ab"); },
    get description() { return t("task-components:keepOneFollowUpRunQueuedWhile_f81f576d"); },
  },
  {
    value: "always_enqueue",
    get title() { return t("task-components:alwaysEnqueue_14769882"); },
    get description() { return t("task-components:queueEveryTriggerOccurrenceEvenIfSeveral_1d894457"); },
  },
  {
    value: "skip_if_active",
    get title() { return t("task-components:skipIfActive_128f844b"); },
    get description() { return t("task-components:dropOverlappingTriggerOccurrencesWhileTheRoutine_ca321654"); },
  },
];

const catchUpPolicyOptions = [
  {
    value: "skip_missed",
    get title() { return t("task-components:skipMissed_23ab424e"); },
    get description() { return t("task-components:ignoreScheduleWindowsThatWereMissedWhile_403c69b0"); },
  },
  {
    value: "enqueue_missed_with_cap",
    get title() { return t("task-components:enqueueMissedWithCap_97c8825e"); },
    get description() { return t("task-components:catchUpMissedScheduleWindowsAfterRecovery_5137b633"); },
  },
];

const activityGatePolicyOptions = [
  {
    value: "always",
    get title() { return t("task-components:runOnEveryScheduledTick_6fa83c63"); },
    get description() { return t("task-components:fireOnTheScheduleNoMatterWhat_4412186d"); },
  },
  {
    value: "require_external_activity",
    get title() { return t("task-components:skipWhenThereSBeenNoActivity_e3bb529a"); },
    get description() { return t("task-components:onAScheduledTickOnlyRunIf_ca39b27c"); },
  },
];

const activityGateScopeOptions = [
  {
    value: "company",
    get title() { return t("task-components:companyWide_e4010f5d"); },
    get description() { return t("task-components:anyActivityAcrossTheCompanyCountsAs_17fe520b"); },
  },
  {
    value: "project",
    get title() { return t("task-components:thisProject_d0f62545"); },
    get description() { return t("task-components:onlyActivityInTheRoutineSProject_bd022132"); },
  },
];

const triggerKinds = ["schedule", "webhook"];
const signingModes = ["app_webhook", "bearer", "hmac_sha256", "github_hmac", "none"];
const signingModeDescriptions: Record<string, string> = {
  get bearer() { return t("final-components-b:Send_Authorization_Bearer_secret_with_each_request_fbfe38"); },
  get hmac_sha256() { return t("final-components-b:routine-sections.editable-sections.production.Send_X_Paperclip_Timestamp_and_X_Paperclip_Signature_sha256_hex_s_c8a45d"); },
  get github_hmac() { return t("final-components-b:routine-sections.editable-sections.production.Accept_GitHub_style_X_Hub_Signature_256_header_HMAC_over_raw_body_6de820"); },
  get app_webhook() { return t("final-components-b:routine-sections.editable-sections.production.Accept_a_bearer_token_or_an_HMAC_SHA256_signature_over_the_exact__f25881"); },
  get fireflies_hmac() { return t("final-components-b:routine-sections.editable-sections.production.Signed_webhook_legacy_53410a"); },
  get none() { return t("final-components-b:routine-sections.editable-sections.production.No_authentication_the_webhook_URL_itself_acts_as_a_shared_secret_691cb6"); },
};
const SIGNING_MODES_WITHOUT_REPLAY_WINDOW = new Set(["app_webhook", "bearer", "github_hmac", "fireflies_hmac", "none"]);

export function OverviewSection({
  defaultDescriptionAnnotationsOpen = false,
}: {
  defaultDescriptionAnnotationsOpen?: boolean;
} = {}) {
  useTranslation("task-components");
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
    saveConflict,
    isSectionDirty,
    navigateToSection,
  } = ctx;
  const [descriptionAnnotationsOpen, setDescriptionAnnotationsOpen] = useState(defaultDescriptionAnnotationsOpen);

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
          <span>{t("task-components:for_ca15ebc0")}</span>
          <InlineEntitySelector
            ref={assigneeSelectorRef}
            value={editDraft.assigneeAgentId}
            options={assigneeOptions}
            recentOptionIds={recentAssigneeIds}
            placeholder={t("task-components:responsible_bc110a6d")}
            noneLabel={t("final-components-b:routine-sections.editable-sections.production.No_responsible_15abde")}
            searchPlaceholder={t("task-components:searchResponsible_9cb8d79f")}
            emptyMessage={t("task-components:noResponsibleFound_045a8ffe")}
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
                    <AgentAvatar agent={currentAssignee} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                    <span className="truncate">{option.label}</span>
                  </>
                ) : (
                  <span className="truncate">{option.label}</span>
                )
              ) : (
                <span className="text-muted-foreground">{t("task-components:responsible_bc110a6d")}</span>
              )
            }
            renderOption={(option) => {
              if (!option.id) return <span className="truncate">{option.label}</span>;
              const assignee = agentById.get(option.id);
              return (
                <>
                  {assignee ? (
                    <AgentAvatar agent={assignee} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
          <span>{t("task-components:in_58296753")}</span>
          <InlineEntitySelector
            ref={projectSelectorRef}
            value={editDraft.projectId}
            options={projectOptions}
            recentOptionIds={recentProjectIds}
            placeholder={t("task-components:project_98595978")}
            noneLabel={t("final-components-b:routine-sections.editable-sections.production.No_project_f34c2b")}
            searchPlaceholder={t("task-components:searchProjects_c59dd5a3")}
            emptyMessage={t("task-components:noProjectsFound_26e92309")}
            onChange={(projectId) => setEditDraft((current) => ({ ...current, projectId }))}
            onConfirm={() => descriptionEditorRef.current?.focus()}
            renderTriggerValue={(option) =>
              option && currentProject ? (
                <>
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: currentProject.color ?? "var(--project-none)" }}
                  />
                  <span className="truncate">{option.label}</span>
                </>
              ) : (
                <span className="text-muted-foreground">{t("task-components:project_98595978")}</span>
              )
            }
            renderOption={(option) => {
              if (!option.id) return <span className="truncate">{option.label}</span>;
              const project = projectById.get(option.id);
              return (
                <>
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: project?.color ?? "var(--project-none)" }}
                  />
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
        </div>
      </div>

      {!routine.assigneeAgentId ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-900 dark:text-amber-200">{t("task-components:defaultAgentRequiredThisRoutineCanStay_07c2de4a")}</div>
      ) : null}

      {/* Instructions */}
      <div className="space-y-2">
        <div className="flex items-center justify-end">
          {routine.descriptionDocument ? (
            <DocumentAnnotationsCountChip
              issueId={routine.id}
              docKey="description"
              target={{ kind: "routine", routineId: routine.id, documentKey: "description" }}
              panelOpen={descriptionAnnotationsOpen}
              onToggle={() => setDescriptionAnnotationsOpen((open) => !open)}
            />
          ) : null}
        </div>
        {routine.descriptionDocument ? (
          <IssueDocumentAnnotations
            issueId={routine.id}
            doc={routine.descriptionDocument}
            target={{ kind: "routine", routineId: routine.id, documentKey: "description" }}
            bodyMarkdown={editDraft.description}
            draftDirty={isSectionDirty("overview") || saveRoutine.isPending}
            draftConflicted={saveConflict}
            historicalPreview={false}
            locationHash={typeof window === "undefined" ? "" : window.location.hash}
            panelOpen={descriptionAnnotationsOpen}
            onPanelOpenChange={setDescriptionAnnotationsOpen}
          >
            <MarkdownEditor
              ref={descriptionEditorRef}
              value={editDraft.description}
              onChange={(description) => setEditDraft((current) => ({ ...current, description }))}
              placeholder={t("task-components:addInstructions_d49e19c5")}
              bordered={false}
              contentClassName="min-h-(--sz-120px) text-sm leading-7"
              mentions={mentionOptions}
              onSubmit={() => {
                if (!saveRoutine.isPending && editDraft.title.trim()) {
                  saveRoutine.mutate();
                }
              }}
            />
          </IssueDocumentAnnotations>
        ) : (
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={editDraft.description}
            onChange={(description) => setEditDraft((current) => ({ ...current, description }))}
            placeholder={t("task-components:addInstructions_d49e19c5")}
            bordered={false}
            contentClassName="min-h-(--sz-120px) text-sm leading-7"
            mentions={mentionOptions}
            onSubmit={() => {
              if (!saveRoutine.isPending && editDraft.title.trim()) {
                saveRoutine.mutate();
              }
            }}
          />
        )}
      </div>

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
          label={t("task-components:triggers_e62f2148")}
          value={activeTriggers === 0 ? t("final-components-b:routine-sections.editable-sections.production.None_dc937b") : t("final-components-b:count_active_480255", { count: activeTriggers })}
          hint={nextFire ? t("final-components-b:Next_fire_time_5e8799", { time: nextFire }) : t("final-components-b:routine-sections.editable-sections.production.No_schedule_449040")}
          to={() => navigateToSection("triggers")}
          ariaLabel={t("final-components-b:count_triggers_Open_triggers_8624e8", { count: activeTriggers })}
        />
        <SummaryCard
          icon={KeyRound}
          label={t("task-components:secrets_d8707d41")}
          value={boundSecrets === 0 ? t("final-components-b:routine-sections.editable-sections.production.None_dc937b") : t("final-components-b:count_bound_b0422c", { count: boundSecrets })}
          hint={t("final-components-b:routine-sections.editable-sections.production.Manage_bound_secrets_0b00dd")}
          to={() => navigateToSection("secrets")}
          ariaLabel={t("final-components-b:count_secrets_bound_Open_secrets_3a9968", { count: boundSecrets })}
        />
        <SummaryCard
          icon={Play}
          label={t("task-components:lastRun_512a4821")}
          value={lastRun ? displayStatusLabel(lastRun.status) : t("final-components-b:routine-sections.editable-sections.production.No_runs_26735e")}
          hint={lastRun ? timeAgo(lastRun.triggeredAt) : t("final-components-b:routine-sections.editable-sections.production.Trigger_a_run_177f8d")}
          to={() => navigateToSection("runs")}
          ariaLabel={lastRun ? t("final-components-b:Last_run_status_Open_runs_e9d2db", { status: displayStatusLabel(lastRun.status) }) : t("final-components-b:routine-sections.editable-sections.production.No_runs_Open_runs_b60042")}
        />
      </div>

      {/* Recent activity */}
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("task-components:recentActivity_6cb44b56")}</p>
        {recentActivity.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("task-components:noActivityYet_a288d2d0")}</p>
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
            >{t("task-components:viewAllActivity_b9db058f")}{" "}<ArrowRight className="h-3 w-3" />
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
  useTranslation("task-components");
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
  useTranslation("task-components");
  const ctx = useRoutineDetail();
  const { routine, newTrigger, setNewTrigger, createTrigger, updateTrigger, deleteTrigger, rotateTrigger, secretMessage, copySecretValue, setSecretMessage } = ctx;
  const [addOpen, setAddOpen] = useState(false);
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
            ? t("task-components:noTriggersYet_362ec1f1")
            : t("task-components:trigger_03290011", { value1: routine.triggers.length, value2: t("task-components:pluralSuffix", { count: routine.triggers.length }) })}
        </p>
        <Button
          size="sm"
          variant={addOpen ? "secondary" : "default"}
          onClick={() => setAddOpen((open) => !open)}
          aria-expanded={addOpen}
        >
          {addOpen ? (
            <>
              <X className="mr-1.5 h-3.5 w-3.5" />{t("task-components:cancel_19766ed6")}</>
          ) : (
            <>
              <Plus className="mr-1.5 h-3.5 w-3.5" />{t("task-components:newTrigger_a38f4ea6")}</>
          )}
        </Button>
      </div>

      {/* Add trigger form — expand-on-click drawer */}
      {addOpen ? (
      <div className="space-y-3 rounded-lg border border-border p-4">
        <p className="text-sm font-medium">{t("task-components:addTrigger_58fd3089")}</p>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("task-components:kind_f5387f9b")}</Label>
            <Select
              value={newTrigger.kind}
              onValueChange={(kind) => setNewTrigger((current) => ({ ...current, kind }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {triggerKinds.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {kind}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {newTrigger.kind === "schedule" && (
            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-xs">{t("task-components:schedule_f4830a1d")}</Label>
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
                <Label className="text-xs">{t("task-components:signingMode_0ba52a43")}</Label>
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
                  <Label className="text-xs">{t("task-components:replayWindowSeconds_88c7ec0c")}</Label>
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
          <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>{t("task-components:cancel_19766ed6")}</Button>
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
            {createTrigger.isPending ? t("task-components:adding_913a8849") : t("task-components:addTrigger_58fd3089")}
          </Button>
        </div>
      </div>
      ) : null}

      {secretMessage ? (
        <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4 text-sm">
          <div>
            <p className="font-medium">{secretMessage.title}</p>
            <p className="text-xs text-muted-foreground">{t("task-components:saveThisNowPaperclipWillNotShow_70e97789")}</p>
          </div>
          <div className="space-y-3">
            {secretMessage.entries.map((entry, index) => (
              <div key={`${entry.webhookUrl}-${index}`} className="space-y-2">
                <div className="flex items-center gap-2">
                  <Input aria-label={t("task-components:newWebhookUrl_48f3ada2")} value={entry.webhookUrl} readOnly className="flex-1" />
                  <Button variant="outline" size="sm" onClick={() => copySecretValue("Webhook URL", entry.webhookUrl)}>
                    URL
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Input aria-label={t("task-components:newWebhookSecret_2c422ebf")} value={entry.webhookSecret} readOnly className="flex-1" />
                  <Button variant="outline" size="sm" onClick={() => copySecretValue("Webhook secret", entry.webhookSecret)}>{t("task-components:secret_7e32a729")}</Button>
                </div>
              </div>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => setSecretMessage(null)}>{t("task-components:done_11a6767d")}</Button>
        </div>
      ) : null}

      {/* Existing triggers */}
      {routine.triggers.length === 0 ? (
        <EmptyState
          icon={Clock3}
          message={t("final-components-b:routine-sections.editable-sections.production.No_triggers_yet_4d6663")}
          action={t("final-components-b:routine-sections.editable-sections.production.Add_a_trigger_07f32a")}
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
  useTranslation("task-components");
  const ctx = useRoutineDetail();
  const { editDraft, setEditDraft, navigateToSection } = ctx;
  const hasVariables = editDraft.variables.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-md border border-border bg-muted/20 px-4 py-3 text-xs">
        <span className="flex-1 text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_92762a386eb5" components={{ part1: <>{<code className="font-mono">{"{{placeholders}}"}</code>}</> }} /></span>
        <Button variant="secondary" size="sm" onClick={() => navigateToSection("overview")}>
          <Edit3 className="mr-1.5 h-3.5 w-3.5" />{t("task-components:editInstructions_23e27511")}</Button>
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
          message={t("final-components-b:No_variables_yet_Add_a_placeholder_in_the_title_or_instructions_to_cre_56192d", { placeholder: "{{placeholder}}" })}
          action={t("final-components-b:routine-sections.editable-sections.production.Edit_instructions_23e275")}
          onAction={() => navigateToSection("overview")}
        />
      )}
    </div>
  );
}

export function SecretsSection() {
  useTranslation("task-components");
  const ctx = useRoutineDetail();
  const { editDraft, setEditDraft, availableSecrets, createSecret } = ctx;

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
      <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_cff8174eeb18" components={{ part1: <>{<span className="font-mono">PAPERCLIP_*</span>}</> }} /></div>


      <EnvironmentVariablesEditor
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
  useTranslation("task-components");
  const ctx = useRoutineDetail();
  const { editDraft, setEditDraft, routine } = ctx;

  // The activity gate only affects schedule ticks (webhook/manual/API fires are
  // themselves activity and always run), so the control is only meaningful for
  // routines that have a schedule trigger. Disable — rather than hide — it
  // elsewhere so the capability stays discoverable.
  const hasScheduleTrigger = routine.triggers.some((trigger) => trigger.kind === "schedule");
  const gateEnabled = editDraft.activityGatePolicy === "require_external_activity";

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:concurrency_8708492f")}</p>
        <RadioCardGroup
          ariaLabel={t("final-components-b:routine-sections.editable-sections.production.Concurrency_policy_a8ac65")}
          value={editDraft.concurrencyPolicy}
          onValueChange={(concurrencyPolicy) =>
            setEditDraft((current) => ({ ...current, concurrencyPolicy }))
          }
          options={concurrencyPolicyOptions}
        />
      </div>
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:catchUp_1c2d0f8e")}</p>
        <RadioCardGroup
          ariaLabel={t("final-components-b:routine-sections.editable-sections.production.Catch_up_policy_7e194d")}
          value={editDraft.catchUpPolicy}
          onValueChange={(catchUpPolicy) =>
            setEditDraft((current) => ({ ...current, catchUpPolicy }))
          }
          options={catchUpPolicyOptions}
        />
      </div>
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:advancedRunPolicy_02eb5cf7")}</p>
        <RadioCardGroup
          ariaLabel={t("final-components-b:routine-sections.editable-sections.production.Advanced_run_policy_02eb5c")}
          value={editDraft.activityGatePolicy}
          onValueChange={(activityGatePolicy) =>
            setEditDraft((current) => ({ ...current, activityGatePolicy }))
          }
          options={activityGatePolicyOptions}
          disabled={!hasScheduleTrigger}
        />
        {!hasScheduleTrigger ? (
          <p className="text-xs text-muted-foreground">{t("task-components:addAScheduleTriggerToGateRuns_c62e42a1")}</p>
        ) : gateEnabled ? (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <Label className="text-xs font-medium">{t("task-components:activityScope_98a37b44")}</Label>
            <RadioCardGroup
              ariaLabel={t("final-components-b:routine-sections.editable-sections.production.Activity_gate_scope_24e9df")}
              value={editDraft.activityGateScope}
              onValueChange={(activityGateScope) =>
                setEditDraft((current) => ({ ...current, activityGateScope }))
              }
              options={activityGateScopeOptions}
            />
          </div>
        ) : null}
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
  useTranslation("task-components");
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
      <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:next5Fires_10b02c89")}</p>
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
          <p className="text-(length:--text-micro) text-muted-foreground/60"><Trans ns="task-components" i18nKey="sentence_66441a6f9242" components={{ part1: <>{preview.timeZone}</> }} /></p>
        </>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">{t("task-components:noEnabledScheduleTriggerToPreviewAdd_54271cad")}</p>
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
