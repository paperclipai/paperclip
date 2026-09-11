import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CompanySecret, RoutineEnvConfig } from "@paperclipai/shared";
import { StageSecretsPanel } from "@/components/StageSecretsPanel";
import { storybookSecrets } from "../fixtures/paperclipData";

const meta: Meta = {
  title: "Product/Pipelines · Stage secrets tab",
  parameters: {
    layout: "fullscreen",
    a11y: { test: "off" },
  },
};

export default meta;

type Story = StoryObj;

async function fakeCreateSecret(name: string): Promise<CompanySecret> {
  return {
    ...(storybookSecrets[0] as CompanySecret),
    id: `secret-${name.toLowerCase()}`,
    name,
    key: name.toLowerCase(),
    description: `Inline-created secret ${name}`,
  };
}

function StageSecretsSurface({
  hasAutomation,
  agentName,
  initial,
  secretsLoading,
}: {
  hasAutomation: boolean;
  agentName?: string | null;
  initial?: RoutineEnvConfig | null;
  secretsLoading?: boolean;
}) {
  const [env, setEnv] = useState<RoutineEnvConfig>(() => (initial ?? {}) as RoutineEnvConfig);
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState(() => JSON.stringify(initial ?? {}));
  const dirty = JSON.stringify(env) !== savedKey;
  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <StageSecretsPanel
        hasAutomation={hasAutomation}
        agentName={agentName}
        agentIcon="bot"
        secrets={storybookSecrets as CompanySecret[]}
        secretsLoading={Boolean(secretsLoading)}
        value={env}
        onChange={setEnv}
        onCreateSecret={fakeCreateSecret}
        onSetupAutomation={() => {}}
        onSave={() => {
          setSaving(true);
          window.setTimeout(() => {
            setSavedKey(JSON.stringify(env));
            setSaving(false);
          }, 600);
        }}
        saving={saving}
        dirty={dirty}
      />
    </div>
  );
}

export const NoAutomationEmpty: Story = {
  name: "No automation — empty state",
  render: () => <StageSecretsSurface hasAutomation={false} />,
};

export const ConfiguredBindings: Story = {
  name: "Configured — secret refs + plain value",
  render: () => (
    <StageSecretsSurface
      hasAutomation
      agentName="Releasebot"
      initial={{
        GH_TOKEN: { type: "secret_ref", secretId: "secret-openai", version: "latest" },
        PROD_AWS_DEPLOY_KEY: { type: "secret_ref", secretId: "secret-aws-prod", version: 2 },
        STAGE: { type: "plain", value: "production" },
      }}
    />
  ),
};

export const WarningBindings: Story = {
  name: "Warning — disabled + missing secret",
  render: () => (
    <StageSecretsSurface
      hasAutomation
      agentName="Releasebot"
      initial={{
        GITHUB_APP_PEM: { type: "secret_ref", secretId: "secret-github", version: "latest" },
        ABANDONED: { type: "secret_ref", secretId: "missing-id", version: "latest" },
      }}
    />
  ),
};

export const LoadingState: Story = {
  name: "Loading secrets",
  render: () => <StageSecretsSurface hasAutomation agentName="Releasebot" secretsLoading />,
};
