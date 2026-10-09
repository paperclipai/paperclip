import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { DotRunnerConnection } from "@/components/DotRunnerConnection";

/** All connection mutations and pairing codes are synthetic and local. */
function installFixture(connected: boolean) {
  const original = window.fetch;
  let binding = connected ? connection("connected") : null;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (!url.pathname.startsWith("/api/companies/dot-preview/agents/dot-preview/dot-binding")) return original(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "DELETE") { binding = null; return new Response(null, { status: 204 }); }
    if (method === "POST") {
      if (url.pathname.endsWith("/event-test")) { if (binding) binding = { ...binding, hasPendingChallenge: true }; return Response.json({}); }
      binding = connection("pairing");
      return Response.json({ bindingId: binding.id, pairingCode: "dot_pair_SYNTHETIC_PREVIEW_CODE", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }
    return Response.json({ enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", binding });
  };
  return () => { window.fetch = original; };
}
function connection(status: "pairing" | "connected") {
  return { id: "synthetic-dot-binding", status, connected: status === "connected",
    subscriptionVerified: status === "connected", hasPendingChallenge: false };
}
function ConnectionForm() {
  const [bindingId, onBinding] = useState("");
  return <div className="max-w-2xl space-y-4 p-6">
    <h2 className="text-lg font-semibold">OpenAI Dot</h2>
    <DotRunnerConnection companyId="dot-preview" agentId="dot-preview" bindingId={bindingId} onBinding={onBinding} />
  </div>;
}
const meta = {
  title: "Assistant connections/Dot Runner", component: ConnectionForm,
  parameters: { layout: "padded", docs: { description: { component: "Production Dot pairing component. API responses, pairing code and account state are synthetic. This preview does not qualify a real Dot account." } } },
  beforeEach: ({ parameters }) => installFixture(Boolean(parameters.connected)),
} satisfies Meta<typeof ConnectionForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unpaired: Story = {};
export const Pairing: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Pair Dot" }));
  await canvas.findByText("dot_pair_SYNTHETIC_PREVIEW_CODE");
} };
export const Connected: Story = { parameters: { connected: true } };
export const Revoked: Story = { parameters: { connected: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Revoke connection" }));
  await expect(await canvas.findByRole("button", { name: "Pair Dot" })).toBeEnabled();
} };
