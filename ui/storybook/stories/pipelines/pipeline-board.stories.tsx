import { within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { Pipelines } from "@/pages/Pipelines";
import { installPipelineFixture } from "../../support/capability-gaps/pipelines";
import type { FixtureState } from "../../support/capability-gaps/api";
function Host() {
  return (
    <Routes>
      <Route path="/PAP/pipelines/:pipelineId" element={<Pipelines />} />
    </Routes>
  );
}
const meta = {
  id: "feature-pipeline-board",
  title:
    "Automation and structured work/Pipelines, review queues, and learnings/Items",
  component: Host,
  parameters: {
    layout: "padded",
    initialEntries: ["/PAP/pipelines/pipeline-gap"],
    docs: {
      description: {
        component:
          "Shipped Pipelines with isolated API receipts. Guards, durable transitions, automation execution and learning provenance require production tests.",
      },
    },
    paperclip: {
      "capabilities": [
        "pipelines/items"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Production Pipelines board with stages/items and loading/empty/error/403. Snapshot rows only; transitions, liveness, guards and automation execution remain separate."
    },
  },
  beforeEach: ({ parameters }) =>
    installPipelineFixture(parameters.fixtureState as FixtureState).cleanup,
} satisfies Meta<typeof Host>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByText("Ship the release notes");
  },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Empty: Story = { parameters: { fixtureState: "empty" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
