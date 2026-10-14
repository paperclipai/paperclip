import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { Routes, Route } from "@/lib/router";
import { ReviewQueue } from "@/pages/Pipelines";
import { installPipelineFixture } from "../../support/capability-gaps/pipelines";
import type { FixtureState } from "../../support/capability-gaps/api";
function Host() {
  return <ReviewQueue />;
}
const meta = {
  id: "feature-pipeline-review",
  title:
    "Automation and structured work/Pipelines, review queues, and learnings/Review queue",
  component: Host,
  parameters: {
    layout: "padded",
    initialEntries: ["/PAP/review-queue"],
    docs: {
      description: {
        component:
          "Shipped ReviewQueue with isolated API receipts. Guards, durable transitions, automation execution and learning provenance require production tests.",
      },
    },
    paperclip: {
      "capabilities": [
        "pipelines/review"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Production ReviewQueue with empty/loading/error/403, approval removal and failure recovery marked Needs attention. Fixture decisions do not prove real review leases, version checks or transitions."
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

export const Approved: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByText("Ship the release notes");
    await userEvent.click(c.getByRole("button", { name: /^Approve$/ }));
    await waitFor(() =>
      expect(c.queryByText("Ship the release notes")).not.toBeInTheDocument(),
    );
  },
};
export const ApprovalFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByText("Ship the release notes");
    await userEvent.click(c.getByRole("button", { name: /^Approve$/ }));
    await c.findByText("Needs attention");
    await c.findByText("Ship the release notes");
  },
};
