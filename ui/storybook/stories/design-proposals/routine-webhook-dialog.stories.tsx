import type { Meta, StoryObj } from "@storybook/react-vite";
import { RoutineWebhookDialog } from "@/components/routine-page/RoutineWebhookDialog";
import { DEMO_WEBHOOK_KEY, webhookTrigger } from "../../support/design-proposals/routine-page-data";

const receivedAt = new Date().toISOString();

const meta = {
  id: "routine-webhook-dialog-design",
  title: "Design proposals/Components/Routine/Webhook dialog",
  component: RoutineWebhookDialog,
  args: {
    open: true,
    onOpenChange: () => {},
    routineTitle: "Verify a deployment",
    trigger: null,
    onCreate: () => {},
    onReplaceKey: () => {},
    onSetPaused: () => {},
    onRemove: () => {},
    onStartTest: () => {},
    onFinishTest: () => {},
  },
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "One modal for a routine webhook. Adding asks only what is sending it. Once created, the same modal shows the URL and key to copy and reports the test event as it arrives. Opening an existing webhook shows its health, the URL, and Replace key, with Remove and Pause in the footer. Test webhook puts a finished webhook back into test mode: the next event is checked and reported here without starting the routine, and Finish testing returns it to live." } },
    paperclip: {
      capabilities: ["routines/definition", "routines/management"],
      status: "proposed",
      home: "design-proposals",
      exception: "Routine webhook modal staged for visual approval with the routine page proposal; it replaces the full-page trigger wizard.",
      implementation: "prototype",
      boundary: "fixtures",
      notes: "New RoutineWebhookDialog reusing the shipped CopyField, AgentInstructions, WebhookUrlWarning and webhookAgentInstructions. Trigger states are fixtures; no webhook is created, tested, rotated or removed. Test mode after setup is not available on the server yet: the trigger update API only accepts clearing setupPending, so re-entering it needs a server change. The key shown is a placeholder.",
    },
  },
} satisfies Meta<typeof RoutineWebhookDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const pending = webhookTrigger({ setupPending: true, lastWebhookDelivery: null });

export const ChooseSender: Story = {};
export const Creating: Story = { args: { busy: true } };
export const CreatedWaitingForTest: Story = { args: { trigger: pending, secret: DEMO_WEBHOOK_KEY } };
export const CreatedForGitHub: Story = {
  args: { trigger: { ...pending, signingMode: "github_hmac" }, secret: DEMO_WEBHOOK_KEY },
};
export const TestReceived: Story = {
  args: {
    trigger: { ...pending, lastWebhookDelivery: { status: "received", receivedAt, test: true } },
    secret: DEMO_WEBHOOK_KEY,
  },
};
export const TestRejected: Story = {
  args: {
    trigger: { ...pending, lastWebhookDelivery: { status: "rejected", receivedAt, test: true } },
    secret: DEMO_WEBHOOK_KEY,
  },
};
export const ReceivingEvents: Story = { args: { trigger: webhookTrigger({ label: "Deployment completed" }) } };
export const ReadyNoEventsYet: Story = { args: { trigger: webhookTrigger({ lastWebhookDelivery: null }) } };
export const KeyRejected: Story = {
  args: { trigger: webhookTrigger({ label: "Sentry", lastWebhookDelivery: { status: "rejected", receivedAt, test: false } }) },
};
export const KeyReplaced: Story = { args: { trigger: webhookTrigger({ label: "Sentry" }), secret: DEMO_WEBHOOK_KEY } };
export const TestingWaiting: Story = { args: { trigger: webhookTrigger({ label: "Sentry", setupPending: true, lastWebhookDelivery: null }), testing: true } };
export const TestingEventReceived: Story = {
  args: {
    trigger: webhookTrigger({ label: "Sentry", setupPending: true, lastWebhookDelivery: { status: "received", receivedAt, test: true } }),
    testing: true,
  },
};
export const TestingEventRejected: Story = {
  args: {
    trigger: webhookTrigger({ label: "Sentry", setupPending: true, lastWebhookDelivery: { status: "rejected", receivedAt, test: true } }),
    testing: true,
  },
};
export const RoutinePaused: Story = { args: { trigger: webhookTrigger({ label: "Deployment completed" }), routineActive: false } };
export const Paused: Story = { args: { trigger: webhookTrigger({ enabled: false }) } };
export const LocalAddressWarning: Story = {
  args: { trigger: webhookTrigger({ webhookUrl: "http://localhost:3100/api/routine-triggers/public/0123456789abcdef01234567/fire" }) },
};
export const RemoveFailed: Story = { args: { trigger: webhookTrigger(), error: "Couldn’t remove this webhook. Try again." } };
export const Phone: Story = {
  args: { trigger: pending, secret: DEMO_WEBHOOK_KEY },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
