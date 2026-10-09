import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiProviderSetup } from "@/components/ai-connections/AiProviderSetup";
import { AiConnectionSelect } from "@/components/ai-connections/AiConnectionSelect";
import { AiConnectionField } from "@/components/ai-connections/AiConnectionField";
import { AgentProviderConnection, type ProviderConnection } from "@/components/new-agent/AgentProviderConnection";
import { useConnectionModels } from "@/components/ai-connections/useConnectionModels";
import { ModelDropdown } from "@/components/AgentConfigForm";
import { Field } from "@/components/agent-config-primitives";
import { NativeSelect } from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";
import type {
  AiConnectionBinding,
  AiManagedConnectionSummary,
} from "@paperclipai/shared";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ProviderCatalogReview } from "../prototypes/provider-routing/ConnectionCatalog";
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
        initialProvider="openrouter"
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
function OpenRouterModelPicker() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [effort, setEffort] = useState("");
  const connection = useConnectionModels(companyId, {
    provider: "openrouter", method: "api_key", mode: "shared",
    connectionId: accounts[1].id, grantId: accounts[1].grantId,
  }, "opencode_local");
  return <div className="grid gap-5 sm:grid-cols-2">
    <ModelDropdown presentation="native" models={connection?.models ?? []} value={value} onChange={setValue}
    open={open} onOpenChange={setOpen} allowDefault={false} required groupByProvider={false}
    preserveOrder creatable loadingModels={connection?.isLoading} />
    <Field label="Thinking effort"><NativeSelect aria-label="Thinking effort" value={effort} onChange={event => setEffort(event.target.value)}>
      <option value="">Auto</option><option value="high">high</option>
    </NativeSelect></Field>
  </div>;
}
function OpenRouterModels() {
  const [client] = useState(() => {
    const query = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    query.setQueryData(["ai-connections", companyId], {
      currentUserId: "you",
      connections: [{ ...accounts[1], routing: { ...accounts[1].routing!, models: [] } }],
    });
    query.setQueryData(queryKeys.agents.adapterModels(companyId, "opencode_local", null, "openrouter"), [
      { id: "openrouter/z-ai/glm-5", label: "Z.AI GLM 5" },
      { id: "openrouter/anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
      { id: "openrouter/openai/gpt-5.4", label: "OpenAI GPT-5.4" },
    ]);
    return query;
  });
  return <QueryClientProvider client={client}><OpenRouterModelPicker /></QueryClientProvider>;
}
function AgentConnectionModes() {
  const [value, setValue] = useState<AiConnectionBinding>();
  const [connected, setConnected] = useState<ProviderConnection>();
  const [client] = useState(() => {
    const query = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const connections = { currentUserId: "you", connections: accounts, canManageConnections: true };
    query.setQueryData(["ai-connections", companyId], connections);
    query.setQueryData(["ai-connections", companyId, undefined], connections);
    query.setQueryData(queryKeys.secrets.myUserSecrets(companyId), []);
    query.setQueryData(queryKeys.secrets.list(companyId), []);
    query.setQueryData(queryKeys.agents.authSignal(companyId, "codex_local", null), { status: "present" });
    return query;
  });
  return <QueryClientProvider client={client}>
    <AgentProviderConnection companyId={companyId} adapterType="codex_local" environmentId={null}
      canLogin={false} onBack={() => {}} testConnection={async () => true} onConnected={setConnected}
      advancedConnection={{ value, content: <AiConnectionField companyId={companyId} agentName="Nova"
        adapterType="codex_local" value={value} onChange={binding => { if (binding.mode !== "router") setValue(binding); }} preferAdvanced /> }} />
    {connected && <p role="status">Continue to Configure with {connected.aiConnection?.provider}.</p>}
  </QueryClientProvider>;
}
const meta = {
  title: "AI Connections/Provider routing/06 Production components",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <ReviewFrame location="Production components: Connectors → provider row → Connect; Agents → Harness / Runtime. Fixtures supply data only.">
        <Story />
      </ReviewFrame>
    ),
  ],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const NewAgentConnectionModes: Story = {
  name: "New agent connection modes",
  parameters: { docs: { description: { story: "Agents → New agent → Connect. Three persistent production tiles switch between saved subscriptions, API keys, and advanced connections. Environment selection belongs to Configure." } } },
  render: () => <AgentConnectionModes />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("radio")).toHaveLength(3);
    await expect(canvas.getByRole("radio", { name: "OpenAI Subscription" })).toBeChecked();
    await expect(canvas.getByRole("combobox", { name: "Saved subscription" })).toBeVisible();
    await userEvent.click(canvas.getByRole("radio", { name: "OpenAI API key" }));
    await waitFor(() => expect(canvas.getByPlaceholderText("Enter API key here")).toBeVisible());
    await userEvent.click(canvas.getByRole("radio", { name: "Advanced Custom Gateway" }));
    await expect(canvas.queryByPlaceholderText("Enter API key here")).not.toBeInTheDocument();
    await expect(canvas.getAllByRole("radio")).toHaveLength(3);
    await expect(canvas.getByRole("radio", { name: "Advanced Custom Gateway" })).toBeChecked();
    await expect(canvas.getByRole("button", { name: "Use connection" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("combobox", { name: "Connection" }));
    await userEvent.click(within(canvasElement.ownerDocument.body).getByRole("option", { name: "Company OpenRouter" }));
    await userEvent.click(canvas.getByRole("button", { name: "Use connection" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Continue to Configure with openrouter.");
    await userEvent.click(canvas.getByRole("radio", { name: "OpenAI Subscription" }));
    await expect(canvas.getAllByRole("radio")).toHaveLength(3);
    await expect(canvas.getByRole("radio", { name: "OpenAI Subscription" })).toBeChecked();
    await expect(canvas.getByRole("combobox", { name: "Saved subscription" })).toBeVisible();
    await expect(canvas.queryByRole("combobox", { name: "Connection" })).not.toBeInTheDocument();
  },
};
export const OpenRouterPopularModels: Story = {
  name: "OpenRouter popular models",
  parameters: { docs: { description: { story: "Production model picker and connection discovery hook. The connection has no custom model list; the public catalog fixture supplies models in popularity order." } } },
  render: () => <OpenRouterModels />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const model = canvas.getByRole("combobox", { name: "Model" });
    const labels = within(model).getAllByRole("option").filter(option => (option as HTMLOptionElement).value.startsWith("openrouter/")).map(option => option.textContent);
    await expect(labels).toEqual(["Z.AI GLM 5", "Claude Sonnet 4.5", "OpenAI GPT-5.4"]);
    await userEvent.selectOptions(model, "openrouter/anthropic/claude-sonnet-4.5");
    await expect(model).toHaveValue("openrouter/anthropic/claude-sonnet-4.5");
    await userEvent.selectOptions(canvas.getByRole("combobox", { name: "Thinking effort" }), "high");
    await userEvent.selectOptions(model, within(model).getByRole("option", { name: "Enter custom model…" }));
    await userEvent.clear(canvas.getByRole("textbox", { name: "Model ID" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Model ID" }), "my-gateway/model-alias");
    await expect(canvas.getByRole("textbox", { name: "Model ID" })).toHaveValue("my-gateway/model-alias");
    await userEvent.selectOptions(model, "openrouter/anthropic/claude-sonnet-4.5");
    await expect(canvas.queryByRole("textbox", { name: "Model ID" })).not.toBeInTheDocument();
  },
};
export const ChooseProvider: Story = {
  name: "Connector catalog",
  render: () => <ProviderCatalogReview />,
  play: async ({ canvasElement }) => {
    const row = canvasElement.querySelector('[data-app-slug="responses-api"]')! as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Connect Responses API" }));
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Connect Responses API" })).toBeVisible();
    await expect(canvas.getByText("Connects for everyone in your organization, available to all agents.")).toBeVisible();
    await expect(canvas.queryByRole("radio")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Change" }));
    await expect(canvas.getByRole("radio", { name: "Any human in the organization" })).toBeChecked();
    await expect(canvas.getByRole("radio", { name: "Any agent" })).toBeChecked();
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
    await userEvent.click(canvas.getByRole("button", { name: "Change" }));
    await expect(canvas.getByText("Which agents can use this connection?", { exact: true })).toBeVisible();
    await expect(canvas.getByRole("radio", { name: "Any human in the organization" })).toBeDisabled();
  },
};
