import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiProviderSetup } from "@/components/ai-connections/AiProviderSetup";
import { AiConnectionSelect } from "@/components/ai-connections/AiConnectionSelect";
import type {
  AiConnectionBinding,
  AiManagedConnectionSummary,
} from "@paperclipai/shared";
import { expect, userEvent, within } from "storybook/test";
import { ReviewFrame } from "../prototypes/provider-routing/shared";

const companyId = "00000000-0000-4000-8000-000000000001";
const accounts: AiManagedConnectionSummary[] = [
  {
    id: "00000000-0000-4000-8000-000000000002",
    grantId: "00000000-0000-4000-8000-000000000003",
    companyId,
    provider: "openai",
    method: "subscription",
    name: "My ChatGPT subscription",
    ownership: "personal",
    ownerUserId: "you",
    isDefault: true,
    status: "connected",
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    grantId: "00000000-0000-4000-8000-000000000005",
    companyId,
    provider: "openrouter",
    method: "api_key",
    name: "Company OpenRouter",
    ownership: "shared",
    isDefault: false,
    status: "connected",
    routing: {
      kind: "openrouter",
      protocol: "responses",
      auth: "bearer",
      models: [{ id: "openai/gpt-5.4" }],
    },
  },
  {
    id: "00000000-0000-4000-8000-000000000006",
    grantId: "00000000-0000-4000-8000-000000000007",
    companyId,
    provider: "anthropic",
    method: "subscription",
    name: "My Claude subscription",
    ownership: "personal",
    ownerUserId: "you",
    isDefault: true,
    status: "connected",
  },
];
function Providers({ canManageConnections = true }: { canManageConnections?: boolean }) {
  const [client] = useState(() => {
    const query = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    query.setQueryData(
      ["agents", companyId, "provider-access"],
      [{ id: "nova", name: "Nova" }],
    );
    query.setQueryData(["ai-connections", companyId, "nova"], { currentUserId: "you", connections: accounts, canManageConnections });
    return query;
  });
  return (
    <QueryClientProvider client={client}>
      <AiProviderSetup
        companyId={companyId}
        agentId="nova"
        onCancel={() => {}}
        onComplete={() => {}}
      />
    </QueryClientProvider>
  );
}
function Connection() {
  const [value, setValue] = useState<AiConnectionBinding>({
    provider: "openai",
    method: "subscription",
    mode: "responsible_user",
  });
  return (
    <AiConnectionSelect
      requirement={{ companyId, provider: "openai" }}
      adapterType="codex_local"
      connections={accounts}
      value={value}
      onChange={setValue}
      onConnect={() => {}}
      currentUserId="you"
      agentId="nova"
      agentName="Nova"
    />
  );
}
const meta = {
  title: "AI Connections/Provider routing/06 Production components",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <ReviewFrame location="Production components: Connectors → Connect a model provider; Agents → Harness / Runtime. Fixtures supply data only.">
        <Story />
      </ReviewFrame>
    ),
  ],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const ChooseProvider: Story = {
  render: () => <Providers />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "OpenAI" })).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "OpenRouter", hidden: true }),
    ).not.toBeVisible();
    await userEvent.click(
      canvas.getByText("Advanced providers", { exact: true }),
    );
    await expect(
      canvas.getByRole("button", { name: "OpenRouter" }),
    ).toBeVisible();
  },
};
export const CompatibleConnectionDropdown: Story = {
  render: () => <Connection />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("combobox", { name: "Connection" }),
    ).toHaveTextContent("Responsible user’s default");
    await userEvent.click(
      within(canvasElement).getByRole("combobox", { name: "Connection" }),
    );
    const body = within(canvasElement.ownerDocument.body);
    await expect(
      body.getByRole("option", { name: "Responsible user’s default" }),
    ).toHaveAttribute("data-state", "checked");
    await expect(
      body.getByRole("option", { name: "Company OpenRouter" }),
    ).toBeVisible();
    await expect(
      body.queryByRole("option", { name: "My Claude subscription" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      body.getByRole("option", { name: "Company OpenRouter" }),
    );
    await expect(
      within(canvasElement).getByRole("combobox", { name: "Connection" }),
    ).toHaveTextContent("Company OpenRouter");
  },
};

export const MemberProviderAccess: Story = {
  render: () => <Providers canManageConnections={false} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "OpenAI" }));
    await expect(canvas.getByText("Which agents can use this connection?", { exact: true })).toBeVisible();
    await expect(canvas.getByRole("button", { name: /^Continue$/ })).toBeEnabled();
  },
};
