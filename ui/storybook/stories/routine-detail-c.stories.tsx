import { useMemo, useRef, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Sparkles } from "lucide-react";
import type {
  RoutineDetail as RoutineDetailType,
  RoutineTrigger,
  RoutineVariable,
} from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { RunButton } from "@/components/AgentActionButtons";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { RoutineSubSidebar, RoutineSectionPicker } from "@/components/RoutineSubSidebar";
import { RoutineSaveBar } from "@/components/RoutineSaveBar";
import {
  EDITABLE_SECTIONS,
  RoutineDetailContext,
  type RoutineDetailContextValue,
  type RoutineEditDraft,
  type RoutineSectionKey,
} from "@/components/routine-sections/context";
import {
  OverviewSection,
  TriggersSection,
  VariablesSection,
  SecretsSection,
  DeliverySection,
} from "@/components/routine-sections/editable-sections";
import {
  RunsSection,
  ActivitySection,
} from "@/components/routine-sections/operate-sections";
import { storybookAgents, storybookProjects } from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";
const ROUTINE_ID = "routine-storybook";

const now = new Date("2026-06-09T12:00:00Z");

const variables: RoutineVariable[] = [
  { name: "customer_name", label: "Customer name", type: "text", defaultValue: "Acme", required: true, options: [] },
  { name: "deadline", label: "Deadline", type: "text", defaultValue: null, required: false, options: [] },
];

const triggers: RoutineTrigger[] = [
  {
    id: "trigger-schedule",
    companyId: COMPANY_ID,
    routineId: ROUTINE_ID,
    kind: "schedule",
    label: "schedule",
    enabled: true,
    cronExpression: "0 14 * * 1-5",
    timezone: "UTC",
    nextRunAt: new Date("2026-06-09T14:00:00Z"),
    lastFiredAt: new Date("2026-06-08T14:00:00Z"),
    publicId: null,
    secretId: null,
    signingMode: null,
    replayWindowSec: null,
    lastRotatedAt: null,
    lastResult: "succeeded",
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
  },
];

const routine: RoutineDetailType = {
  id: ROUTINE_ID,
  companyId: COMPANY_ID,
  projectId: storybookProjects[0]?.id ?? null,
  goalId: null,
  parentIssueId: null,
  title: "Send the weekly digest to {{customer_name}}",
  description:
    "Compile last week's shipped work and email a digest to {{customer_name}} by {{deadline}}.\n\nKeep it to five bullets.",
  assigneeAgentId: storybookAgents[0]?.id ?? null,
  priority: "medium",
  status: "active",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  variables,
  env: { DATABASE_URL: { type: "secret_ref", secretId: "secret-prod-db", version: "latest" } } as never,
  latestRevisionId: "rev-17",
  latestRevisionNumber: 17,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lastTriggeredAt: new Date("2026-06-08T14:00:00Z"),
  lastEnqueuedAt: null,
  createdAt: now,
  updatedAt: now,
  managedByPlugin: null,
  project: null,
  assignee: null,
  parentIssue: null,
  triggers,
  recentRuns: [],
  activeIssue: null,
};

const routineRuns = [
  { id: "run-1", source: "manual", status: "succeeded", triggeredAt: new Date("2026-06-09T11:48:00Z"), failureReason: null, triggerPayload: { customer_name: "Acme", deadline: "Fri" }, trigger: { label: "manual", kind: "manual" }, linkedIssue: { id: "issue-1", identifier: "PAP-99221", title: "Weekly digest for Acme" } },
  { id: "run-2", source: "schedule", status: "failed", triggeredAt: new Date("2026-06-08T14:00:00Z"), failureReason: "Cron timed out after 600s", triggerPayload: { customer_name: "Acme" }, trigger: { label: "schedule", kind: "schedule" }, linkedIssue: { id: "issue-2", identifier: "PAP-99220", title: "Weekly digest for Acme" } },
  { id: "run-3", source: "schedule", status: "succeeded", triggeredAt: new Date("2026-06-07T14:00:00Z"), failureReason: null, triggerPayload: { customer_name: "Globex" }, trigger: { label: "schedule", kind: "schedule" }, linkedIssue: { id: "issue-3", identifier: "PAP-99219", title: "Weekly digest for Globex" } },
] as never;

