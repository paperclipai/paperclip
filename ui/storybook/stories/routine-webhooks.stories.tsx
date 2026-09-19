import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { WebhookReview } from "../fixtures/routineWebhooks";

const meta = {
  title: "Product/Routines/Webhooks",
  component: WebhookReview,
  parameters: { layout: "fullscreen" },
  args: { signingMode: "bearer", state: "configured" },
} satisfies Meta<typeof WebhookReview>;
export default meta;
type Story = StoryObj<typeof meta>;

const openWebhookForm: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Add trigger" }));
  await userEvent.click(canvas.getByText("When another app sends a webhook", { exact: true }));
  await expect(canvas.getByRole("button", { name: "Continue" })).toBeEnabled();
};
const openSavedWebhook: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  await userEvent.click(await within(canvasElement).findByRole("button", { name: "Edit webhook" }));
};

export const RoutineList: Story = { name: "00 · Routines page", args: { state: "list" } };
export const Setup: Story = { name: "01 · Add a webhook", args: { state: "setup" }, play: openWebhookForm };
export const Credentials: Story = {
  name: "02 · Save the new secret", args: { state: "credentials" },
  play: async (context) => {
    await openWebhookForm(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(await canvas.findByRole("button", { name: "Copy Authorization header value" })).toBeVisible();
  },
};
export const Bearer: Story = { name: "03 · Bearer · After delivery", play: openSavedWebhook };
export const TimestampedHmac: Story = { name: "04 · Timestamped HMAC", args: { signingMode: "hmac_sha256" }, play: openSavedWebhook };
export const GitHub: Story = { name: "05 · GitHub HMAC", args: { signingMode: "github_hmac" }, play: openSavedWebhook };
export const Unsigned: Story = { name: "06 · Unsigned", args: { signingMode: "none" }, play: openSavedWebhook };
export const FailedDelivery: Story = { name: "07 · Failed delivery", args: { state: "failure" }, play: openSavedWebhook };
export const Overview: Story = { name: "08 · Webhook routine overview", args: { state: "overview" } };

export const Runs: Story = {
  name: "09 · Runs · Issue list", args: { state: "runs" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Verify production deployment v2.8.4")).toBeVisible();
    await expect(canvas.getByRole("navigation", { name: "Routine navigation" })).toBeVisible();
  },
};
export const Activity: Story = {
  name: "10 · Activity · Routine timeline", args: { state: "activity" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Routine started")).toBeVisible();
    await expect(canvas.getByRole("navigation", { name: "Routine navigation" })).toBeVisible();
  },
};

const warningSetup: NonNullable<Story["play"]> = async (context) => {
  await Credentials.play!(context);
  const canvas = within(context.canvasElement);
  await expect(canvas.getByRole("link", { name: "Learn how to set up HTTPS and public access" })).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Check connection" })).toBeEnabled();
};
const deliveryPath = "/api/routine-triggers/public/0123456789abcdef01234567/fire";
export const LocalhostWarning: Story = { name: "11 · Localhost warning", args: { state: "credentials", webhookUrl: `http://localhost:3100${deliveryPath}` }, play: warningSetup };
export const TailscaleWarning: Story = { name: "12 · Tailscale public access warning", args: { state: "credentials", webhookUrl: `https://paperclip.example-tailnet.ts.net${deliveryPath}` }, play: warningSetup };
export const PrivateNetworkWarning: Story = { name: "13 · Internal domain warning", args: { state: "credentials", webhookUrl: `https://paperclip.internal${deliveryPath}` }, play: warningSetup };
export const HttpWarning: Story = { name: "14 · HTTP warning", args: { state: "credentials", webhookUrl: `http://paperclip.example.com${deliveryPath}` }, play: warningSetup };
export const ExistingWebhookWarning: Story = { name: "15 · Existing private webhook warning", args: { webhookUrl: `https://192.168.1.10${deliveryPath}` }, play: openSavedWebhook };
