import type { Meta, StoryObj } from "@storybook/react-vite";
import { RoutinePagePreview } from "../../support/design-proposals/RoutinePagePreview";

const meta = {
  id: "routine-page-design",
  title: "Design proposals/Pages/Routine",
  component: RoutinePagePreview,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/routines/routine-weekly-digest"],
    docs: { description: { component: "Proposed single-page routine view that replaces the section sidebar. Left column: title, on/off status with the next run, what it repeats on, default agent, default responsible user and project. Right column: instructions cut to the first paragraph with Show all, then the tasks the routine created, loaded a page at a time. The on/off toggle is the only control that changes the routine directly; an existing schedule or webhook opens for editing when clicked, and everything else, including adding a webhook, happens in the Edit modal. While paused, a notice says schedules are skipped and webhook events are ignored. Variables, secrets and non-default run rules appear only when the routine has them. The menu leads to Version history, Audit log and Archive. With areas of responsibility switched on, a Responsibility field appears under Project on the page and in the Edit modal; with it off (every other story) the field is absent. Every control changes local fixture state so the page can be clicked through." } },
    paperclip: {
      capabilities: ["routines/definition", "routines/management"],
      status: "proposed",
      home: "design-proposals",
      exception: "Routine page redesign staged for visual approval before it replaces the routed RoutineDetail sections.",
      implementation: "prototype",
      boundary: "fixtures",
      notes: "Composes the new prop-driven RoutinePage, RoutinePageActions, RoutineEditDialog and RoutineWebhookDialog with the shipped DesignPageShell, DesignSidebar, TaskSummaryList, ScheduleEditor, MarkdownBody, MarkdownEditor, RoutineVariablesEditor, EnvironmentVariablesEditor, webhook CopyField/AgentInstructions and RoutineRunVariablesDialog. Nothing is wired to the routines API or the /routines route yet. Version history mounts the shipped RoutineHistoryTab and Audit log the shipped RoutineAuditActivity, both on seeded query data; their routes and restore are not wired. Responsibility is prop-driven: the stories pass fixture responsibilities instead of reading the enableResponsibilities flag, and saving does not call the responsibility link API. Delivery settings have no editor in this proposal; saved non-default values are shown read-only as Run rules.",
    },
  },
} satisfies Meta<typeof RoutinePagePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Scheduled: Story = {};
export const VariablesAndSecrets: Story = { args: { scenario: "variablesAndSecrets" } };
export const WebhookOnly: Story = { args: { scenario: "webhookOnly" } };
export const ScheduleAndWebhooks: Story = { args: { scenario: "scheduleAndWebhooks" } };
export const Paused: Story = { args: { scenario: "paused" } };
export const PausedWebhookIgnored: Story = { args: { scenario: "pausedWebhook" } };
export const PausedScheduleAndWebhook: Story = { args: { scenario: "pausedScheduleAndWebhook" } };
export const PausedWebhookOpened: Story = { args: { scenario: "pausedWebhook", initialDialog: "webhook" } };
export const DraftWithoutAgent: Story = { args: { scenario: "draft" } };
export const ManualOnly: Story = { args: { scenario: "manualOnly" } };
export const FirstRunPending: Story = { args: { scenario: "firstRunPending" } };
export const NoInstructions: Story = { args: { scenario: "noInstructions" } };
export const StandingCheckAndApi: Story = { args: { scenario: "standingCheck" } };
export const CustomRunRules: Story = { args: { scenario: "customRunRules" } };
export const ManagedByPlugin: Story = { args: { scenario: "pluginManaged" } };
export const Archived: Story = { args: { scenario: "archived" } };
export const ResponsibleUserLocked: Story = { args: { scenario: "responsibleUserLocked" } };
export const HistoryLoadMore: Story = { args: { scenario: "longHistory" } };
export const CommentedInstructions: Story = { args: { scenario: "commentedInstructions" } };
export const EditingRoutine: Story = { args: { initialDialog: "edit" } };
export const EditingWithVariablesAndSecrets: Story = { args: { scenario: "variablesAndSecrets", initialDialog: "edit" } };
export const EditingAddWebhook: Story = { args: { initialDialog: "edit-webhook" } };
export const EditingWithWebhooks: Story = { args: { scenario: "scheduleAndWebhooks", initialDialog: "edit" } };
export const WebhookOpenedFromPage: Story = { args: { scenario: "webhookOnly", initialDialog: "webhook" } };
export const MoreMenuOpen: Story = { args: { menuOpen: true } };
export const MenuVersionHistory: Story = { args: { initialView: "versions" } };
export const MenuAuditLog: Story = { args: { initialView: "audit" } };
export const MenuArchiveResult: Story = { args: { scenario: "archived", menuOpen: true } };
export const ResponsibilityLinked: Story = { args: { responsibility: "direct" } };
export const ResponsibilityNone: Story = { args: { responsibility: "none" } };
export const ResponsibilityThroughProject: Story = { args: { responsibility: "project" } };
export const ResponsibilityLinkedAndThroughProject: Story = { args: { responsibility: "both" } };
export const EditingResponsibility: Story = { args: { responsibility: "direct", initialDialog: "edit" } };
export const RunNowAsksForValues: Story = { args: { scenario: "variablesAndSecrets", initialDialog: "run" } };
export const Phone: Story = { args: { shell: false }, globals: { viewport: { value: "mobile1", isRotated: false } } };
export const PhoneWebhooks: Story = {
  args: { shell: false, scenario: "scheduleAndWebhooks" },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
