import { useEffect, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, KeyRound } from "lucide-react";
import type {
  CompanySecret,
  EnvBinding,
  UserSecretCoverageSummary,
  UserSecretDefinition,
} from "@paperclipai/shared";
import { Secrets } from "@/pages/Secrets";
import { SecretBindingPicker, type SecretBindingValue } from "@/components/SecretBindingPicker";
import { EnvironmentVariablesEditor } from "@/components/environment-variables-editor";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAgents, storybookCompanies, storybookSecrets } from "../../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";

const storybookUserSecretDefinitions: UserSecretDefinition[] = [
  {
    id: "def-storybook-github",
    companyId: COMPANY_ID,
    key: "PERSONAL_GH_TOKEN",
    name: "Personal GitHub token",
    description: "Used when the responsible user's own repos must be reached.",
    status: "active",
    provider: "local_encrypted",
    managedMode: "paperclip_managed",
    providerConfigId: null,
    providerMetadata: null,
    usageGuidance: "Create a fine-grained PAT with repo read access.",
    createdByAgentId: null,
    createdByUserId: "user-board",
    updatedByAgentId: null,
    updatedByUserId: "user-board",
    deletedAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
  },
  {
    id: "def-storybook-openai",
    companyId: COMPANY_ID,
    key: "USER_OPENAI_API_KEY",
    name: "User OpenAI API key",
    description: "Each member bills agent experiments to their own account.",
    status: "active",
    provider: "local_encrypted",
    managedMode: "paperclip_managed",
    providerConfigId: null,
    providerMetadata: null,
    usageGuidance: "Create a project-scoped OpenAI key.",
    createdByAgentId: null,
    createdByUserId: "user-board",
    updatedByAgentId: null,
    updatedByUserId: "user-board",
    deletedAt: null,
    createdAt: new Date("2026-06-03T00:00:00.000Z"),
    updatedAt: new Date("2026-06-04T00:00:00.000Z"),
  },
];

const storybookUserSecretCoverage: Record<string, UserSecretCoverageSummary> = {
  "def-storybook-github": {
    definitionId: "def-storybook-github",
    configuredCount: 5,
    missingCount: 2,
    inactiveCount: 0,
  },
  "def-storybook-openai": {
    definitionId: "def-storybook-openai",
    configuredCount: 7,
    missingCount: 0,
    inactiveCount: 0,
  },
};

const baseSecret = storybookSecrets[0]!;

// Secrets Paperclip saved on someone's behalf, plus team secrets inside a folder.
const storybookSecretInventory: CompanySecret[] = [
  ...storybookSecrets,
  { ...baseSecret, id: "secret-staging-db", key: "staging-database-url", name: "staging/DATABASE_URL", description: null, referenceCount: 0 },
  { ...baseSecret, id: "secret-staging-stripe", key: "staging-stripe-key", name: "staging/STRIPE_TEST_KEY", description: null, referenceCount: 2 },
  { ...baseSecret, id: "secret-neon-access", key: "tool_app.500df1ea-4b23-4c24-93a4-c9802c893448.oauth_access_token", name: "Neon for the organization OAuth access token 80255b18", description: null, referenceCount: 1 },
  { ...baseSecret, id: "secret-neon-refresh", key: "tool_app.afbdf0fb-70df-490b-9364-e919dedcbafa.oauth_refresh_token", name: "Neon for the organization OAuth refresh token cfdb9070", description: null, referenceCount: 1 },
  { ...baseSecret, id: "secret-slack-bot", key: "chat_slack_5c860bfd_bottoken_565d9081", name: "chat.slack.5c860bfd.botToken.565d9081", description: null, referenceCount: 1 },
  { ...baseSecret, id: "secret-slack-signing", key: "chat_slack_5c860bfd_signingsecret_2ab031a0", name: "chat.slack.5c860bfd.signingSecret.2ab031a0", description: null, referenceCount: 1 },
  { ...baseSecret, id: "secret-model-key", key: "ai-01d0de1a-ac24-461a-b229-989d2937a4e1", name: "ai-01d0de1a-ac24-461a-b229-989d2937a4e1", description: null, referenceCount: 1 },
  { ...baseSecret, id: "secret-routine", key: "routine-604ffeed-2bba-4ade-b87d-3db79f481370-99f65874bf29", name: "routine-604ffeed-2bba-4ade-b87d-3db79f481370-99f65874bf29", description: null, referenceCount: 1 },
];

// Two agents hold the first secret, so the list and details show who uses it.
const storybookSecretAgents = storybookAgents.map((agent, index) =>
  index < 2
    ? { ...agent, adapterConfig: { ...agent.adapterConfig, env: { OPENAI_API_KEY: { type: "secret_ref", secretId: baseSecret.id, version: "latest" } } } }
    : agent,
);

