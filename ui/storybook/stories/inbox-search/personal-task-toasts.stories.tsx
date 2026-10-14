import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { LiveUpdatesProvider } from "@/context/LiveUpdatesProvider";
import { ToastViewport } from "@/components/ToastViewport";
import { Button } from "@/components/ui/button";
import { expect, userEvent, within, waitFor } from "storybook/test";
import {
  installLiveEventFixture,
  listenForFixtureSocket,
  publishFixtureEvent,
} from "../../support/capability-gaps/live-events";
function Publish({ eligible = true }: { eligible?: boolean }) {
  const [ready, setReady] = useState(false);
  useEffect(() => listenForFixtureSocket(() => setReady(true)), []);
  return (
    <>
      <Button
        disabled={!ready}
        onClick={() =>
          publishFixtureEvent({
            id: 1,
            companyId: "company-storybook",
            type: "activity.logged",
            createdAt: new Date().toISOString(),
            toastEligible: eligible,
            payload: {
              entityType: "issue",
              entityId: "toast-task",
              action: "issue.created",
              actorType: "user",
              actorId: "another-user",
              actorName: "Release reviewer",
              details: {
                issueIdentifier: "PAP-42",
                issueTitle: "Review the release",
              },
            },
          })
        }
      >
        Publish task update
      </Button>
      <ToastViewport />
    </>
  );
}
function TaskNotifications(props: { eligible?: boolean }) {
  return (
    <LiveUpdatesProvider>
      <Publish {...props} />
    </LiveUpdatesProvider>
  );
}
const meta = {
  id: "feature-personal-task-toasts",
  title:
    "Tasks and conversations/Inbox, decisions, and search/Personal task notifications",
  component: TaskNotifications,
  parameters: {
    layout: "padded",
    initialEntries: ["/PAP/dashboard"],
    docs: {
      description: {
        component:
          "Production socket consumer and toast viewport. Server eligibility metadata is simulated; persisted participation and mentions require multiplayer tests.",
      },
    },
    paperclip: {
      "capabilities": [
        "inbox-search/toasts"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "LiveUpdatesProvider and ToastViewport consume fixture socket eligibility, suppress unrelated/visible-task events and deduplicate replay. Server eligibility metadata is simulated; no persisted multiplayer participation proof. The upstream Inbox recipe adds agent-created-task discovery checks; this LiveUpdatesProvider suite still tests toast eligibility only."
    },
  },
  beforeEach: installLiveEventFixture,
} satisfies Meta<typeof TaskNotifications>;
export default meta;
type Story = StoryObj<typeof meta>;
async function publish(canvasElement: HTMLElement) {
  const button = await within(canvasElement).findByRole("button", {
    name: "Publish task update",
  });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
}
export const EligibleTask: Story = {
  play: async ({ canvasElement }) => {
    await publish(canvasElement);
    await within(document.body).findByText(/Release reviewer created/);
  },
};
export const UnrelatedTaskStaysQuiet: Story = {
  args: { eligible: false },
  play: async ({ canvasElement }) => {
    await publish(canvasElement);
    await expect(
      within(document.body).queryByText(/Release reviewer created/),
    ).not.toBeInTheDocument();
  },
};
export const VisibleTaskStaysQuiet: Story = {
  parameters: { initialEntries: ["/PAP/issues/toast-task"] },
  play: async ({ canvasElement }) => {
    await publish(canvasElement);
    await expect(
      within(document.body).queryByText(/Release reviewer created/),
    ).not.toBeInTheDocument();
  },
};
export const DuplicateDelivery: Story = {
  play: async ({ canvasElement }) => {
    await publish(canvasElement);
    await within(document.body).findByText(/Release reviewer created/);
    await publish(canvasElement);
    await expect(
      within(document.body).getAllByText(/Release reviewer created/),
    ).toHaveLength(1);
  },
};
