import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { CreateGrokInvitation, GrokConnection } from "@paperclipai/shared";
import { GrokBotSetupContent, type GrokSetupStep } from "@/components/new-agent/GrokBotSetupContent";
import { AnimatedDialogContent } from "@/components/AnimatedDialogContent";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { GrokWorkJourney } from "./work-journey";

const bindingId = "11111111-1111-4111-8111-111111111111";
const connection: GrokConnection = { enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "idle",
  agentLifecycleState: "ready", canConfigureConnection: true, recoveryNeeded: false,
  binding: { id: bindingId, providerKind: "grok_bot", status: "connected", connected: true, subscriptionVerified: false,
    hasPendingChallenge: false, pairingExpiresAt: null, challengeExpiresAt: null, wakeVerified: false, routine: null } };
function SetupPreview({ initialStep = 0, outboundOnly = false, rejected = false, recovering = false, saved = false, awaitingAuthorization = false }: {
  initialStep?: GrokSetupStep; outboundOnly?: boolean; rejected?: boolean; recovering?: boolean; saved?: boolean; awaitingAuthorization?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState(initialStep);
  const [details, setDetails] = useState<CreateGrokInvitation>({ name: "Night Shift", botName: "Night Shift", role: "researcher", reportsTo: null });
  const [credentials, setCredentials] = useState({ url: "", key: "" });
  const [created, setCreated] = useState(saved);
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [verified, setVerified] = useState(false);
  const [sent, setSent] = useState(outboundOnly || rejected || recovering);
  const routine = saved && rejected || step === 3 ? { bindingId, botName: "Night Shift", revision: 1, configured: true, verified,
    verifiedAt: verified ? new Date().toISOString() : null, lastContactAt: verified ? new Date().toISOString() : null,
    recoveryNeeded: recovering, lastExchange: sent || verified ? { id: "synthetic-exchange", kind: "verify" as const,
      status: verified ? "acknowledged" as const : recovering ? "unknown" as const : rejected ? "rejected" as const : "accepted" as const,
      httpStatus: rejected ? 401 : recovering ? null : 200, sentAt: new Date().toISOString(), acknowledgedAt: verified ? new Date().toISOString() : null,
      expiresAt: new Date(Date.now() + 600000).toISOString() } : null } : null;
  const state: GrokConnection = { ...connection, agentLifecycleState: awaitingAuthorization ? "verifying" : connection.agentLifecycleState, recoveryNeeded: recovering, binding: { ...connection.binding!, connected: !awaitingAuthorization, status: awaitingAuthorization ? "pairing" : verified ? "ready" : "connected", routine, wakeVerified: verified } };
  return open ? <Dialog open onOpenChange={setOpen}><AnimatedDialogContent className="sm:max-w-(--sz-560px)">
    <GrokBotSetupContent step={step} companyName="Acme" details={details} managers={[]} created={created}
      connection={state} pairing={{ bindingId, pairingCode: "synthetic-code-never-a-credential", expiresAt: new Date(Date.now() + 900000).toISOString() }}
      webhookUrl={credentials.url} webhookKey={credentials.key} editingCredentials={editingCredentials} onEditCredentials={() => setEditingCredentials(true)} onCredentials={(url, key) => setCredentials({ url, key })} onDetails={setDetails}
      onBack={() => setStep(Math.max(0, step - 1) as GrokSetupStep)} onExit={() => setOpen(false)}
      onRetry={() => { setSent(false); setVerified(false); }} onNext={() => {
        if (step < 3) { setCreated(true); setStep((step + 1) as GrokSetupStep); }
        else if (verified) setOpen(false); else { setSent(true); if (!outboundOnly && !rejected && !recovering) setVerified(true); }
      }} />
  </AnimatedDialogContent></Dialog> : <p className="p-6">Setup saved. Reopen Grok Bot setup to continue with the same agent.</p>;
}
const meta = {
  id: "onboarding-grok-bot-journeys",
  title: "Agents and reusable capabilities/Hiring, configuration, and organization/Onboarding/Grok Bot/Journeys",
  component: SetupPreview, parameters: { layout: "fullscreen", paperclip: { capabilities: ["agents/grok-bot"], status: "proposed", implementation: "mixed", boundary: "fixtures", notes: "Production setup presentation with simulated connection evidence; the work journey mounts the production task thread, question form and document card with local synthetic responses. No live authorization, provider task or managed Runner proof." }, docs: { description: { component: "Production setup presentation with simulated server evidence. These stories create no OAuth connection, routine, task or managed job. A real authenticated challenge receipt is required in the app. The work journey uses the production task thread, input-card and document UI; provider callbacks, task persistence and recovery are simulated." } } },
} satisfies Meta<typeof SetupPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FreshSetup: Story = {};
export const SavedSetup: Story = { args: { initialStep: 1, saved: true } };
export const WaitingForAuthorization: Story = { args: { initialStep: 1, saved: true, awaitingAuthorization: true }, play: async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  await expect(page.getByLabelText("One-use pairing code")).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "Copy pairing code" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Continue$/ })).toBeDisabled();
  await expect(page.getByText("Watching for authorization. This connection works as the named agent.")).toBeVisible();
} };
export const ConfigureRoutine: Story = { args: { initialStep: 2, saved: true } };
export const OutboundOnly: Story = { args: { initialStep: 3, outboundOnly: true, saved: true }, play: async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  await expect(page.getByText("The routine accepted delivery. Waiting for an authenticated reply to Paperclip.")).toBeVisible();
  await expect(page.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
} };
export const IncorrectCredentials: Story = { args: { initialStep: 3, rejected: true, saved: true }, play: async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  await expect(page.getByText("The routine rejected delivery. Check its URL and key, then try again.")).toBeVisible();
  const back = page.getByRole("button", { name: /^Back$/ });
  await waitFor(() => expect(back.ownerDocument.defaultView!.getComputedStyle(back).pointerEvents).not.toBe("none"));
  await userEvent.click(back);
  await userEvent.click(page.getByRole("button", { name: "Replace routine credentials" }));
  await expect(page.getByLabelText("Webhook URL")).toBeVisible();
  await expect(page.getByLabelText("Webhook key")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Continue$/ })).toBeDisabled();
} };
export const BrokenConnection: Story = { args: { initialStep: 3, recovering: true, saved: true } };
export const VerifyAndFinish: Story = { args: { initialStep: 3, saved: true }, play: async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  const verify = page.getByRole("button", { name: "Verify connection" });
  await waitFor(() => expect(verify.ownerDocument.defaultView!.getComputedStyle(verify).pointerEvents).not.toBe("none"));
  await userEvent.click(verify);
  await expect(page.getByRole("heading", { name: "Your Grok Bot is connected" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Done" }));
  await expect(page.queryByRole("dialog")).not.toBeInTheDocument();
} };
export const GuidedWorkJourney: Story = { render: () => <GrokWorkJourney />, play: async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(page.getByRole("button", { name: /^Next$/ }));
  await userEvent.click(await page.findByRole("radio", { name: /Small teams/ }));
  await userEvent.click(page.getByRole("button", { name: "Submit answers" }));
  await expect(page.getByText("Answer received · Continuation delivered")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Next$/ }));
  await expect(page.getByText("Reported completion · Awaiting normal review")).toBeVisible();
  await expect(page.getByText("Competitor comparison", { exact: true })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Next$/ }));
  await userEvent.click(page.getByRole("button", { name: "Simulate Bot-initiated work" }));
  await expect(page.getByRole("button", { name: "One task admitted" })).toBeDisabled();
  await userEvent.click(page.getByRole("button", { name: /^Next$/ }));
  await userEvent.click(page.getByRole("button", { name: "Stop Paperclip work" }));
  await expect(page.getByText("Paperclip work-session authority revoked. Remote Grok execution remains unknown.")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Next$/ }));
  await userEvent.click(page.getByRole("button", { name: "Simulate inspection and fresh verification" }));
  await expect(page.getByText("Fresh exchange verified. Ready for the next task.")).toBeVisible();
} };
