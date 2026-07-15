import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CompanySecret, EnvBinding, SecretStatus } from "@paperclipai/shared";
import { EnvironmentVariablesEditor } from "@/components/environment-variables-editor";
import { ToastProvider } from "@/context/ToastContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function secret(
  id: string,
  name: string,
  overrides: Partial<CompanySecret> = {},
): CompanySecret {
  return {
    id,
    companyId: "company-storybook",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: name.toLowerCase(),
    name,
    provider: "local_encrypted",
    status: "active" as SecretStatus,
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-board",
    createdAt: new Date("2026-03-01T10:00:00.000Z"),
    updatedAt: new Date("2026-04-01T10:00:00.000Z"),
    ...overrides,
  };
}

const SECRETS: CompanySecret[] = [
  secret("s-github", "GITHUB_TOKEN", { latestVersion: 3 }),
  secret("s-db", "DB_CONNECTION", { latestVersion: 3 }),
  secret("s-openai", "OPENAI_API_KEY", { latestVersion: 2 }),
  secret("s-resend-long", "/paperclip-cloud/prod/provider/resend/api-key-with-a-very-long-name", { latestVersion: 4 }),
  secret("s-legacy", "LEGACY_DEPLOY_KEY", { status: "disabled", latestVersion: 2 }),
  secret("s-archived", "OLD_STRIPE_KEY", { status: "archived", latestVersion: 4 }),
];

const RECENTLY_USED: CompanySecret[] = [SECRETS[2], secret("s-slack", "SLACK_WEBHOOK", { latestVersion: 1 })];

