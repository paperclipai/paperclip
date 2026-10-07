import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { Route, Routes } from "@/lib/router";
import { McpConnectPage, AssistantConnectionsPage } from "@/pages/McpConnect";
import { consentSubmission, installPublicMcpFixture, request } from "../fixtures/publicMcp";

const meta = {
  title: "Assistant connections/Consent",
  component: McpConnectPage,
  parameters: { layout: "padded", initialEntries: [`/mcp-connect/${request.id}`], docs: { description: { component: "Production consent page at /mcp-connect/:id. API fixtures are isolated. Successful consent stays in this preview; no OAuth credentials are issued." } } },
  beforeEach: ({ parameters }) => installPublicMcpFixture(parameters.fixture),
  render: () => <Routes><Route path="/mcp-connect/:id" element={<McpConnectPage />} /><Route path="/assistant-connections" element={<AssistantConnectionsPage />} /></Routes>,
} satisfies Meta<typeof McpConnectPage>;
export default meta;
type Story = StoryObj<typeof meta>;
const chooseOrganization: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  const c = within(canvasElement);
  await userEvent.click(await c.findByRole("radio", { name: "Acme Research" }));
};
export const ChooseOrganization: Story = { play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await expect(await c.findByRole("radio", { name: "Acme Research" })).toBeChecked();
  await expect(c.getByRole("checkbox")).toBeChecked();
  await expect(c.getByRole("button", { name: "Connect organization" })).toBeEnabled();
} };
export const Claude: Story = { parameters: { fixture: { request: { clientName: "Claude", clientOrigin: "https://claude.ai", redirectOrigin: "https://claude.ai", companies: [request.companies[0]], setupUrl: "https://my.paperclip.app/orgs/new" } } } };
export const SeparateCallbackOrigin: Story = { parameters: { fixture: { request: { clientName: "Claude Code", clientOrigin: "https://claude.ai", redirectOrigin: "http://localhost:57843", companies: [request.companies[0]] } } } };
export const UnknownAssistant: Story = { parameters: { fixture: { request: { clientName: "Assistant", clientOrigin: null, redirectOrigin: "https://assistant.example" } } } };
export const OpenCodeOrganization: Story = { parameters: { fixture: { request: { clientName: "OpenCode", redirectOrigin: "http://127.0.0.1:19876", companies: [{ ...request.companies[0], name: "Paperclip Storybook" }] } } } };
export const AllowDelegation: Story = { play: async context => {
  await chooseOrganization(context);
  const c = within(context.canvasElement);
  await expect(c.getByRole("checkbox")).toBeChecked();
  await expect(c.getByRole("button", { name: "Connect organization" })).toBeEnabled();
} };
export const SwitchingOrganizationsResetsConsent: Story = { play: async context => {
  await AllowDelegation.play!(context);
  const c = within(context.canvasElement);
  await userEvent.click(c.getByRole("checkbox"));
  await userEvent.click(c.getByRole("radio", { name: "Design Partners" }));
  await expect(c.getByRole("checkbox")).not.toBeChecked();
  await expect(c.getByRole("checkbox")).toBeDisabled();
  await expect(c.getByText("Your role in this organization is read-only.")).toBeVisible();
  await userEvent.click(c.getByRole("radio", { name: "Acme Research" }));
  await expect(c.getByRole("checkbox")).toBeEnabled();
  await expect(c.getByRole("checkbox")).not.toBeChecked();
} };
export const ReadOnlyRequest: Story = { parameters: { fixture: { request: { clientName: "Claude", redirectOrigin: "https://claude.ai", requestedWrite: false, offlineAccess: false } } } };
export const SignInRequired: Story = { parameters: { fixture: { request: { requiresSignIn: true, companies: [] } } } };
export const NoOrganizations: Story = { parameters: { fixture: { request: { companies: [] } } } };
export const NoOrganizationsWithSetupUrl: Story = { parameters: { fixture: { request: { companies: [], setupUrl: "https://my.paperclip.app/orgs/new" } } }, play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await c.findByText(/This account has no available organizations/);
  await expect(c.queryByRole("link", { name: "Create a hosted organization" })).not.toBeInTheDocument();
  await expect(c.getByRole("button", { name: "Connect organization" })).toBeDisabled();
} };
export const Loading: Story = { parameters: { fixture: { loading: true } } };
export const UnavailableOrExpired: Story = { parameters: { fixture: { unavailable: true } } };
export const Connecting: Story = { parameters: { fixture: { pending: true } }, play: async context => {
  await chooseOrganization(context);
  const c = within(context.canvasElement);
  await userEvent.click(c.getByRole("button", { name: "Connect organization" }));
  await expect(await c.findByRole("button", { name: "Connecting…" })).toBeDisabled();
} };
export const SaveFailed: Story = { parameters: { fixture: { mutationError: true } }, play: async context => {
  await chooseOrganization(context);
  const c = within(context.canvasElement);
  await userEvent.click(c.getByRole("button", { name: "Connect organization" }));
  await c.findByText("Could not save this change. Please try again.");
  await expect(c.getByRole("radio", { name: "Acme Research" })).toBeChecked();
} };
export const SubmitReadOnlyConsent: Story = { play: async context => {
  await chooseOrganization(context);
  const c = within(context.canvasElement);
  await userEvent.click(c.getByRole("checkbox"));
  await expect(c.getByRole("checkbox")).not.toBeChecked();
  await userEvent.click(c.getByRole("button", { name: "Connect organization" }));
  await expect(consentSubmission).toHaveBeenCalledWith({ decision: "approve", companyId: request.companies[0].id, allowWrites: false, allowConfiguration: false });
} };
export const Cancel: Story = { play: async ({ canvasElement }) => {
  await userEvent.click(await within(canvasElement).findByRole("button", { name: "Cancel" }));
  await expect(consentSubmission).toHaveBeenCalledWith({ decision: "deny", companyId: request.companies[0].id, allowWrites: false, allowConfiguration: false });
} };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } }, parameters: { waitForViewport: true } };

