import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { RoutineDetail } from "@/pages/RoutineDetail";
import { ToastViewport } from "@/components/ToastViewport";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { baseRoutine } from "../../fixtures/routineWebhooks";
import { storybookIssues } from "../../fixtures/paperclipData";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
let submitted: Record<string, unknown> | null = null;
function RunRoutine() {
  return (
    <>
      <Routes>
        <Route
          path="/PAP/routines/:routineId/:section?"
          element={<RoutineDetail />}
        />
      </Routes>
      <ToastViewport />
    </>
  );
}
const meta = {
  id: "feature-routine-run-now",
  title:
    "Automation and structured work/Routines, schedules, and triggers/Run now",
  component: RunRoutine,
  parameters: {
    layout: "padded",
    initialEntries: ["/PAP/routines/routine-gap"],
    paperclip: {
      "capabilities": [
        "routines/run-now"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "RoutineDetail manual-run dialog with required input, captured variables, pending/error/success and read states. Fictional dispatch receipt; real scheduling, coalescing, workspace authority and execution remain separate."
    },
  },
  beforeEach: ({ parameters }) => {
    submitted = null;
    let tasks: unknown[] = [];
    return prepareFixtureApi(
      [
        {
          path: "/api/routines/routine-gap",
          read: () => ({
            ...baseRoutine,
            id: "routine-gap",
            title: "Review a release",
            variables: [
              {
                name: "environment",
                label: "Environment",
                type: "text",
                required: true,
                defaultValue: "",
                options: [],
              },
            ],
          }),
        },
        { path: "/api/routines/routine-gap/runs", read: () => [] },
        { path: "/api/companies/company-storybook/issues", read: () => tasks },
        {
          path: "/api/routines/routine-gap/run",
          method: "POST",
          read: ({ body }) => {
            submitted = body;
            tasks = [
              {
                ...storybookIssues[0],
                id: "run-task-gap",
                title: "Review a release in staging",
                originKind: "routine_execution",
                originId: "routine-gap",
              },
            ];
            return {
              id: "routine-run-gap",
              companyId: "company-storybook",
              routineId: "routine-gap",
              status: "enqueued",
              linkedIssueId: "run-task-gap",
            };
          },
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof RunRoutine>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
async function openRun() {
  const c = within(document.body);
  await userEvent.click(await c.findByRole("button", { name: "Run now" }));
  return c;
}
export const RequiredInput: Story = {
  play: async () => {
    const c = await openRun();
    await expect(c.getByRole("button", { name: "Run routine" })).toBeDisabled();
  },
};
async function run() {
  const c = await openRun();
  await userEvent.type(
    within(c.getByRole("dialog")).getByRole("textbox"),
    "staging",
    { delay: 15 },
  );
  await userEvent.click(c.getByRole("button", { name: "Run routine" }));
}
export const Started: Story = {
  play: async () => {
    await run();
    await within(document.body).findByText("Routine run started");
    await waitFor(() =>
      expect(submitted?.variables).toEqual({ environment: "staging" }),
    );
  },
};
export const Starting: Story = {
  parameters: { fixtureState: "saving" },
  play: async () => {
    await run();
    await expect(
      await within(document.body).findByRole("button", { name: "Running..." }),
    ).toBeDisabled();
  },
};
export const StartFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async () => {
    await run();
    await within(document.body).findByText("Routine run failed");
  },
};
