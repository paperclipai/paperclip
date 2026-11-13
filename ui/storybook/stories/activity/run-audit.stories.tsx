import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { AuditRuns } from "@/pages/audit/AuditRuns";
import {
  storybookLiveRuns,
  storybookAgents,
} from "../../fixtures/paperclipData";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
const meta = {
  id: "feature-run-audit",
  title:
    "Oversight and operation/Dashboards and audit trails/Execution history",
  component: AuditRuns,
  args: { companyId: "company-storybook" },
  parameters: { layout: "padded",
    paperclip: {
      "capabilities": [
        "activity/runs"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "AuditRuns list, completed receipt, empty/loading/failed/denied and no-match filter. Run records are fixture snapshots; no real execution or scoped audit proof."
    },
  },
  beforeEach: ({ parameters }) =>
    prepareFixtureApi(
      [
        {
          path: "/api/companies/company-storybook/heartbeat-runs",
          read: () =>
            parameters.fixtureState === "empty"
              ? []
              : [
                  {
                    ...storybookLiveRuns[0],
                    id: "run-gap",
                    agentId: storybookAgents[0].id,
                    status: "succeeded",
                    invocationSource: "on_demand",
                    startedAt: "2026-10-12T12:00:00Z",
                    finishedAt: "2026-10-12T12:01:00Z",
                    resultJson: { summary: "Reviewed the release checklist" },
                  },
                ],
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup,
} satisfies Meta<typeof AuditRuns>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CompletedRun: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Reviewed the release checklist");
  },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Empty: Story = { parameters: { fixtureState: "empty" } };
export const Failed: Story = {
  parameters: { fixtureState: "failure" },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(
      "The request failed. Please try again.",
    );
  },
};
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(
      "You do not have permission to perform this action.",
    );
  },
};
export const FilterNoMatches: Story = {
  parameters: { initialEntries: ["/PAP/audit?runStatus=failed"] },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: /Clear filters/,
      }),
    ).toBeEnabled();
    const c = within(canvasElement);
    await expect(
      await c.findByText("No runs match these filters."),
    ).toBeVisible();
    await expect(
      c.queryByText("Reviewed the release checklist"),
    ).not.toBeInTheDocument();
  },
};
