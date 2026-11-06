import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { CaseDetail } from "@/pages/CaseDetail";
import { CaseFieldsPanel, CaseFieldsTable } from "@/components/CaseFieldsPanel";
import { IssueCasesPanel } from "@/components/IssueCasesPanel";
import { instanceExperimentalSettingsSchema } from "@paperclipai/shared";
import { expect, within } from "storybook/test";
import {
  caseItem,
  installCaseFixtures,
} from "../../support/capability-gaps/cases";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
function CaseDetailHost() {
  return (
    <Routes>
      <Route path="/PAP/cases/:caseIdentifier" element={<CaseDetail />} />
    </Routes>
  );
}
const meta = {
  id: "feature-case-detail",
  title:
    "Automation and structured work/Cases/Structure, history and task links",
  component: CaseDetailHost,
  parameters: { layout: "padded", initialEntries: ["/PAP/cases/PAP-C42"],
    paperclip: {
      "capabilities": [
        "cases/structure",
        "cases/history",
        "cases/task-links",
        "cases/handoffs"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "CaseDetail hierarchy, compact monospace CaseFieldsTable with dotted nested paths, Audit navigation, CaseFieldsPanel arbitrary/empty data and IssueCasesPanel reverse links. Original ActivityHistory story ID retained for the Audit link scenario. Fixture relations and handoffs; Audit delivery, document revision history and persisted links remain production obligations."
    },
  },
  beforeEach: ({ parameters }) => {
    const cleanup = installCaseFixtures(
      parameters.fixtureState as FixtureState,
      parameters.fixtureWorkflow as "waiting" | "blocked" | undefined,
    );
    const flags = prepareFixtureApi([
      {
        path: "/api/instance/settings/experimental",
        read: () => ({
          ...instanceExperimentalSettingsSchema.parse({}),
          enableCases: true,
        }),
      },
    ]);
    return () => {
      flags.cleanup();
      cleanup();
    };
  },
} satisfies Meta<typeof CaseDetailHost>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Detail: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("heading", {
      name: "Release readiness",
    });
  },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
export const WorkflowWaiting: Story = {
  parameters: { fixtureWorkflow: "waiting" },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Waiting for Codex Coder to finish.");
  },
};
export const WorkflowBlocked: Story = {
  parameters: { fixtureWorkflow: "blocked" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByText("Waiting for the outgoing workspace to finish saving.");
    await expect(c.queryByRole("button", { name: "Retry handoff" })).not.toBeInTheDocument();
    await expect(c.queryByRole("button", { name: "Cancel handoff" })).not.toBeInTheDocument();
  },
};
export const ActivityHistory: Story = {
  name: "Audit navigation",
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(await c.findByRole("link", { name: "View in Audit" })).toHaveAttribute(
      "href", "/PAP/activity?entityType=case&entityId=case-gap",
    );
    await expect(c.queryByText("Activity", { exact: true })).not.toBeInTheDocument();
  },
};
export const ArbitraryFields: Story = {
  render: () => <CaseFieldsPanel fields={caseItem.fields} />,
};
export const FlattenedFieldTable: Story = {
  render: () => <CaseFieldsTable fields={{ ...caseItem.fields, task_identifier: "PAP-42" }} />,
  play: async ({ canvasElement }) => {
    const table = within(await within(canvasElement).findByRole("table", { name: "Case fields" }));
    for (const [key, value] of [["checks.tests", "pending"], ["environments.name", "staging"], ["environments.checks.build", "passed"]]) {
      const header = table.getByRole("rowheader", { name: key });
      await expect(within(header.closest("tr")!).getByRole("cell")).toHaveTextContent(value);
    }
    const taskRow = table.getByRole("rowheader", { name: "task_identifier" }).closest("tr")!;
    await expect(within(taskRow).getByRole("link", { name: "PAP-42" })).toHaveAttribute("href", "/PAP/issues/PAP-42");
  },
};
export const EmptyFields: Story = {
  render: () => <CaseFieldsPanel fields={{}} />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("No fields set");
  },
};
export const LinkedFromTask: Story = {
  render: () => <IssueCasesPanel issueId="task-gap" />,
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("link", {
        name: /Release readiness/,
      }),
    ).toHaveAttribute("href", "/PAP/cases/PAP-C42");
  },
};
