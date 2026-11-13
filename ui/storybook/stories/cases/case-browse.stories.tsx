import type { Meta, StoryObj } from "@storybook/react-vite";
import { Cases } from "@/pages/Cases";
import { within } from "storybook/test";
import { installCaseFixtures } from "../../support/capability-gaps/cases";
import type { FixtureState } from "../../support/capability-gaps/api";
const meta = {
  id: "feature-case-browse",
  title: "Automation and structured work/Cases/Browse",
  component: Cases,
  parameters: { layout: "padded",
    paperclip: {
      "capabilities": [
        "cases/browse"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Read-only production Cases page with fixture records and loading, empty, error and denied access states. Shared list header presents Columns, Filter, Sort and Group controls. No status or label editors are exposed. Full control interactions use the Read-only pages suite; server filtering, ordering and persistence are verified separately."
    },
  },
  beforeEach: ({ parameters }) => {
    const key = "paperclip:cases:company-storybook:view";
    const previous = localStorage.getItem(key);
    localStorage.removeItem(key);
    const cleanup = installCaseFixtures(
      parameters.fixtureState as FixtureState,
    );
    return () => {
      cleanup();
      if (previous) localStorage.setItem(key, previous);
      else localStorage.removeItem(key);
    };
  },
} satisfies Meta<typeof Cases>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReviewCases: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByText("Release readiness");
  },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Empty: Story = { parameters: { fixtureState: "empty" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
