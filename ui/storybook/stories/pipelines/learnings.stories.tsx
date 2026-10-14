import { within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { Learnings } from "@/pages/Pipelines";
import { installPipelineFixture } from "../../support/capability-gaps/pipelines";
import type { FixtureState } from "../../support/capability-gaps/api";
function Host() {
  return <Learnings />;
}
const meta = {
  id: "feature-pipeline-learnings",
  title:
    "Automation and structured work/Pipelines, review queues, and learnings/Learnings",
  component: Host,
  parameters: {
    layout: "padded",
    initialEntries: ["/PAP/learnings"],
    docs: {
      description: {
        component:
          "Shipped Learnings with isolated API receipts. Guards, durable transitions, automation execution and learning provenance require production tests.",
      },
    },
    paperclip: {
      "capabilities": [
        "pipelines/learnings"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Production Learnings feed renders a review_decided event plus loading/empty/error/403. Event provenance and durable audit records remain separate; this is not a new learning-record subsystem."
    },
  },
  beforeEach: ({ parameters }) =>
    installPipelineFixture(parameters.fixtureState as FixtureState).cleanup,
} satisfies Meta<typeof Host>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(/Release reviewer approved/);
  },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Empty: Story = { parameters: { fixtureState: "empty" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
