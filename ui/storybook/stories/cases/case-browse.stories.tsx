import type { Meta, StoryObj } from "@storybook/react-vite";
import { Cases } from "@/pages/Cases";
import { within } from "storybook/test";
import { installCaseFixtures } from "../../support/capability-gaps/cases";
import type { FixtureState } from "../../support/capability-gaps/api";
const meta = {
  id: "feature-case-browse",
  title: "Automation and structured work/Cases/Browse and hierarchy",
  component: Cases,
  parameters: { layout: "padded",
    paperclip: {
      "capabilities": [
        "cases/browse"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Cases page with fixture parent/child records and loading/empty/error/403. Failed list queries currently use the shipped empty-case presentation. Responsive duplicate labels are accounted for; server filters and case mutations remain separate."
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
