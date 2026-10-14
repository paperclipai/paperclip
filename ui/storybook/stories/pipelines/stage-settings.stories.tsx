import { within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { PipelineSettings } from "@/pages/PipelineSettings";
import { installPipelineFixture } from "../../support/capability-gaps/pipelines";
import type { FixtureState } from "../../support/capability-gaps/api";
function Host() {
  return (
    <Routes>
      <Route
        path="/PAP/pipelines/:pipelineId/settings"
        element={<PipelineSettings />}
      />
    </Routes>
  );
}
const meta = {
  id: "feature-pipeline-stages",
  title:
    "Automation and structured work/Pipelines, review queues, and learnings/Stage settings",
  component: Host,
  parameters: {
    layout: "padded",
    initialEntries: ["/PAP/pipelines/pipeline-gap/settings"],
    docs: {
      description: {
        component:
          "Shipped PipelineSettings with isolated API receipts. Guards, durable transitions, automation execution and learning provenance require production tests.",
      },
    },
    paperclip: {
      "capabilities": [
        "pipelines/stages"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Production PipelineSettings stage editor with filled configuration, no stages, pending/error/403. This pass renders the shipped controls; saved stage/automation changes remain production obligations."
    },
  },
  beforeEach: ({ parameters }) =>
    installPipelineFixture(parameters.fixtureState as FixtureState, {
      emptyStages: parameters.fixtureState === "empty",
    }).cleanup,
} satisfies Meta<typeof Host>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByDisplayValue("Release review");
  },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Empty: Story = {
  parameters: { fixtureState: "empty" },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("No stages configured.");
  },
};
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