// Seed localStorage before CompanyContext mounts so its `useState` initializer reads the right id.
if (typeof window !== "undefined") {
  window.localStorage.setItem("paperclip.selectedCompanyId", COMPANY_ID);
}

function StorybookSecretsFixtures({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // Seed query caches synchronously so children hydrate from cache on first render.
  queryClient.setQueryData(queryKeys.secrets.list(COMPANY_ID), storybookSecretInventory);
  queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), storybookSecretAgents);
  queryClient.setQueryData(
    queryKeys.secrets.userDefinitions(COMPANY_ID),
    storybookUserSecretDefinitions,
  );
  queryClient.setQueryData(
    queryKeys.secrets.myUserSecrets(COMPANY_ID),
    storybookUserSecretDefinitions.map((definition) => ({ definition, secret: null })),
  );
  for (const [definitionId, summary] of Object.entries(storybookUserSecretCoverage)) {
    queryClient.setQueryData(
      queryKeys.secrets.userDefinitionCoverage(COMPANY_ID, definitionId),
      summary,
    );
  }

  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  useEffect(() => {
    if (selectedCompanyId !== COMPANY_ID) {
      setSelectedCompanyId(COMPANY_ID);
    }
  }, [selectedCompanyId, setSelectedCompanyId]);

  // Block render until the company id is the storybook fixture so the BindingPicker's
  // useQuery never sees the production-like null state.
  if (selectedCompanyId !== COMPANY_ID) {
    return null;
  }

  return <>{children}</>;
}

const meta: Meta = {
  id: "product-secrets",
  title: "Apps, channels, and extensions/Secrets and proposals/Product/Secrets",
  parameters: {
    layout: "fullscreen",
    a11y: {
      test: "off",
    },
    paperclip: {
      "capabilities": [
        "secrets/company-secrets",
        "secrets/vault-import"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "The shipped Secrets page on fixture data: team secrets with who provides and who uses them, folders, the collapsed Managed by Paperclip section, the New secret dialog, the details panel and the Vaults tab. Nothing is stored, encrypted or delivered; agent access, vault health and import are covered by tests and need a live instance to prove."
    },
  },
};

export default meta;

type Story = StoryObj;

function Section({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border pb-8 last:border-b-0">
      <header className="mb-3 px-6 pt-6">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      </header>
      <div className="px-6">{children}</div>
    </section>
  );
}

export const SecretsInventory: Story = {
  render: () => (
    <StorybookSecretsFixtures>
      <div className="h-screen w-full bg-background">
        <Secrets />
      </div>
    </StorybookSecretsFixtures>
  ),
};

function SecretsPage() {
  return (
    <StorybookSecretsFixtures>
      <div className="h-screen w-full bg-background p-6">
        <Secrets />
      </div>
    </StorybookSecretsFixtures>
  );
}

export const ManagedByPaperclip: Story = {
  render: () => <SecretsPage />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const section = within(await canvas.findByTestId("managed-secrets"));
    await expect(canvas.queryByText("Slack bot token")).not.toBeInTheDocument();
    await userEvent.click(section.getByRole("button", { name: /Managed by Paperclip/ }));
    await userEvent.click(section.getByRole("button", { name: /Chat channels/ }));
    await expect((await section.findAllByText("Slack bot token")).length).toBeGreaterThan(0);
  },
};

export const InsideFolder: Story = {
  parameters: { initialEntries: ["/PAP/company/settings/secrets?path=staging"] },
  render: () => <SecretsPage />,
};

export const NewSecret: Story = {
  render: () => <SecretsPage />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement), body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: "New secret" }));
    const dialog = within(await body.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "Create secret" }));
    await expect(await dialog.findByText("Give the secret a name.")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /Organization/ })).toHaveAttribute("aria-checked", "true");
  },
};

export const NewSecretEachUser: Story = {
  render: () => <SecretsPage />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement), body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: "New secret" }));
    const dialog = within(await body.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("radio", { name: /Each user/ }));
    await expect(dialog.queryByRole("textbox", { name: "Value" })).not.toBeInTheDocument();
    await expect(dialog.getByLabelText(/Instructions for members/)).toBeVisible();
  },
};

export const SecretDetails: Story = {
  parameters: { initialEntries: ["/PAP/company/settings/secrets?secret=secret-openai"] },
  render: () => <SecretsPage />,
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement.ownerDocument.body).findByTestId("secret-details"));
    await expect(await panel.findByRole("button", { name: `Remove access for ${storybookSecretAgents[0]!.name}` })).toBeVisible();
  },
};

export const EachUserSecretDetails: Story = {
  parameters: { initialEntries: ["/PAP/company/settings/secrets?definition=def-storybook-github"] },
  render: () => <SecretsPage />,
};

