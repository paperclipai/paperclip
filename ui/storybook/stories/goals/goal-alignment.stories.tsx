import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { GoalDetail } from "@/pages/GoalDetail";
import { expect, userEvent, within } from "storybook/test";
import {
  storybookGoals,
  storybookProjects,
} from "../../fixtures/paperclipData";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
function Goal() {
  return (
    <Routes>
      <Route path="/PAP/goals/:goalId" element={<GoalDetail />} />
    </Routes>
  );
}
const goal = {
  ...storybookGoals[0],
  id: "goal-gap",
  title: "Qualify the release",
};
const meta = {
  id: "feature-goal-alignment",
  title:
    "Projects and execution/Goals and work alignment/Aligned work and navigation",
  component: Goal,
  parameters: { layout: "padded", initialEntries: ["/PAP/goals/goal-gap"],
    paperclip: {
      "capabilities": [
        "goals/alignment",
        "goals/navigation"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "GoalDetail child navigation and aligned-project tab with empty/loading/failure/403. Current UI displays relationships but has no project goal-assignment control; no invented assignment UI."
    },
  },
  beforeEach: ({ parameters }) =>
    prepareFixtureApi(
      [
        { path: "/api/goals/goal-gap", read: () => goal },
        {
          path: "/api/companies/company-storybook/goals",
          read: () =>
            parameters.fixtureState === "empty"
              ? [goal]
              : [
                  goal,
                  {
                    ...goal,
                    id: "child-goal-gap",
                    title: "Verify provider access",
                    parentId: goal.id,
                  },
                ],
        },
        {
          path: "/api/companies/company-storybook/projects",
          read: () =>
            parameters.fixtureState === "empty"
              ? []
              : [
                  {
                    ...storybookProjects[0],
                    name: "Release workspace",
                    goalId: goal.id,
                    goalIds: [goal.id],
                    goals: [{ id: goal.id, title: goal.title }],
                  },
                ],
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup,
} satisfies Meta<typeof Goal>;
export default meta;
type Story = StoryObj<typeof meta>;
export const GoalAndChildren: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("link", {
        name: /Verify provider access/,
      }),
    ).toHaveAttribute("href", "/PAP/goals/child-goal-gap");
  },
};
export const AlignedProject: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("tab", { name: /Projects/ }));
    await c.findByText("Release workspace");
  },
};
export const EmptyRelationships: Story = {
  parameters: { fixtureState: "empty" },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
