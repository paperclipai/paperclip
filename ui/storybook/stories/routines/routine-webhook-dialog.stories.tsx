import type { Meta, StoryObj } from "@storybook/react-vite";
import { RoutineWebhookDialog } from "@/components/routine-page/RoutineWebhookDialog";
import { DEMO_WEBHOOK_KEY, webhookTrigger } from "../../support/routines/routine-page-data";

const receivedAt = new Date().toISOString();

const meta = {
  id: "routine-webhook-dialog-design",
  title: "Automation and structured work/Routines, schedules, and triggers/Routine page/Webhook dialog",
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
    docs: { description: { component: "One dialog for a routine webhook, opened from the Repeats list on the routine page or from the Edit dialog. Adding asks only what is sending it. Once created, the same dialog shows the URL and key to copy and reports the test event as it arrives. Opening an existing webhook shows its health, the URL, and Replace key, with Remove and Pause in the footer. Test webhook puts a live webhook back into test mode: events are checked and reported here without starting the routine, and Finish testing returns it to live with its last real delivery restored." } },
    paperclip: {
      capabilities: ["routines/triggers", "routines/definition"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "The shipped RoutineWebhookDialog with CopyField, AgentInstructions, WebhookUrlWarning and webhookAgentInstructions. Trigger states are fixtures; no webhook is created, tested, rotated or removed. On the routed page useRoutineWebhookDialog wires it to the trigger API, and test mode uses PATCH /routine-triggers/:id with setupPending true/false. The key shown is a placeholder.",
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
