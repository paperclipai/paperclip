import { useMemo, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Agent, CompanySecret, EnvBinding, Project, RoutineVariable } from "@paperclipai/shared";
import { Code2, FileText, ListPlus, RotateCcw, Table2 } from "lucide-react";
import { EnvVarEditor } from "@/components/EnvVarEditor";
import { ExecutionParticipantPicker } from "@/components/ExecutionParticipantPicker";
import { FoldCurtain } from "@/components/FoldCurtain";
import { InlineEditor } from "@/components/InlineEditor";
import { InlineEntitySelector, type InlineEntityOption } from "@/components/InlineEntitySelector";
import { JsonSchemaForm, type JsonSchemaNode, getDefaultValues } from "@/components/JsonSchemaForm";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MarkdownEditor, type MentionOption } from "@/components/MarkdownEditor";
import { ReportsToPicker } from "@/components/ReportsToPicker";
import {
  RoutineRunVariablesDialog,
  type RoutineRunDialogSubmitData,
} from "@/components/RoutineRunVariablesDialog";
import { RoutineVariablesEditor, RoutineVariablesHint } from "@/components/RoutineVariablesEditor";
import { ScheduleEditor, describeSchedule } from "@/components/ScheduleEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildExecutionPolicy } from "@/lib/issue-execution-policy";
import { createIssue, storybookAgents } from "../fixtures/paperclipData";

