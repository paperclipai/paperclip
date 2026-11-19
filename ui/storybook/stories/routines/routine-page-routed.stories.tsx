import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { prepareFixtureApi, type FixtureState } from "../../support/capability-gaps/api";
import { RoutedRoutinePage, routedRoutineFixtureRoutes } from "../../support/routines/RoutedRoutinePage";
import { ROUTINE_ID, type RoutineScenarioKey } from "../../support/routines/routine-page-data";

const routinePath = (suffix = "") => `/PAP/routines/${ROUTINE_ID}${suffix}`;

const meta = {
  id: "routine-page-routed",
  title: "Automation and structured work/Routines, schedules, and triggers/Routine page/Routed page",
  component: RoutedRoutinePage,
  parameters: {
    layout: "fullscreen",
    initialEntries: [routinePath()],
    routineScenario: "scheduled" satisfies RoutineScenarioKey,
    docs: {
      description: {
        component:
          "The real RoutineDetail route in the app shell, on an in-memory routines API seeded from the same scenarios as the Routine page stories. Each story here has a matching Page story with the same data, so the routed page and the prop-driven page can be compared side by side. History loads 20 tasks a page from the issues list; Version history and Audit log are the /history and /activity sub-views; older section addresses redirect to the page.",
      },
    },
    paperclip: {
      capabilities: ["routines/definition", "routines/management", "routines/history", "routines/triggers", "activity/routine-audit"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Mounts Layout with the shipped Routines and RoutineDetail routes. Routine, triggers, history pages, revisions, audit events, people and skills come from fixture routes seeded by routine-page-data scenarios; status, schedule, webhook and Run now changes update that in-memory state. Responsibility stays off (the experimental flag is unset); instruction comments need a description document and are not seeded. Scheduling, webhook delivery and execution are not live.",
    },
  },
  beforeEach: ({ parameters }) =>
    prepareFixtureApi(
      routedRoutineFixtureRoutes(parameters.routineScenario as RoutineScenarioKey),
      parameters.fixtureState as FixtureState,
    ).cleanup,
} satisfies Meta<typeof RoutedRoutinePage>;

export default meta;
type Story = StoryObj<typeof meta>;

const page = () => within(document.body);

/** Matches Routine page/Page › Scheduled. */
export const Scheduled: Story = {
  play: async () => {
    await expect(await page().findByRole("heading", { name: "Send the weekly product digest" })).toBeVisible();
    await expect(await page().findByText("Weekly product digest · Nov 16")).toBeVisible();
  },
};

/** Matches Page › HistoryLoadMore: 40 tasks, 20 a page. */
export const HistoryLoadMore: Story = {
  parameters: { routineScenario: "longHistory" },
  play: async () => {
    const loadMore = await page().findByRole("button", { name: "Load more" });
    await expect(page().queryByText("Weekly product digest · week 27")).not.toBeInTheDocument();
    await userEvent.click(loadMore);
    await expect(await page().findByText("Weekly product digest · week 27")).toBeVisible();
    await waitFor(() => expect(page().queryByRole("button", { name: "Load more" })).not.toBeInTheDocument());
  },
};

/** Matches Page › VariablesAndSecrets. */
export const VariablesAndSecrets: Story = { parameters: { routineScenario: "variablesAndSecrets" } };

/** Matches Page › ScheduleAndWebhooks. */
export const ScheduleAndWebhooks: Story = { parameters: { routineScenario: "scheduleAndWebhooks" } };

/** Matches Page › PausedWebhookIgnored. */
export const PausedWebhookIgnored: Story = { parameters: { routineScenario: "pausedWebhook" } };

/** Matches Page › PausedWebhookOpened: the webhook opens from the Repeats list. */
export const PausedWebhookOpened: Story = {
  parameters: { routineScenario: "pausedWebhook" },
  play: async () => {
    await userEvent.click(await page().findByRole("button", { name: "Open Webhook · Deployment completed" }));
    const dialog = await page().findByRole("dialog");
    await expect(await within(dialog).findByText("Ignoring events while the routine is paused")).toBeVisible();
  },
};

/** Matches Page › DraftWithoutAgent. */
export const DraftWithoutAgent: Story = { parameters: { routineScenario: "draft" } };

/** Matches Page › EditingRoutine. */
export const EditingRoutine: Story = {
  play: async () => {
    await userEvent.click(await page().findByRole("button", { name: "Edit routine" }));
    await expect(await page().findByRole("dialog")).toBeVisible();
  },
};

/** Matches Page › MenuVersionHistory. */
export const VersionHistory: Story = {
  parameters: { initialEntries: [routinePath("/history")] },
  play: async () => {
    await expect(await page().findByRole("heading", { name: "Version history" })).toBeVisible();
  },
};

/** Matches Page › MenuAuditLog. */
export const AuditLog: Story = {
  parameters: { initialEntries: [routinePath("/activity")] },
  play: async () => {
    await expect(await page().findByRole("heading", { name: "Audit log" })).toBeVisible();
  },
};

/** An old section address (here /triggers) lands on the single page. */
export const OldSectionRedirects: Story = {
  parameters: { initialEntries: [routinePath("/triggers")] },
  play: async () => {
    await expect(await page().findByRole("heading", { name: "Send the weekly product digest" })).toBeVisible();
    await expect(page().queryByRole("navigation", { name: "Routine navigation" })).not.toBeInTheDocument();
  },
};

export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };

/** Matches Page › Phone: actions sit above the page instead of the breadcrumb toolbar. */
export const Phone: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
