import { useEffect, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type {
  CompanySecret,
  EnvBinding,
  UserSecretCoverageSummary,
  UserSecretDefinition,
} from "@paperclipai/shared";
import { MemoryRouter } from "react-router-dom";
import { MyUserSecretsTab } from "@/pages/secrets/MyUserSecretsTab";
import { UserSecretDefinitionsTab } from "@/pages/secrets/UserSecretDefinitionsTab";
import { MissingUserSecretsBanner } from "@/pages/secrets/MissingUserSecretsBanner";
import { EnvironmentVariablesEditor } from "@/components/environment-variables-editor";
import type { MyUserSecretEntry } from "@/api/secrets";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

const COMPANY_ID = "company-storybook";

if (typeof window !== "undefined") {
  window.localStorage.setItem("paperclip.selectedCompanyId", COMPANY_ID);
}

function makeDefinition(overrides: Partial<UserSecretDefinition>): UserSecretDefinition {
  return {
    id: "def-x",
    companyId: COMPANY_ID,
    key: "USER_SECRET",
    name: "User secret",
    description: null,
    status: "active",
    provider: "local_encrypted",
    managedMode: "paperclip_managed",
    providerConfigId: null,
    providerMetadata: null,
    usageGuidance: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    deletedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

function makeValue(definitionId: string): CompanySecret {
  return {
    id: `sec-${definitionId}`,
    companyId: COMPANY_ID,
    scope: "user",
    ownerUserId: "user-me",
    userSecretDefinitionId: definitionId,
    key: "USER_SECRET",
    name: "User secret",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-me",
    createdAt: new Date("2026-06-02T00:00:00Z"),
    updatedAt: new Date("2026-06-02T00:00:00Z"),
  };
}

const ghToken = makeDefinition({
  id: "def-gh",
  key: "PERSONAL_GH_TOKEN",
  name: "Personal GitHub token",
  description: "Used when the responsible user's own repos must be reached.",
  usageGuidance: "Create a fine-grained PAT with repo:read scope.",
});
const openai = makeDefinition({
  id: "def-openai",
  key: "OPENAI_API_KEY",
  name: "OpenAI API key",
  description: "Each member bills to their own OpenAI account.",
});
const slack = makeDefinition({
  id: "def-slack",
  key: "SLACK_USER_TOKEN",
  name: "Slack user token",
  status: "disabled",
});

const definitions: UserSecretDefinition[] = [ghToken, openai, slack];

const coverage: Record<string, UserSecretCoverageSummary> = {
  "def-gh": { definitionId: "def-gh", configuredCount: 5, missingCount: 2, inactiveCount: 0 },
  "def-openai": { definitionId: "def-openai", configuredCount: 7, missingCount: 0, inactiveCount: 0 },
  "def-slack": { definitionId: "def-slack", configuredCount: 1, missingCount: 5, inactiveCount: 1 },
};

const myEntries: MyUserSecretEntry[] = [
  { definition: ghToken, secret: null },
  { definition: openai, secret: makeValue("def-openai") },
  { definition: slack, secret: null },
];

function SeedFixtures({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  queryClient.setQueryData(queryKeys.secrets.userDefinitions(COMPANY_ID), definitions);
  queryClient.setQueryData(queryKeys.secrets.myUserSecrets(COMPANY_ID), myEntries);
  for (const [definitionId, summary] of Object.entries(coverage)) {
    queryClient.setQueryData(
      queryKeys.secrets.userDefinitionCoverage(COMPANY_ID, definitionId),
      summary,
    );
  }

  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  useEffect(() => {
    if (selectedCompanyId !== COMPANY_ID) setSelectedCompanyId(COMPANY_ID);
  }, [selectedCompanyId, setSelectedCompanyId]);
  if (selectedCompanyId !== COMPANY_ID) return null;

  // The preview decorator already provides a MemoryRouter; nesting a second
  // react-router Router here raced it and intermittently threw
  // "You cannot render a <Router> inside another <Router>".
  return <>{children}</>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border p-6 last:border-b-0">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

const meta: Meta = {
  title: "Product/User secrets",
  parameters: { layout: "fullscreen", a11y: { test: "off" } },
};
export default meta;
type Story = StoryObj;

export const AdminDefinitions: Story = {
  render: () => (
    <SeedFixtures>
      <Section title="User secret definitions (admin)">
        <div className="h-[520px]">
          <UserSecretDefinitionsTab companyId={COMPANY_ID} />
        </div>
      </Section>
    </SeedFixtures>
  ),
};

export const MySecrets: Story = {
  render: () => (
    <SeedFixtures>
      <Section title="My secrets (owner)">
        <div className="h-[520px]">
          <MyUserSecretsTab companyId={COMPANY_ID} />
        </div>
      </Section>
    </SeedFixtures>
  ),
};

export const MissingWarning: Story = {
  render: () => (
    <SeedFixtures>
      <Section title="Missing user-secret warning (task creation / run)">
        <div className="max-w-xl">
          <MissingUserSecretsBanner
            companyId={COMPANY_ID}
            secretsPath="/company/secrets"
          />
        </div>
      </Section>
    </SeedFixtures>
  ),
};

export const EnvPicker: Story = {
  render: () => {
    const value: Record<string, EnvBinding> = {
      GH_TOKEN: { type: "user_secret_ref", key: "PERSONAL_GH_TOKEN", required: true },
      OPENAI_API_KEY: { type: "user_secret_ref", key: "OPENAI_API_KEY", required: false },
    };
    return (
      <SeedFixtures>
        <Section title="Env binding picker — User secret source">
          <div className="max-w-2xl">
            <EnvironmentVariablesEditor
              value={value}
              secrets={[]}
              userSecretDefinitions={definitions}
              onCreateSecret={async () => {
                throw new Error("noop");
              }}
              onChange={() => {}}
            />
          </div>
        </Section>
      </SeedFixtures>
    );
  },
};