function Section({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="paperclip-story__frame overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="paperclip-story__label">{eyebrow}</div>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">{title}</h2>
            {description ? (
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function StatePanel({
  label,
  detail,
  children,
  disabled = false,
}: {
  label: string;
  detail?: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-background/70 p-4">
      <div className="mb-3 flex min-h-6 flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{label}</div>
          {detail ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div> : null}
        </div>
        {disabled ? <Badge variant="outline">disabled</Badge> : null}
      </div>
      <div className={disabled ? "pointer-events-none opacity-55" : undefined}>{children}</div>
    </div>
  );
}

function StoryShell({ children }: { children: ReactNode }) {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">{children}</main>
    </div>
  );
}

const reviewMarkdown = `# Release review

Ship criteria for the board UI refresh:

- [x] Preserve company-scoped routes
- [x] Keep comments and task updates auditable
- [ ] Attach screenshots after QA

Tooling: lean on [/react-perf-optimizer](skill://skill-react-perf?s=react-perf-optimizer) and [/vercel-react-best-practices](skill://skill-vercel-react?s=vercel-react-best-practices) so we don't regress render performance on the page it's open to. Inline skill chips like [/release-changelog](skill://skill-release?s=release-changelog) must sit on the surrounding text line, not hang below it.

| Surface | Owner | State |
| --- | --- | --- |
| Issues | CodexCoder | In progress |
| Approvals | CTO | Ready |

\`\`\`ts
const shouldRun = issue.status === "in_progress" && issue.companyId === company.id;
\`\`\`

See [the implementation notes](https://github.com/paperclipai/paperclip).`;

const editorMentions: MentionOption[] = [
  { id: "agent-codex", name: "CodexCoder", kind: "agent", agentId: "agent-codex", agentIcon: "code" },
  { id: "agent-qa", name: "QAChecker", kind: "agent", agentId: "agent-qa", agentIcon: "shield" },
  { id: "project-board-ui", name: "Board UI", kind: "project", projectId: "project-board-ui", projectColor: "#0f766e" },
  { id: "user-board", name: "Board Operator", kind: "user", userId: "user-board" },
];

const adapterSchema: JsonSchemaNode = {
  type: "object",
  required: ["adapterName", "apiKey", "concurrency"],
  properties: {
    adapterName: {
      type: "string",
      title: "Adapter name",
      description: "Human-readable name shown in the adapter manager.",
      minLength: 3,
      default: "Codex local",
    },
    mode: {
      type: "string",
      title: "Run mode",
      enum: ["review", "implementation", "maintenance"],
      default: "implementation",
    },
    apiKey: {
      type: "string",
      title: "API key",
      format: "secret-ref",
      description: "Stored with the active Paperclip secret provider.",
    },
    concurrency: {
      type: "integer",
      title: "Max concurrent runs",
      minimum: 1,
      maximum: 6,
      default: 2,
    },
    dryRun: {
      type: "boolean",
      title: "Dry run first",
      description: "Require a preview run before mutating company data.",
      default: true,
    },
    notes: {
      type: "string",
      title: "Operator notes",
      format: "textarea",
      maxLength: 500,
      description: "Shown to the agent before checkout.",
    },
    allowedCommands: {
      type: "array",
      title: "Allowed commands",
      description: "Commands this adapter can run without extra approval.",
      items: { type: "string", default: "pnpm test" },
      minItems: 1,
    },
    advanced: {
      type: "object",
      title: "Advanced guardrails",
      properties: {
        timeoutSeconds: { type: "integer", title: "Timeout seconds", minimum: 60, default: 900 },
        requireApproval: { type: "boolean", title: "Require board approval", default: false },
      },
    },
  },
};

const validAdapterValues = {
  ...getDefaultValues(adapterSchema),
  adapterName: "Codex local",
  mode: "implementation",
  apiKey: "secret:openai-api-key",
  concurrency: 2,
  dryRun: true,
  notes: "Use the project worktree and post a concise task update before handoff.",
  allowedCommands: ["pnpm --filter @paperclipai/ui typecheck", "pnpm build-storybook"],
  advanced: { timeoutSeconds: 900, requireApproval: false },
};

const invalidAdapterValues = {
  ...validAdapterValues,
  adapterName: "AI",
  apiKey: "",
  concurrency: 9,
};

const adapterErrors = {
  "/adapterName": "Must be at least 3 characters",
  "/apiKey": "This field is required",
  "/concurrency": "Must be at most 6",
};

const storybookSecrets: CompanySecret[] = [
  {
    id: "secret-openai",
    companyId: "company-storybook",
    name: "OPENAI_API_KEY",
    provider: "local_encrypted",
    externalRef: null,
    latestVersion: 3,
    description: null,
    createdByAgentId: null,
    createdByUserId: "user-board",
    createdAt: new Date("2026-04-18T10:00:00.000Z"),
    updatedAt: new Date("2026-04-20T10:00:00.000Z"),
  },
  {
    id: "secret-github",
    companyId: "company-storybook",
    name: "GITHUB_TOKEN",
    provider: "local_encrypted",
    externalRef: null,
    latestVersion: 1,
    description: null,
    createdByAgentId: null,
    createdByUserId: "user-board",
    createdAt: new Date("2026-04-19T10:00:00.000Z"),
    updatedAt: new Date("2026-04-19T10:00:00.000Z"),
  },
];

const filledEnv: Record<string, EnvBinding> = {
  NODE_ENV: { type: "plain", value: "development" },
  OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-openai", version: "latest" },
};

const routineVariables: RoutineVariable[] = [
  {
    name: "repo",
    label: "Repository",
    type: "text",
    defaultValue: "paperclipai/paperclip",
    required: true,
    options: [],
  },
  {
    name: "priority",
    label: "Priority",
    type: "select",
    defaultValue: "medium",
    required: true,
    options: ["low", "medium", "high"],
  },
  {
    name: "include_browser",
    label: "Include browser QA",
    type: "boolean",
    defaultValue: true,
    required: false,
    options: [],
  },
  {
    name: "notes",
    label: "Run notes",
    type: "textarea",
    defaultValue: "Capture any visible layout regressions.",
    required: false,
    options: [],
  },
];

const storybookProject: Project = {
  id: "project-board-ui",
  companyId: "company-storybook",
  urlKey: "board-ui",
  goalId: "goal-company",
  goalIds: ["goal-company"],
  goals: [{ id: "goal-company", title: "We're building Paperclip" }],
  name: "Board UI",
  description: "Control-plane interface, Storybook review surfaces, and operator workflows.",
  status: "in_progress",
  leadAgentId: "agent-codex",
  targetDate: null,
  color: "#0f766e",
  env: null,
  pauseReason: null,
  pausedAt: null,
  executionWorkspacePolicy: null,
  codebase: {
    workspaceId: "workspace-board-ui",
    repoUrl: "https://github.com/paperclipai/paperclip",
    repoRef: "master",
    defaultRef: "master",
    repoName: "paperclip",
    localFolder: "/Users/dotta/paperclip",
    managedFolder: "paperclip",
    effectiveLocalFolder: "/Users/dotta/paperclip",
    origin: "local_folder",
  },
  workspaces: [],
  primaryWorkspace: null,
  archivedAt: null,
  createdAt: new Date("2026-04-01T10:00:00.000Z"),
  updatedAt: new Date("2026-04-20T10:00:00.000Z"),
};

const entityOptions: InlineEntityOption[] = [
  { id: "issue-1672", label: "Storybook forms and editors", searchText: "PAP-1672 ui story coverage" },
  { id: "project-board-ui", label: "Board UI", searchText: "project frontend Storybook" },
  { id: "agent-codex", label: "CodexCoder", searchText: "engineer implementation" },
];

function MarkdownEditorGallery() {
  const [emptyMarkdown, setEmptyMarkdown] = useState("");
  const [filledMarkdown, setFilledMarkdown] = useState(reviewMarkdown);
  const [actionMarkdown, setActionMarkdown] = useState("Draft an update for @CodexCoder and /check-pr.");

  return (
    <Section
      eyebrow="MarkdownEditor"
      title="Composer states with content, read-only mode, and action buttons"
      description="The editor is controlled in all examples so reviewers can type, trigger mentions, and see command insertion behavior."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <StatePanel label="Empty" detail="Placeholder, border, and mention-ready empty state.">
          <MarkdownEditor
            value={emptyMarkdown}
            onChange={setEmptyMarkdown}
            placeholder="Write a task update..."
            mentions={editorMentions}
          />
        </StatePanel>
        <StatePanel label="Filled" detail="Long-form markdown with a table and fenced code block.">
          <MarkdownEditor value={filledMarkdown} onChange={setFilledMarkdown} mentions={editorMentions} />
        </StatePanel>
        <StatePanel label="Read-only" detail="Uses the editor rendering path without accepting edits." disabled>
          <MarkdownEditor value={reviewMarkdown} onChange={() => undefined} readOnly mentions={editorMentions} />
        </StatePanel>
        <StatePanel label="Toolbar actions" detail="External controls exercise insertion actions around the editor.">
          <div className="mb-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setActionMarkdown((value) => `${value}\n\n## Next action\n`)}>
              <FileText className="mr-2 h-4 w-4" />
              Heading
            </Button>
            <Button size="sm" variant="outline" onClick={() => setActionMarkdown((value) => `${value}\n\n- Verify typecheck\n- Build Storybook\n`)}>
              <ListPlus className="mr-2 h-4 w-4" />
              List
            </Button>
            <Button size="sm" variant="outline" onClick={() => setActionMarkdown((value) => `${value}\n\n| Field | State |\n| --- | --- |\n| Forms | Ready |\n`)}>
              <Table2 className="mr-2 h-4 w-4" />
              Table
            </Button>
            <Button size="sm" variant="outline" onClick={() => setActionMarkdown((value) => `${value}\n\n\`\`\`sh\npnpm build-storybook\n\`\`\`\n`)}>
              <Code2 className="mr-2 h-4 w-4" />
              Code
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setActionMarkdown("Draft an update for @CodexCoder and /check-pr.")}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset
            </Button>
          </div>
          <MarkdownEditor value={actionMarkdown} onChange={setActionMarkdown} mentions={editorMentions} />
        </StatePanel>
      </div>
    </Section>
  );
}

function MarkdownBodyGallery() {
  return (
    <Section
      eyebrow="MarkdownBody"
      title="Rendered markdown for task documents and comments"
      description="GFM coverage includes headings, task lists, links, tables, and code blocks in the app's prose wrapper."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <StatePanel label="Filled markdown" detail="Mixed document syntax with code and table overflow handling.">
          <MarkdownBody linkIssueReferences={false}>{reviewMarkdown}</MarkdownBody>
        </StatePanel>
        <div className="space-y-4">
          <StatePanel label="Empty">
            <MarkdownBody>{""}</MarkdownBody>
            <p className="text-sm text-muted-foreground">No markdown body content.</p>
          </StatePanel>
          <StatePanel label="Disabled container" disabled>
            <MarkdownBody linkIssueReferences={false}>A read-only preview can be dimmed by the parent surface.</MarkdownBody>
          </StatePanel>
        </div>
      </div>
    </Section>
  );
}

function JsonSchemaFormGallery() {
  const [filledValues, setFilledValues] = useState<Record<string, unknown>>(validAdapterValues);
  const [errorValues, setErrorValues] = useState<Record<string, unknown>>(invalidAdapterValues);

  return (
    <Section
      eyebrow="JsonSchemaForm"
      title="Generated adapter configuration forms"
      description="The schema exercises strings, enums, secrets, numbers, booleans, arrays, objects, validation errors, and disabled controls."
    >
      <div className="grid gap-4 xl:grid-cols-2">
        <StatePanel label="Filled">
          <JsonSchemaForm schema={adapterSchema} values={filledValues} onChange={setFilledValues} />
        </StatePanel>
        <StatePanel label="Validation errors">
          <JsonSchemaForm schema={adapterSchema} values={errorValues} onChange={setErrorValues} errors={adapterErrors} />
        </StatePanel>
        <StatePanel label="Empty schema">
          <JsonSchemaForm schema={{ type: "object", properties: {} }} values={{}} onChange={() => undefined} />
        </StatePanel>
        <StatePanel label="Disabled" disabled>
          <JsonSchemaForm schema={adapterSchema} values={filledValues} onChange={() => undefined} disabled />
        </StatePanel>
      </div>
    </Section>
  );
}

function InlineEditorGallery() {
  const [title, setTitle] = useState("Storybook: Forms & Editors stories");
  const [description, setDescription] = useState(
    "Create fixture-backed editor stories for the board UI, then verify Storybook builds.",
  );
  const [emptyTitle, setEmptyTitle] = useState("");

  return (
    <Section eyebrow="InlineEditor" title="Inline title and description editing">
      <div className="grid gap-4 lg:grid-cols-3">
        <StatePanel label="Title editing" detail="Click the title to edit and press Enter to save.">
          <InlineEditor value={title} onSave={setTitle} as="h2" className="text-2xl font-semibold" />
        </StatePanel>
        <StatePanel label="Description editing" detail="Multiline markdown editor with autosave affordance.">
          <InlineEditor value={description} onSave={setDescription} as="p" multiline nullable />
        </StatePanel>
        <StatePanel label="Empty nullable title" detail="Placeholder state for optional inline fields.">
          <InlineEditor value={emptyTitle} onSave={setEmptyTitle} as="h2" nullable placeholder="Untitled issue" />
        </StatePanel>
      </div>
    </Section>
  );
}

function EnvVarEditorGallery() {
  const [emptyEnv, setEmptyEnv] = useState<Record<string, EnvBinding>>({});
  const [env, setEnv] = useState<Record<string, EnvBinding>>(filledEnv);
  const createSecret = async (name: string): Promise<CompanySecret> => ({
    ...storybookSecrets[0]!,
    id: `secret-${name.toLowerCase()}`,
    name,
    latestVersion: 1,
  });

  return (
    <Section eyebrow="EnvVarEditor" title="Runtime environment bindings">
      <div className="grid gap-4 lg:grid-cols-3">
        <StatePanel label="Empty add row" detail="Trailing blank row is the add state.">
          <EnvVarEditor value={emptyEnv} secrets={storybookSecrets} onCreateSecret={createSecret} onChange={(next) => setEmptyEnv(next ?? {})} />
        </StatePanel>
        <StatePanel label="Plain and secret values" detail="Filled rows show edit, seal, secret select, and remove controls.">
          <EnvVarEditor value={env} secrets={storybookSecrets} onCreateSecret={createSecret} onChange={(next) => setEnv(next ?? {})} />
        </StatePanel>
        <StatePanel label="Disabled shell" disabled>
          <EnvVarEditor value={filledEnv} secrets={storybookSecrets} onCreateSecret={createSecret} onChange={() => undefined} />
        </StatePanel>
      </div>
    </Section>
  );
}

function ScheduleEditorGallery() {
  const [emptyCron, setEmptyCron] = useState("");
  const [weeklyCron, setWeeklyCron] = useState("30 9 * * 1");
  const [customCron, setCustomCron] = useState("15 16 1 * *");

  return (
    <Section eyebrow="ScheduleEditor" title="Cron picker with human-readable previews">
      <div className="grid gap-4 lg:grid-cols-3">
        <StatePanel label="Empty default" detail={describeSchedule(emptyCron)}>
          <ScheduleEditor value={emptyCron} onChange={setEmptyCron} />
        </StatePanel>
        <StatePanel label="Weekly filled" detail={describeSchedule(weeklyCron)}>
          <ScheduleEditor value={weeklyCron} onChange={setWeeklyCron} />
        </StatePanel>
        <StatePanel label="Custom disabled preview" detail={describeSchedule(customCron)} disabled>
          <ScheduleEditor value={customCron} onChange={setCustomCron} />
        </StatePanel>
      </div>
    </Section>
  );
}

function RoutineVariablesGallery() {
  const [variables, setVariables] = useState<RoutineVariable[]>(routineVariables);

  return (
    <Section
      eyebrow="RoutineVariablesEditor"
      title="Detected runtime variable definitions"
      description="Variable rows are synced from title and instructions placeholders, then configured with types, defaults, required flags, and select options."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <StatePanel label="Detected variables">
          <RoutineVariablesEditor
            title="Review {{repo}} at {{priority}} priority"
            description="Include browser QA: {{include_browser}}\n\nOperator notes: {{notes}}"
            value={variables}
            onChange={setVariables}
          />
        </StatePanel>
        <div className="space-y-4">
          <StatePanel label="Empty hint">
            <RoutineVariablesHint />
          </StatePanel>
          <StatePanel label="Disabled shell" disabled>
            <RoutineVariablesEditor
              title="Review {{repo}}"
              description="Use {{priority}} priority"
              value={variables.slice(0, 2)}
              onChange={() => undefined}
            />
          </StatePanel>
        </div>
      </div>
    </Section>
  );
}

function PickerGallery() {
  const [issue, setIssue] = useState(() =>
    createIssue({
      executionPolicy: buildExecutionPolicy({
        reviewerValues: ["agent:agent-qa"],
        approverValues: ["user:user-board"],
      }),
    }),
  );
  const [manager, setManager] = useState<string | null>("agent-cto");
  const [selectorValue, setSelectorValue] = useState("project-board-ui");
  const agentsWithTerminated: Agent[] = useMemo(
    () => [
      ...storybookAgents,
      {
        ...storybookAgents[1]!,
        id: "agent-legacy",
        name: "LegacyReviewer",
        status: "terminated",
        reportsTo: null,
      },
    ],
    [],
  );

  return (
    <Section
      eyebrow="Pickers"
      title="Execution participants, reporting hierarchy, and inline entity selection"
      description="Closed trigger states stay compact, while the dropdowns are interactive for search and selection review."
    >
      <div className="grid gap-4 xl:grid-cols-3">
        <StatePanel label="ExecutionParticipantPicker" detail="Review and approval participants share the same policy object.">
          <div className="flex flex-wrap gap-3">
            <ExecutionParticipantPicker
              issue={issue}
              stageType="review"
              agents={storybookAgents}
              currentUserId="user-board"
              onUpdate={(patch) => setIssue((current) => ({ ...current, ...patch }))}
            />
            <ExecutionParticipantPicker
              issue={issue}
              stageType="approval"
              agents={storybookAgents}
              currentUserId="user-board"
              onUpdate={(patch) => setIssue((current) => ({ ...current, ...patch }))}
            />
          </div>
        </StatePanel>
        <StatePanel label="ReportsToPicker" detail="Selected manager, CEO disabled state, and filtered hierarchy choices.">
          <div className="flex flex-wrap gap-3">
            <ReportsToPicker agents={agentsWithTerminated} value={manager} onChange={setManager} excludeAgentIds={["agent-codex"]} />
            <ReportsToPicker agents={agentsWithTerminated} value={null} onChange={() => undefined} disabled />
          </div>
        </StatePanel>
        <StatePanel label="InlineEntitySelector" detail="Search/select dropdown for issue, project, and agent entities.">
          <div className="flex flex-wrap gap-3">
            <InlineEntitySelector
              value={selectorValue}
              options={entityOptions}
              recentOptionIds={["issue-1672"]}
              placeholder="Entity"
              noneLabel="No entity"
              searchPlaceholder="Search entities..."
              emptyMessage="No matching entity."
              onChange={setSelectorValue}
            />
            <div className="pointer-events-none opacity-55">
              <InlineEntitySelector
                value=""
                options={entityOptions}
                placeholder="Entity"
                noneLabel="No entity"
                searchPlaceholder="Search entities..."
                emptyMessage="No matching entity."
                onChange={() => undefined}
              />
            </div>
          </div>
        </StatePanel>
      </div>
    </Section>
  );
}

function FormsEditorsShowcase() {
  return (
    <StoryShell>
      <section className="paperclip-story__frame p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="paperclip-story__label">Forms and editors</div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Paperclip form controls under realistic state</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
              Dense control-plane forms need to hold empty, filled, validation, and disabled states without losing scan
              speed. These fixtures keep the components reviewable outside production routes.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">empty</Badge>
            <Badge variant="outline">filled</Badge>
            <Badge variant="outline">validation</Badge>
            <Badge variant="outline">disabled</Badge>
          </div>
        </div>
      </section>

      <MarkdownEditorGallery />
      <MarkdownBodyGallery />
      <JsonSchemaFormGallery />
      <InlineEditorGallery />
      <EnvVarEditorGallery />
      <ScheduleEditorGallery />
      <RoutineVariablesGallery />
      <PickerGallery />
    </StoryShell>
  );
}

function RoutineRunDialogStory() {
  const [open, setOpen] = useState(true);
  const [submitted, setSubmitted] = useState<RoutineRunDialogSubmitData | null>(null);

  return (
    <StoryShell>
      <Section
        eyebrow="RoutineRunVariablesDialog"
        title="Manual routine run configuration"
        description="The dialog collects runtime variables, the target assignee, and optional project context before creating the run issue."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setOpen(true)}>Open run dialog</Button>
          {submitted ? (
            <pre className="max-w-full overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
              {JSON.stringify(submitted, null, 2)}
            </pre>
          ) : (
            <span className="text-sm text-muted-foreground">Submit the dialog to inspect the payload.</span>
          )}
        </div>
      </Section>
      <RoutineRunVariablesDialog
        open={open}
        onOpenChange={setOpen}
        companyId="company-storybook"
        routineName="Weekly release review"
        projects={[storybookProject]}
        agents={storybookAgents}
        defaultProjectId="project-board-ui"
        defaultAssigneeAgentId="agent-codex"
        variables={routineVariables}
        isPending={false}
        onSubmit={(data) => {
          setSubmitted({ ...data });
          setOpen(false);
        }}
      />
    </StoryShell>
  );
}

const meta = {
  title: "Components/Forms & Editors",
  parameters: {
    docs: {
      description: {
        component:
          "Fixture-backed stories for Paperclip form controls, markdown editors, inline editors, schedule controls, runtime-variable dialogs, and selection pickers.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const AllFormsAndEditors: Story = {
  name: "All Forms And Editors",
  render: () => <FormsEditorsShowcase />,
};

export const RoutineRunVariablesDialogOpen: Story = {
  name: "Routine Run Variables Dialog",
  render: () => <RoutineRunDialogStory />,
};

const foldCurtainLongMarkdown = [
  "# paperclip-bench",
  "",
  "Ship criteria for the benchmark harness — these notes are intentionally lengthy so the fold-curtain clips them.",
  "",
  "## Overview",
  "",
  "We need a benchmark that compares agent performance across task types and model backends. This includes:",
  "",
  "- a **runner** that executes tasks in isolated workspaces",
  "- a **scorer** that grades outputs against ground truth",
  "- a **dashboard** that trends metrics over time",
  "",
  "## Task format",
  "",
  "Each task is a directory containing a `task.md`, an optional `setup.sh`, and an `expected/` fixture. The runner mounts the task, executes the agent, and diffs the resulting workspace against `expected/`.",
  "",
  "```ts",
  "type TaskResult = {",
  "  taskId: string;",
  "  agent: string;",
  "  exitCode: number;",
  "  scoreBreakdown: Record<string, number>;",
  "};",
  "```",
  "",
  "## Metrics",
  "",
  "| Metric | Description |",
  "| --- | --- |",
  "| Pass@1 | First-try correctness |",
  "| Tokens | Cost per task |",
  "| Wall time | End-to-end minutes |",
  "",
  "## Next steps",
  "",
  "1. Land the runner with support for 3 task types.",
  "2. Backfill 50 tasks from open-source benchmarks.",
  "3. Wire the scorer to GitHub Actions.",
  "4. Publish baseline numbers on the main branch.",
  "",
  "All of this is described in more detail in the design doc linked from the home page.",
].join("\n");

const foldCurtainShortMarkdown = "This description is short. No curtain should appear.";

function FoldCurtainStory() {
  return (
    <StoryShell>
      <Section
        eyebrow="Presentation"
        title="FoldCurtain"
        description="Long content collapses to a preview with a bottom fade and a Show more button. Short content renders untouched."
      >
        <div className="space-y-6">
          <StatePanel
            label="Long description (collapsed)"
            detail="Default state on every fresh page load. Natural height far exceeds the collapsed height, so the curtain activates."
          >
            <FoldCurtain>
              <MarkdownBody className="text-[15px] leading-7">{foldCurtainLongMarkdown}</MarkdownBody>
            </FoldCurtain>
          </StatePanel>
          <StatePanel
            label="Short description (no curtain)"
            detail="Content below the activation threshold renders with no curtain and no button."
          >
            <FoldCurtain>
              <MarkdownBody className="text-[15px] leading-7">{foldCurtainShortMarkdown}</MarkdownBody>
            </FoldCurtain>
          </StatePanel>
        </div>
      </Section>
    </StoryShell>
  );
}

export const FoldCurtainShowcase: Story = {
  name: "Fold Curtain",
  render: () => <FoldCurtainStory />,
};
