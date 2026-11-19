import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { RoutinePagePreview } from "../../support/routines/RoutinePagePreview";

const meta = {
  id: "routine-page-design",
  title: "Automation and structured work/Routines, schedules, and triggers/Routine page/Page",
  component: RoutinePagePreview,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/routines/routine-weekly-digest"],
    docs: { description: { component: "The routine page at /routines/:routineId. Left column: title, on/off status with the next run, what it repeats on, default agent, default responsible user and project. Right column: instructions cut to the first paragraph with Show all, then the tasks the routine created, a page at a time with Load more. The on/off toggle is the only control that changes the routine directly; an existing schedule or webhook opens when clicked, and everything else, including adding a webhook, happens in the Edit dialog. While paused, a notice says schedules are skipped and webhook events are ignored. Variables, secrets and non-default run rules appear only when the routine has them. The menu leads to Version history, Audit log and Archive. Responsibility is experimental: with areas of responsibility switched on, a Responsibility field appears under Project on the page and in the Edit dialog; with it off (every other story) the field is absent. These stories drive the shipped components from local fixture state so every control can be clicked through; the Routed page stories mount the real page on a fixture API." } },
    paperclip: {
      capabilities: ["routines/definition", "routines/management", "routines/history", "routines/triggers"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Fixture controller around the shipped RoutinePage, RoutinePageActions, RoutineSubpage, RoutineEditDialog, RoutineWebhookDialog and RoutineRunVariablesDialog, the same components RoutineDetail renders at /routines/:routineId (see Routine page/Routed page for the routed page on a fixture API). Every change stays in local state; nothing calls the routines API. The frame is DesignPageShell and DesignSidebar, not the app Layout. Version history mounts RoutineHistoryTab and Audit log RoutineAuditActivity on seeded query data; restore is a no-op. Responsibility is experimental and flag-gated (enableResponsibilities): these stories pass fixture responsibilities directly and never call the responsibility link API. Delivery settings have no editor; saved non-default values show read-only as Run rules and are kept on save. Test webhook is backed by PATCH /routine-triggers/:id setupPending on the server; here the test event is simulated a moment after testing starts.",
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
/** A standing check or API trigger opens a small popover to pause, resume or remove it. */
export const StandingCheckOpened: Story = {
  args: { scenario: "standingCheck" },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Change Standing check" }));
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByRole("button", { name: "Pause" })).toBeVisible();
    await expect(body.getByRole("button", { name: "Remove" })).toBeVisible();
  },
};
/** One paused schedule on an active routine: its popover offers Resume. */
export const ScheduleTriggerPaused: Story = { args: { scenario: "scheduleTriggerPaused" } };
export const ScheduleTriggerPausedOpened: Story = {
  args: { scenario: "scheduleTriggerPaused" },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: /Change schedule/ }));
    await expect(await within(canvasElement.ownerDocument.body).findByRole("button", { name: "Resume" })).toBeVisible();
  },
};
/** Removing a schedule (or a webhook, standing check or API trigger) from the page leaves a "removed. Undo" line under Repeats. */
export const RemovedWithUndo: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Change schedule/ }));
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole("button", { name: "Remove schedule" }));
    await expect(await canvas.findByRole("button", { name: "Undo" })).toBeVisible();
  },
};
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