function Surface({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <ToastProvider>
      <div className="p-6">
        <Card className="w-full max-w-[720px]">
          <CardHeader>
            <CardTitle className="text-sm">{title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            {children}
          </CardContent>
        </Card>
      </div>
    </ToastProvider>
  );
}

function Editor({
  initial,
  disabled,
  recentlyUsed,
}: {
  initial: Record<string, EnvBinding>;
  disabled?: boolean;
  recentlyUsed?: CompanySecret[];
}) {
  const [env, setEnv] = useState<Record<string, EnvBinding>>(initial);
  return (
    <EnvironmentVariablesEditor
      value={env}
      secrets={SECRETS}
      recentlyUsedSecrets={recentlyUsed ?? RECENTLY_USED}
      disabled={disabled}
      onChange={(next) => setEnv(next ?? {})}
      onCreateSecret={async (name, value) =>
        secret(`s-new-${name}`, name.toUpperCase(), { key: name, latestVersion: 1, description: `len=${value.length}` })
      }
    />
  );
}

const meta: Meta = {
  title: "Product/Environment Variables Editor",
  parameters: { layout: "fullscreen", a11y: { test: "off" } },
};
export default meta;
type Story = StoryObj;

/** Frame 1 — default state with 4 mixed rows incl. pinned version + sensitive hint. */
export const Default: Story = {
  render: () => (
    <Surface title="Default — mixed rows">
      <Editor
        initial={{
          NODE_ENV: { type: "plain", value: "production" },
          GH_TOKEN: { type: "secret_ref", secretId: "s-github", version: "latest" },
          DB_URL: { type: "secret_ref", secretId: "s-db", version: 3 },
          STRIPE_API_KEY: { type: "plain", value: "sk-live-51H8xL0aBcDeFgHiJkLmNoPq" },
        }}
      />
    </Surface>
  ),
};

/** Frame 2 — empty state. */
export const Empty: Story = {
  render: () => (
    <Surface title="Empty — no variables">
      <Editor initial={{}} />
    </Surface>
  ),
};

/** Frame 3 — secret picker open (interactive: click the secret trigger). */
export const PickerOpen: Story = {
  render: () => (
    <Surface title="Secret picker" hint="Click the secret value trigger to open the fuzzy picker; type to filter, or pick the pinned “+ Create secret” item.">
      <Editor initial={{ GH_TOKEN: { type: "secret_ref", secretId: "", version: "latest" } }} />
    </Surface>
  ),
};

/** Frame 4 — long bound secret name truncates before the latest badge. */
export const LongSecretName: Story = {
  render: () => (
    <Surface title="Long secret name">
      <Editor initial={{ RESEND_API_KEY: { type: "secret_ref", secretId: "s-resend-long", version: "latest" } }} />
    </Surface>
  ),
};

/** Frame 5 — create-secret popover (interactive: open picker → Create secret). */
export const CreateSecret: Story = {
  render: () => (
    <Surface title="Create secret" hint="Open the secret picker and choose “+ Create secret …” to open the anchored create popover (name + masked value).">
      <Editor initial={{ NEW_TOKEN: { type: "secret_ref", secretId: "", version: "latest" } }} />
    </Surface>
  ),
};

/** Frame 6 — store-as-secret popover (interactive: click the ShieldAlert on the sensitive row). */
export const StoreAsSecret: Story = {
  render: () => (
    <Surface title="Store value as secret" hint="The sensitive-looking row shows a ShieldAlert “Store as secret” — click it to open the store popover (value preserved, masked). The adjacent “×” dismisses the hint and unmasks the value, keeping it as plain text.">
      <Editor initial={{ AWS_SECRET_ACCESS_KEY: { type: "plain", value: "wJalrXUtnFEMI0K7MDENGbPxRfiCYEXAMPLEKEY" } }} />
    </Surface>
  ),
};

/** Frame 6 — version popover (interactive: click the amber version tag). */
export const VersionPopover: Story = {
  render: () => (
    <Surface title="Version pinning" hint="The bound secret is pinned to v3 (amber tag). Click the tag to choose latest (recommended) or a specific version.">
      <Editor initial={{ DB_URL: { type: "secret_ref", secretId: "s-db", version: 3 } }} />
    </Surface>
  ),
};

/** Frame 7 — validation trio + attention summary. */
export const Validation: Story = {
  render: () => (
    <Surface title="Validation & health" hint="Invalid charset + reserved prefix warn on load; missing + disabled secret bindings drive the “2 bindings need attention” summary. Add a duplicate name to see the duplicate flag.">
      <Editor
        initial={{
          "API-URL": { type: "plain", value: "https://api.example.com" },
          PAPERCLIP_TOKEN: { type: "plain", value: "override" },
          ABANDONED: { type: "secret_ref", secretId: "gone-1234", version: "latest" },
          LEGACY: { type: "secret_ref", secretId: "s-legacy", version: "latest" },
        }}
      />
    </Surface>
  ),
};

/** Frame 8 — bulk-paste result (post-import state, last row flagged sensitive). */
export const BulkPasteResult: Story = {
  render: () => (
    <Surface title="Bulk .env paste — result" hint="Pasting a multi-line KEY=VALUE block into an empty Name field imports one row per pair; sensitive-looking rows are auto-flagged.">
      <Editor
        initial={{
          NODE_ENV: { type: "plain", value: "production" },
          PORT: { type: "plain", value: "3000" },
          LOG_LEVEL: { type: "plain", value: "info" },
          STRIPE_API_KEY: { type: "plain", value: "sk-live-51H8xL0aBcDeFgHiJkLmNoPq" },
        }}
      />
    </Surface>
  ),
};

/** Frame 9 — 390px stacked layout (container-responsive). */
export const MobileStacked: Story = {
  render: () => (
    <ToastProvider>
      <div className="p-6">
        <div className="w-[390px] rounded-lg border border-border p-4">
          <Editor
            initial={{
              NODE_ENV: { type: "plain", value: "production" },
              GH_TOKEN: { type: "secret_ref", secretId: "s-github", version: "latest" },
              STRIPE_API_KEY: { type: "plain", value: "sk-live-51H8xL0aBcDeFgHiJkLmNoPq" },
            }}
          />
        </div>
      </div>
    </ToastProvider>
  ),
};

/** Frame 10 — disabled (read-only) state, health warnings still visible. */
export const Disabled: Story = {
  render: () => (
    <Surface title="Disabled — read-only">
      <Editor
        disabled
        initial={{
          NODE_ENV: { type: "plain", value: "production" },
          GH_TOKEN: { type: "secret_ref", secretId: "s-github", version: "latest" },
          LEGACY: { type: "secret_ref", secretId: "s-legacy", version: "latest" },
        }}
      />
    </Surface>
  ),
};
