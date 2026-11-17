import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { GoogleWorkspaceServicesDialog } from "@/features/connections/GoogleWorkspaceServices";
import { ServiceConsent } from "../../prototypes/google-workspace/ServiceConsent";

const meta = {
  id: "apps-connections-google-workspace-service-consent-preview",
  title: "Apps, channels, and extensions/Connection setup/Google Workspace service consent",
  component: ServiceConsent,
  parameters: { layout: "fullscreen", paperclip: {
    capabilities: ["connection-setup/catalog", "app-permissions/account-maintenance"],
    status: "current", implementation: "mixed", boundary: "fixtures",
    notes: "Production service fields and picker with simulated journey callbacks. No provider authorization, persistence, or Google verification is established by these stories.",
  }, docs: { description: { component: "The production service picker and fixture-backed journey previews. Google authorization is simulated without provider calls. Paperclip audiences and action policies remain separate." } } },
} satisfies Meta<typeof ServiceConsent>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ProductionPicker: Story = {
  render: () => <GoogleWorkspaceServicesDialog onContinue={fn()} onCancel={fn()} />,
  parameters: { docs: { description: { story: "The production picker used by both Apps and task-hosted OAuth setup. Callbacks are mocked in Storybook; no OAuth grant is created." } } },
};
export const ChooseServices: Story = { args: {} };
export const FromApps: Story = { args: { start: "catalog" } };
export const GmailOnlyReviewer: Story = { args: { initial: { gmail: "read" }, start: "review" } };
export const SelectedServices: Story = { args: { initial: { gmail: "read", drive: "read", calendar: "write" } } };
export const DraftsPermissionDisclosure: Story = { args: { initial: { gmail: "write" }, start: "review" } };
export const ExistingAccount: Story = { args: { initial: { gmail: "read" }, existing: true } };
export const SignInRecovery: Story = { args: { initial: { gmail: "read" }, start: "review", error: true } };
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };
export const Light: Story = { globals: { theme: "light" } };
export const AllServicesCheckedByDefault: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const toggles = body.getAllByRole("switch");
    await expect(toggles).toHaveLength(3);
    for (const toggle of toggles) await expect(toggle).toBeChecked();
    for (const dropdown of body.getAllByRole("combobox")) await expect(dropdown).toHaveValue("write");
    await expect(body.queryByText(/Google’s compose permission/)).not.toBeInTheDocument();
    await expect(body.queryByRole("switch", { name: /^Chat$/ })).not.toBeInTheDocument();
    await expect(body.queryByRole("switch", { name: /Contacts|directory/ })).not.toBeInTheDocument();
    await userEvent.click(body.getByRole("button", { name: /^Continue$/ }));
    await userEvent.click(body.getByText(/^Exact Google permissions/));
    await expect(body.queryByText(/googleapis.com\/auth\/chat\./)).not.toBeInTheDocument();
  },
};
export const SelectionChangesPermissions: Story = {
  args: { initial: {} },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByRole("button", { name: /^Continue$/ })).toBeDisabled();
    await userEvent.click(body.getByRole("switch", { name: /^Gmail$/ }));
    await userEvent.selectOptions(body.getByRole("combobox", { name: "Gmail access" }), "read");
    await userEvent.click(body.getByRole("button", { name: /^Continue$/ }));
    await userEvent.click(body.getByText("Exact Google permissions (1)"));
    await expect(body.getByText("https://www.googleapis.com/auth/gmail.readonly", { exact: true })).toBeVisible();
    await expect(body.queryByText("https://www.googleapis.com/auth/drive.readonly", { exact: true })).not.toBeInTheDocument();
    await userEvent.click(body.getByRole("button", { name: /^Back$/ }));
    await userEvent.selectOptions(body.getByRole("combobox", { name: "Gmail access" }), "write");
    await userEvent.click(body.getByRole("button", { name: /^Continue$/ }));
    await userEvent.click(body.getByText("Exact Google permissions (2)"));
    await expect(body.getByText("https://www.googleapis.com/auth/gmail.compose", { exact: true })).toBeVisible();
    await userEvent.click(body.getByRole("button", { name: "Continue with Google" }));
    await expect(body.getByRole("status")).toHaveTextContent("No account was connected.");
  },
};