function stubSecret(id: string, name: string, latestVersion: number, referenceCount: number) {
  return {
    id,
    companyId: COMPANY_ID,
    key: name.toLowerCase(),
    name,
    provider: "paperclip",
    status: "active",
    managedMode: "managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion,
    description: null,
    lastResolvedAt: now,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    referenceCount,
    createdAt: now,
    updatedAt: now,
  };
}

const availableSecrets = [
  stubSecret("secret-prod-db", "prod-db", 3, 5),
  stubSecret("secret-gh-token", "gh-token", 2, 4),
  stubSecret("secret-openai", "openai-key", 1, 2),
  stubSecret("secret-stripe", "stripe-key", 1, 1),
] as never;

const activity = [
  { id: "act-1", action: "trigger.fired", details: { trigger: "schedule", run: "PAP-99221" }, createdAt: new Date("2026-06-09T14:02:00Z") },
  { id: "act-2", action: "routine.updated", details: { fields: ["instructions", "variables"] }, createdAt: new Date("2026-06-09T13:55:00Z") },
  { id: "act-3", action: "run.completed", details: { issue: "PAP-99220", status: "failed" }, createdAt: new Date("2026-06-08T23:01:00Z") },
] as never;

function stubMutation(overrides?: Record<string, unknown>) {
  return {
    isPending: false,
    mutate: () => {},
    mutateAsync: async () => ({}),
    ...overrides,
  } as never;
}

function makeContext(dirty: boolean, navigate: (s: RoutineSectionKey) => void): RoutineDetailContextValue {
  const defaults: RoutineEditDraft = {
    title: routine.title,
    description: routine.description ?? "",
    projectId: routine.projectId ?? "",
    assigneeAgentId: routine.assigneeAgentId ?? "",
    priority: routine.priority,
    concurrencyPolicy: routine.concurrencyPolicy,
    catchUpPolicy: routine.catchUpPolicy,
    variables: routine.variables,
    env: routine.env ?? null,
  };
  const editDraft: RoutineEditDraft = dirty
    ? { ...defaults, description: `${defaults.description}\n\nAlways CC the account owner.` }
    : defaults;
  const dirtyFields = dirty ? [{ key: "description", label: "the description" }] : [];

  return {
    routine,
    routineId: ROUTINE_ID,
    companyId: COMPANY_ID,
    editDraft,
    setEditDraft: () => {},
    routineDefaults: defaults,
    dirtyFields,
    isEditDirty: dirty,
    sectionDirtyFields: (s) => (s === "overview" ? dirtyFields : []),
    isSectionDirty: (s) => dirty && s === "overview",
    discardSection: () => {},
    saveRoutine: stubMutation(),
    saveConflict: false,
    reloadLatest: () => {},
    automationEnabled: true,
    automationLabel: "Active",
    automationLabelClassName: "text-emerald-400",
    automationToggleDisabled: false,
    onToggleAutomation: () => {},
    onOpenRunDialog: () => {},
    runRoutinePending: false,
    newTrigger: { kind: "schedule", cronExpression: "0 14 * * 1-5", signingMode: "bearer", replayWindowSec: "300" },
    setNewTrigger: () => {},
    createTrigger: stubMutation(),
    updateTrigger: stubMutation(),
    deleteTrigger: stubMutation(),
    rotateTrigger: stubMutation(),
    secretMessage: null,
    setSecretMessage: () => {},
    copySecretValue: () => {},
    availableSecrets,
    createSecret: stubMutation(),
    agents: storybookAgents,
    projects: storybookProjects,
    agentById: new Map(storybookAgents.map((a) => [a.id, a])),
    projectById: new Map(storybookProjects.map((p) => [p.id, p])),
    assigneeOptions: storybookAgents.map((a) => ({ id: a.id, label: a.name, searchText: a.name })),
    projectOptions: storybookProjects.map((p) => ({ id: p.id, label: p.name, searchText: p.name })),
    recentAssigneeIds: [],
    recentProjectIds: [],
    mentionOptions: [],
    currentAssignee: storybookAgents[0] ?? null,
    currentProject: storybookProjects[0] ?? null,
    routineRuns,
    activity,
    hasLiveRun: false,
    activeIssueId: undefined,
    titleInputRef: { current: null },
    descriptionEditorRef: { current: null },
    assigneeSelectorRef: { current: null },
    projectSelectorRef: { current: null },
    onHistoryRestoreSecretMaterials: () => {},
    onHistoryRestored: () => {},
    navigateToSection: navigate,
  } as RoutineDetailContextValue;
}