export const Vaults: Story = {
  render: () => <SecretsPage />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("tab", { name: "Vaults" }));
    await expect(await canvas.findByTestId("provider-vault-built-in")).toBeVisible();
  },
};

function BindingPickerSurface({
  initial,
  label,
}: {
  initial: SecretBindingValue | null;
  label: string;
}) {
  const [value, setValue] = useState<SecretBindingValue | null>(initial);
  return (
    <Card className="w-96">
      <CardHeader>
        <CardTitle className="text-sm">{label}</CardTitle>
        <CardDescription className="text-xs">
          Picker can be reused across agent, project, environment, and plugin config surfaces.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <SecretBindingPicker value={value} onChange={setValue} />
        <pre className="rounded bg-muted/40 p-2 text-[11px] font-mono">
          {JSON.stringify(value, null, 2)}
        </pre>
      </CardContent>
    </Card>
  );
}

export const BindingPicker: Story = {
  render: () => {
    return (
      <StorybookSecretsFixtures>
        <div className="grid grid-cols-1 gap-6 p-6 md:grid-cols-2">
          <BindingPickerSurface initial={null} label="Empty state" />
          <BindingPickerSurface
            initial={{ secretId: storybookSecrets[0]!.id, version: "latest" }}
            label="Bound to active secret"
          />
          <BindingPickerSurface
            initial={{ secretId: storybookSecrets[2]!.id, version: "latest" }}
            label="Bound but disabled"
          />
          <BindingPickerSurface
            initial={{ secretId: "missing-id", version: "latest" }}
            label="Bound to missing secret"
          />
        </div>
      </StorybookSecretsFixtures>
    );
  },
};

export const EnvEditorWithSecrets: Story = {
  render: () => {
    function EditorDemo({ initial, label }: { initial: Record<string, EnvBinding>; label: string }) {
      const [env, setEnv] = useState<Record<string, EnvBinding>>(initial);
      return (
        <Card className="w-full max-w-2xl">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5" />
              {label}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <EnvironmentVariablesEditor
              value={env}
              secrets={storybookSecrets as CompanySecret[]}
              onCreateSecret={async (name, value) => ({
                ...storybookSecrets[0]!,
                id: `secret-${Math.random().toString(36).slice(2, 8)}`,
                name,
                key: name.toLowerCase(),
                description: `New secret with value len=${value.length}`,
              })}
              onChange={(next) => setEnv(next ?? {})}
            />
          </CardContent>
        </Card>
      );
    }
    return (
      <div className="space-y-6 p-6">
        <EditorDemo
          label="Healthy bindings"
          initial={{
            OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-openai", version: "latest" },
            STAGE: { type: "plain", value: "production" },
          }}
        />
        <EditorDemo
          label="Mixed bindings (some need attention)"
          initial={{
            OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-openai", version: 2 },
            GITHUB_APP_PEM: { type: "secret_ref", secretId: "secret-github", version: "latest" },
            ABANDONED: { type: "secret_ref", secretId: "missing-id", version: "latest" },
          }}
        />
      </div>
    );
  },
};

export const RunFailureCopy: Story = {
  render: () => (
    <div className="space-y-4 p-6">
      <Section eyebrow="Run failure" title="Missing or disabled secret blocks the run">
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader className="space-y-1">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-destructive" />
              <Badge variant="outline" className="border-destructive/40 text-destructive">
                Run failed
              </Badge>
              <span className="text-xs font-mono text-muted-foreground">PAP-2350 · run-storybook</span>
            </div>
            <CardTitle className="text-sm">
              Secret <span className="font-mono">OPENAI_API_KEY</span> is{" "}
              <span className="font-medium text-destructive">disabled</span>
            </CardTitle>
            <CardDescription className="text-xs">
              The agent tried to resolve <span className="font-mono">env.OPENAI_API_KEY</span> for{" "}
              <span className="font-mono">agent:CodexCoder</span> but the secret is currently disabled. No value was
              loaded, no run logs were emitted that contained secret material.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div>
              <p className="text-muted-foreground">Next action</p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>
                  Re-enable the secret on{" "}
                  <a className="text-primary underline" href="/PAP/company/settings/secrets">
                    Company settings &gt; Secrets
                  </a>
                </li>
                <li>Or, rotate to a new value and pin v3 explicitly for this agent.</li>
                <li>Or, swap the binding to a different secret with the binding picker.</li>
              </ul>
            </div>
            <div>
              <p className="text-muted-foreground">Audit</p>
              <p className="font-mono text-[11px]">
                secret_access_events.outcome=failure error=secret_disabled consumer=agent:CodexCoder
              </p>
            </div>
          </CardContent>
        </Card>
      </Section>
    </div>
  ),
};
