import { useEffect, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, KeyRound } from "lucide-react";
import type { CompanySecret, EnvBinding } from "@paperclipai/shared";
import { Secrets } from "@/pages/Secrets";
import { SecretBindingPicker, type SecretBindingValue } from "@/components/SecretBindingPicker";
import { EnvVarEditor } from "@/components/EnvVarEditor";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { storybookCompanies, storybookSecrets } from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";

// Seed localStorage before CompanyContext mounts so its `useState` initializer reads the right id.
if (typeof window !== "undefined") {
  window.localStorage.setItem("paperclip.selectedCompanyId", COMPANY_ID);
}

function StorybookSecretsFixtures({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // Seed query caches synchronously so children hydrate from cache on first render.
  queryClient.setQueryData(queryKeys.companies.all, storybookCompanies);
  queryClient.setQueryData(queryKeys.secrets.list(COMPANY_ID), storybookSecrets);

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
  title: "Product/Secrets",
  parameters: {
    layout: "fullscreen",
    a11y: {
      test: "off",
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
            <EnvVarEditor
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