const SECTION_TITLES: Record<RoutineSectionKey, string> = {
  overview: "Overview",
  triggers: "Triggers",
  variables: "Variables",
  secrets: "Secrets",
  delivery: "Delivery",
  runs: "Runs",
  activity: "Activity",
  history: "History",
};

function SectionBody({ section }: { section: RoutineSectionKey }) {
  switch (section) {
    case "overview":
      return <OverviewSection />;
    case "triggers":
      return <TriggersSection />;
    case "variables":
      return <VariablesSection />;
    case "secrets":
      return <SecretsSection />;
    case "delivery":
      return <DeliverySection />;
    case "runs":
      return <RunsSection />;
    case "activity":
      return <ActivitySection />;
    default:
      return null;
  }
}

function RoutineCShell({ initialSection = "overview", dirty = false }: { initialSection?: RoutineSectionKey; dirty?: boolean }) {
  const [section, setSection] = useState<RoutineSectionKey>(initialSection);
  const ctx = useMemo(() => makeContext(dirty, setSection), [dirty]);
  const isEditable = EDITABLE_SECTIONS.includes(section);

  return (
    <RoutineDetailContext.Provider value={ctx}>
      <div className="flex h-[900px] flex-col overflow-y-auto bg-background text-foreground">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="truncate text-base font-semibold">{routine.title}</span>
            <Badge variant="outline" className="hidden shrink-0 gap-1.5 text-xs text-muted-foreground sm:inline-flex">
              <Sparkles className="h-3 w-3" /> Digest Bot
            </Badge>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <RunButton onClick={() => {}} />
            <div className="flex items-center gap-2">
              <ToggleSwitch size="default" checked onCheckedChange={() => {}} aria-label="Toggle automation" />
              <span className="text-sm font-medium text-emerald-400">Active</span>
            </div>
          </div>
        </header>

        <RoutineSectionPicker activeSection={section} onNavigate={setSection} isSectionDirty={ctx.isSectionDirty} />

        <div className="flex min-h-0 flex-1">
          <RoutineSubSidebar
            activeSection={section}
            hrefFor={(s) => `#${s}`}
            isSectionDirty={ctx.isSectionDirty}
            hasLiveRun={false}
            onNavigate={setSection}
          />
          <main className="min-w-0 flex-1 px-4 pb-6 pt-10 md:px-8">
            <section className={isEditable ? "mx-auto w-full max-w-3xl" : "w-full"}>
              <h2 className="mb-4 text-lg font-semibold">{SECTION_TITLES[section]}</h2>
              <SectionBody section={section} />
              {isEditable ? (
                <RoutineSaveBar
                  dirtyFields={ctx.sectionDirtyFields(section)}
                  isSaving={false}
                  saveConflict={false}
                  onSave={() => {}}
                  onDiscard={() => {}}
                  onReload={() => {}}
                />
              ) : null}
            </section>
          </main>
        </div>
      </div>
    </RoutineDetailContext.Provider>
  );
}

const meta: Meta<typeof RoutineCShell> = {
  title: "Product/Routines · Detail (variation C)",
  component: RoutineCShell,
  parameters: {
    layout: "fullscreen",
    a11y: { test: "off" },
  },
};

export default meta;

type Story = StoryObj<typeof RoutineCShell>;

export const Overview: Story = { args: { initialSection: "overview", dirty: true } };
export const Triggers: Story = { args: { initialSection: "triggers" } };
export const Variables: Story = { args: { initialSection: "variables" } };
export const Secrets: Story = { args: { initialSection: "secrets" } };
export const Delivery: Story = { args: { initialSection: "delivery" } };
export const Runs: Story = { args: { initialSection: "runs" } };
export const Activity: Story = { args: { initialSection: "activity" } };
