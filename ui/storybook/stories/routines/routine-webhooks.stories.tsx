import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { WebhookReview } from "../../fixtures/routineWebhooks";

const meta = {
  id: "product-routines-webhooks",
  title: "Automation and structured work/Routines, schedules, and triggers/Product/Routines/Webhooks",
  component: WebhookReview,
  parameters: { layout: "fullscreen",
    paperclip: {
      "capabilities": [
        "routines/triggers",
        "routines/history",
        "activity/routine-audit"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "status": "current",
      "notes": "Mounts the app shell with the shipped Routines and RoutineDetail routes on an in-memory routines API. Webhooks open from the Repeats list on the routine page and are added from the Edit dialog; the History list and the /activity audit log use fixture tasks and events. Scheduler execution, delivery and audit persistence are not live."
    },
  },
  args: { signingMode: "bearer", state: "configured" },
} satisfies Meta<typeof WebhookReview>;
export default meta;
type Story = StoryObj<typeof meta>;

const openWebhookForm: NonNullable<Story["play"]> = async () => {
  const body = within(document.body);
  await userEvent.click(await body.findByRole("button", { name: "Edit routine" }));
  await userEvent.click(await body.findByRole("button", { name: "Add webhook" }));
  await expect(await body.findByRole("radiogroup", { name: "What’s sending the webhook?" })).toBeVisible();
  await expect(body.getByRole("button", { name: "Create webhook" })).toBeEnabled();
};
const openSavedWebhook: NonNullable<Story["play"]> = async () => {
  await userEvent.click(await within(document.body).findByRole("button", { name: /^Open (GitHub webhook|Webhook) · Deployment completed$/ }));
};

export const RoutineList: Story = { name: "00 · Routines page", args: { state: "list" } };
export const Setup: Story = { name: "01 · Add a webhook", args: { state: "setup" }, play: openWebhookForm };
export const Credentials: Story = {
  name: "02 · Save the new secret", args: { state: "credentials" },
  play: async (context) => {
    await openWebhookForm(context);
    const body = within(document.body);
    await userEvent.click(body.getByRole("button", { name: "Create webhook" }));
    await expect(await body.findByRole("button", { name: "Copy Secret key" })).toBeVisible();
    await expect(body.getByText("Waiting for a test event")).toBeVisible();
  },
};
export const Bearer: Story = { name: "03 · Bearer · After delivery", play: openSavedWebhook };
export const TimestampedHmac: Story = { name: "04 · Timestamped HMAC", args: { signingMode: "hmac_sha256" }, play: openSavedWebhook };
export const GitHub: Story = { name: "05 · GitHub HMAC", args: { signingMode: "github_hmac" }, play: openSavedWebhook };
export const Unsigned: Story = { name: "06 · Unsigned", args: { signingMode: "none" }, play: openSavedWebhook };
export const FailedDelivery: Story = { name: "07 · Failed delivery", args: { state: "failure" }, play: openSavedWebhook };
export const Overview: Story = { name: "08 · Webhook routine overview", args: { state: "overview" } };

export const Runs: Story = {
  name: "09 · History · Tasks on the routine page", args: { state: "runs" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Verify production deployment v2.8.4")).toBeVisible();
    await expect(canvas.queryByRole("navigation", { name: "Routine navigation" })).not.toBeInTheDocument();
  },
};
export const Activity: Story = {
  name: "10 · Audit log · Routine timeline", args: { state: "activity" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("heading", { name: "Audit log" })).toBeVisible();
    await expect(await canvas.findByText("Routine started")).toBeVisible();
  },
};

const warningSetup: NonNullable<Story["play"]> = async (context) => {
  await Credentials.play!(context);
  await expect(within(document.body).getByRole("link", { name: "Learn how to set up HTTPS and public access" })).toBeVisible();
};
const deliveryPath = "/api/routine-triggers/public/0123456789abcdef01234567/fire";
export const LocalhostWarning: Story = { name: "11 · Localhost warning", args: { state: "credentials", webhookUrl: `http://localhost:3100${deliveryPath}` }, play: warningSetup };
export const TailscaleWarning: Story = { name: "12 · Tailscale public access warning", args: { state: "credentials", webhookUrl: `https://paperclip.example-tailnet.ts.net${deliveryPath}` }, play: warningSetup };
export const PrivateNetworkWarning: Story = { name: "13 · Internal domain warning", args: { state: "credentials", webhookUrl: `https://paperclip.internal${deliveryPath}` }, play: warningSetup };
export const HttpWarning: Story = { name: "14 · HTTP warning", args: { state: "credentials", webhookUrl: `http://paperclip.example.com${deliveryPath}` }, play: warningSetup };
export const ExistingWebhookWarning: Story = { name: "15 · Existing private webhook warning", args: { webhookUrl: `https://192.168.1.10${deliveryPath}` }, play: openSavedWebhook };