/** Cloud has already selected this organization; consent only grants its permissions. */
export const HostedOrganization: Story = { parameters: { fixture: { request: { requestedCompanyId: request.companies[0].id, companies: [request.companies[0]] } } } };
export const HostedConsentCheck: Story = { ...HostedOrganization, play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await expect(await c.findByText("Acme Research")).toBeVisible();
  await expect(c.queryByRole("radio")).not.toBeInTheDocument();
  await expect(c.queryByText("Design Partners")).not.toBeInTheDocument();
  await expect(c.getByRole("checkbox")).toBeChecked();
  await userEvent.click(c.getByRole("button", { name: "Connect organization" }));
  await expect(consentSubmission).toHaveBeenCalledWith({ decision: "approve", companyId: request.companies[0].id, allowWrites: true, allowConfiguration: false });
} };
export const HostedReadOnly: Story = { parameters: { fixture: { request: { requestedCompanyId: request.companies[1].id, companies: [request.companies[1]] } } }, play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await expect(await c.findByText("Design Partners")).toBeVisible();
  await expect(c.queryByRole("radio")).not.toBeInTheDocument();
  await expect(c.getByRole("checkbox")).toBeDisabled();
  await expect(c.getByRole("checkbox")).not.toBeChecked();
  await expect(c.getByRole("button", { name: "Connect organization" })).toBeEnabled();
} };
export const HostedOrganizationUnavailable: Story = { parameters: { fixture: { request: { requestedCompanyId: request.companies[0].id, companies: [], setupUrl: "https://my.paperclip.app/orgs/new" } } }, play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await expect(await c.findByText(/selected organization is no longer available/)).toBeVisible();
  await expect(c.getByRole("button", { name: "Connect organization" })).toBeDisabled();
  await expect(c.getByRole("button", { name: "Cancel" })).toBeEnabled();
  await expect(c.queryByRole("radio")).not.toBeInTheDocument();
  await expect(c.queryByRole("link", { name: "Create a hosted organization" })).not.toBeInTheDocument();
} };


export const ConfigurationConsent: Story = {
  parameters: { fixture: { request: { requestedConfigure: true } } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const write = await c.findByRole("checkbox", { name: "Write all of your Paperclip data" });
    await expect(c.getAllByRole("checkbox")).toHaveLength(1);
    await expect(write).toBeChecked();
    await userEvent.click(c.getByRole("button", { name: "Connect organization" }));
    await expect(consentSubmission).toHaveBeenCalledWith(expect.objectContaining({ allowConfiguration: true, allowWrites: true }));
  },
};
export const ConfigurationReadOnlyRole: Story = {
  parameters: { fixture: { request: { requestedConfigure: true, companies: [{ ...request.companies[0], canWrite: false }] } } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(await c.findByRole("checkbox", { name: "Write all of your Paperclip data" })).toBeDisabled();
  },
};

export const ConfigurationOptOut: Story = {
  parameters: { fixture: { request: { requestedConfigure: true } } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("checkbox", { name: "Write all of your Paperclip data" }));
    await expect(c.getAllByRole("checkbox")).toHaveLength(1);
    await expect(c.getByRole("checkbox")).not.toBeChecked();
    await userEvent.click(c.getByRole("button", { name: "Connect organization" }));
    await expect(consentSubmission).toHaveBeenCalledWith(expect.objectContaining({ allowConfiguration: false, allowWrites: false }));
  },
};
