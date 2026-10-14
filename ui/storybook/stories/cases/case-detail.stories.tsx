import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { CaseDetail } from "@/pages/CaseDetail";
import { CaseFieldsPanel } from "@/components/CaseFieldsPanel";
import { IssueCasesPanel } from "@/components/IssueCasesPanel";
import { instanceExperimentalSettingsSchema } from "@paperclipai/shared";
import { expect, userEvent, within } from "storybook/test";
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
        "cases/task-links"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "CaseDetail hierarchy and activity, CaseFieldsPanel arbitrary/empty data and IssueCasesPanel reverse links. Fixture relations/events; document revision history and persisted links remain production obligations."
    },
  },
  beforeEach: ({ parameters }) => {
    const cleanup = installCaseFixtures(
      parameters.fixtureState as FixtureState,
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
export const ActivityHistory: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("tab", { name: /Activity/ }));
    await c.findByText("Codex Coder");
  },
};
export const ArbitraryFields: Story = {
  render: () => <CaseFieldsPanel fields={caseItem.fields} />,
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
