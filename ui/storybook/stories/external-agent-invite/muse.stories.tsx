import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor, fn } from "storybook/test";
import { ExternalAgentInvitePreview } from "./ExternalAgentInvitePreview";
import { MuseConnectionDetails } from "@/components/MuseRunnerConnection";
import { museConnection, stoppedMuseConnection } from "./muse-fixtures";

const meta = {
  title: "Onboarding/External agent invitation/Muse personal agent",
  component: ExternalAgentInvitePreview,
  parameters: { layout: "fullscreen", initialEntries: ["/PAP/agents"],
    docs: { description: { component: "Uses the production agent entry point, ExternalAgentInviteContent, and app shell. Local simulation shows pairing, persisted receiver contact, independent background reply, and lifecycle readiness separately. No Muse installation or credentials are used. Connection settings use the production MuseConnectionDetails. The connected worker’s private tools and cost remain unavailable." } } },
  args: { initialPreset: "muse", museEnabled: true },
  render: args => <ExternalAgentInvitePreview key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof ExternalAgentInvitePreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const StartHere: Story = { name: "01 · Invite a personal Muse", args: { initialScreen: "picker" } };
export const NameAndRole: Story = { name: "02 · Name and role", args: { initialScreen: "setup", museDetails: true, simulate: false } };
export const CopySetup: Story = { name: "03 · Copy setup and approve hostname", args: { initialScreen: "setup", simulate: false } };
export const Paired: Story = { name: "04 · Paired, receiver not yet detected", args: { initialScreen: "setup", simulate: false, initialMuseConnection: { paired: true, receiverDetected: false, backgroundReplyVerified: false, ready: false } } };
export const ReceiverDetected: Story = { name: "05 · Receiver detected, waiting for background reply", args: { initialScreen: "setup", simulate: false, initialMuseConnection: { paired: true, receiverDetected: true, backgroundReplyVerified: false, ready: false } } };
export const FinishingSetup: Story = { name: "06 · All checks passed, lifecycle preparing", args: { initialScreen: "setup", simulate: false, initialMuseConnection: { paired: true, receiverDetected: true, backgroundReplyVerified: true, ready: false, finishing: true } } };
export const Ready: Story = { name: "07 · Ready for assignments", args: { initialScreen: "setup", simulate: false, initialMuseConnection: { paired: true, receiverDetected: true, backgroundReplyVerified: true, ready: true } } };
export const Approval: Story = { name: "Approval required", args: { initialScreen: "setup", pendingApproval: true, simulate: false } };
export const LoadingInvitation: Story = { name: "Recovery · Loading invitation", args: { initialScreen: "setup", invitationUnavailable: true, preparing: true, simulate: false } };
export const AuthenticatedInstanceRequired: Story = { name: "Recovery · Authenticated instance required", args: { initialScreen: "setup", invitationUnavailable: true, error: "Use an authenticated Paperclip instance with a public HTTPS URL and a company operator account. Local trusted access alone cannot connect Muse.", simulate: false } };
export const MissingPublicHost: Story = { name: "Recovery · Configure public HTTPS address", args: { initialScreen: "setup", invitationUnavailable: true, error: "This instance has no public HTTPS URL for Muse. Ask your instance administrator to configure a stable public HTTPS address, then refresh setup. Muse cannot connect through a local-only address.", simulate: false } };
export const NoRecentResponse: Story = { name: "Recovery · No recent response", args: { initialScreen: "setup", simulate: false, initialMuseConnection: { paired: true, receiverDetected: true, backgroundReplyVerified: false, ready: false, problem: "no_recent_response" } } };
export const ReplacedPrompt: Story = { name: "Recovery · Replaced or expired setup", args: { initialScreen: "setup", simulate: false, initialMuseConnection: { paired: false, receiverDetected: false, backgroundReplyVerified: false, ready: false, problem: "prompt_unavailable" } } };
export const Mobile: Story = { name: "Mobile · Copy setup", args: { initialScreen: "setup", simulate: false }, globals: { viewport: { value: "mobile1", isRotated: false } } };
export const MobileDetails: Story = { name: "Mobile · Name and role", args: { initialScreen: "setup", museDetails: true, simulate: false }, globals: { viewport: { value: "mobile1", isRotated: false } } };
export const Light: Story = { name: "Light · Name and role", args: { initialScreen: "setup", museDetails: true, simulate: false }, globals: { theme: "light" } };
export const CopyAndVerify: Story = { name: "Test · Copy, three milestones, then ready", args: { initialScreen: "setup", stepDelayMs: 300 },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Copy setup prompt" }));
    await expect(await page.findByText("Copied to clipboard")).toBeVisible();
    await waitFor(() => expect(page.getByText("Receiver detected", { exact: false })).toHaveTextContent("complete"));
    await expect(page.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    await waitFor(() => expect(page.getByRole("heading", { name: "Muse is connected" })).toBeVisible());
    await userEvent.click(page.getByRole("button", { name: "Done" }));
  },
};
export const Settings: Story = { name: "Settings · Persisted evidence and controls", render: () => <div className="max-w-2xl p-6"><MuseConnectionDetails connection={museConnection} onTest={fn()} onRepair={fn()} onPause={fn()} onDisconnect={fn()} onRefresh={fn()} onAttest={fn()} /></div> };
export const StopBoundary: Story = { name: "Settings · Disabled, cleanup, uncertain work, exact stop boundary", render: () => <div className="max-w-2xl p-6"><MuseConnectionDetails connection={stoppedMuseConnection} onTest={fn()} onRepair={fn()} onPause={fn()} onDisconnect={fn()} onRefresh={fn()} onAttest={fn()} /></div> };
