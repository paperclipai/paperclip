import type { Meta, StoryObj } from "@storybook/react-vite";
import { EMPTY_ROUTINE_FORM_DRAFT, RoutineEditDialog } from "@/components/routine-page/RoutineEditDialog";
import { storybookAgents, storybookProjects, storybookSecrets } from "../../fixtures/paperclipData";
import { expect, userEvent, within } from "storybook/test";
import { routineToDraft } from "@/components/routine-page/routine-form";
import { RoutineEditDialogPreview, RoutineProposalFixtures } from "../../support/routines/RoutinePagePreview";
import { routinePeople, routineResponsibilities, routineScenarios } from "../../support/routines/routine-page-data";

const scheduled = routineToDraft(routineScenarios.scheduled.routine);
const withVariables = routineToDraft(routineScenarios.variablesAndSecrets.routine);

const meta = {
  id: "routine-edit-dialog-design",
  title: "Automation and structured work/Routines, schedules, and triggers/Routine page/Edit dialog",
  component: RoutineEditDialog,
  args: {
    open: true,
    onOpenChange: () => {},
    initial: scheduled,
    agents: storybookAgents,
    projects: storybookProjects,
    people: routinePeople,
    secrets: storybookSecrets,
    onSave: () => {},
    onReloadLatest: () => {},
    onCreateSecret: async (name: string) => ({ ...storybookSecrets[0]!, id: `secret-${name}`, name }),
  },
  decorators: [(Story) => <RoutineProposalFixtures><Story /></RoutineProposalFixtures>],
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "One vertical form for a routine, opened from Edit on the routine page: title, instructions, schedule, default agent, project, default responsible user and secrets. The Variables block appears only while the title or instructions contain a {{placeholder}}. Variables are one row each under shared column labels. Secrets start as a single Add secret button that opens a blank row ready to type in. Webhooks are listed and added here, each in its own dialog. The same form creates a routine from the routines list (New routine). Closing with unsaved changes asks once in the footer. Responsibility is experimental and appears only while areas of responsibility are switched on." } },
    paperclip: {
      capabilities: ["routines/definition", "routines/management", "routines/triggers"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "The shipped RoutineEditDialog, built from MarkdownEditor, RoutineVariablesEditor, ScheduleEditor, InlineEntitySelector and EnvironmentVariablesEditor. Typing / in Instructions lists skills and routines from the editor's shared autocomplete context, seeded here with three skills and four routines. Save, reload and secret creation are no-ops; webhook stories keep webhooks in local state. Priority and delivery settings have no editor: the routed page never sends them, so saved values are kept. Responsibility is flag-gated (enableResponsibilities); stories pass fixture options directly.",
    },
  },
} satisfies Meta<typeof RoutineEditDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Editing: Story = {};
export const VariablesDetected: Story = { args: { initial: withVariables } };
export const EveryVariableType: Story = {
  args: {
    initial: {
      ...scheduled,
      title: "Review {{release}} for {{customer}}",
      description: "Check {{release}} on {{environment}} before {{due}}. Notify the customer: {{notify}}. Extra context: {{notes}}. Limit to {{max_issues}} issues.",
      variables: [
        { name: "release", label: null, type: "text", defaultValue: null, required: true, options: [] },
        { name: "customer", label: "Customer", type: "text", defaultValue: "Acme", required: true, options: [] },
        { name: "environment", label: null, type: "select", defaultValue: "staging", required: true, options: ["staging", "production"] },
        { name: "due", label: "Due date", type: "date", defaultValue: null, required: false, options: [] },
        { name: "notify", label: null, type: "boolean", defaultValue: true, required: false, options: [] },
        { name: "notes", label: null, type: "textarea", defaultValue: null, required: false, options: [] },
        { name: "max_issues", label: null, type: "number", defaultValue: 5, required: false, options: [] },
      ],
    },
  },
};
const savedWebhooks = routineScenarios.scheduleAndWebhooks.routine.triggers.filter((trigger) => trigger.kind === "webhook");
/** Click a webhook to configure it, hover for the remove button, or add one. All of it works on local state. */
export const WithWebhooks: Story = {
  render: (args) => <RoutineEditDialogPreview {...args} initialWebhooks={savedWebhooks} />,
};
export const NoWebhooksYet: Story = {
  render: (args) => <RoutineEditDialogPreview {...args} />,
};
export const ConfigureWebhookInPlace: Story = {
  render: (args) => <RoutineEditDialogPreview {...args} initialWebhooks={savedWebhooks} />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole("button", { name: "Configure Webhook · Sentry" }));
    await expect(await body.findByText("The last event was rejected")).toBeVisible();
  },
};
export const AddWebhookInPlace: Story = {
  render: (args) => <RoutineEditDialogPreview {...args} />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole("button", { name: "Add webhook" }));
    await userEvent.click(await body.findByRole("button", { name: "Create webhook" }));
    await expect(await body.findByText("Waiting for a test event")).toBeVisible();
  },
};
export const WebhookRemovedWithUndo: Story = {
  render: (args) => <RoutineEditDialogPreview {...args} initialWebhooks={savedWebhooks} />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole("button", { name: "Remove Webhook · Zendesk" }));
    await expect(await body.findByRole("button", { name: "Undo" })).toBeVisible();
  },
};
export const AddSecretInOneClick: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole("button", { name: "Add secret" }));
    await expect(await body.findByLabelText("Variable name")).toBeVisible();
  },
};
export const ResponsibilityChosen: Story = {
  args: { initial: { ...scheduled, responsibilityId: routineResponsibilities[0]!.id }, responsibilities: routineResponsibilities.map((item) => ({ ...item, projectIds: [] })) },
};
export const ResponsibilityNotChosen: Story = {
  args: { responsibilities: routineResponsibilities.map((item) => ({ ...item, projectIds: [] })) },
};
export const ResponsibilityThroughProject: Story = { args: { responsibilities: routineResponsibilities } };
export const NoSchedule: Story = { args: { initial: { ...scheduled, schedule: null } } };
export const NewRoutine: Story = { args: { mode: "create", initial: EMPTY_ROUTINE_FORM_DRAFT } };
export const Saving: Story = { args: { saving: true } };
export const ChangedElsewhere: Story = { args: { saveConflict: true } };
export const SaveFailed: Story = { args: { mode: "create", initial: scheduled, error: "Couldn’t save. Check your connection and try again." } };
export const ResponsibleUserLocked: Story = { args: { canChangeResponsibleUser: false } };
export const Phone: Story = { args: { initial: withVariables }, globals: { viewport: { value: "mobile1", isRotated: false } } };
