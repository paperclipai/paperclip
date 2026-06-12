import { ChangeEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_ADAPTER_TYPES,
  K8S_ADAPTERS,
  getAdapterEnvironmentSupport,
  type Environment,
  type EnvironmentProbeResult,
  type JsonSchema,
} from "@paperclipai/shared";
import {
  buildK8sEnvironmentConfig,
  parseTolerationsJson,
  readProviderExtras,
} from "../lib/environment-form";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { companiesApi } from "../api/companies";
import { assetsApi } from "../api/assets";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import { secretsApi } from "../api/secrets";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Settings, Check, CloudUpload, Download, Upload, Loader2 } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { JsonSchemaForm, getDefaultValues, validateJsonSchemaForm } from "@/components/JsonSchemaForm";
import {
  Field,
  ToggleField,
  HintIcon,
  adapterLabels,
} from "../components/agent-config-primitives";

type AgentSnippetInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

type EnvironmentFormState = {
  name: string;
  description: string;
  driver: "local" | "ssh" | "sandbox" | "k8s";
  sshHost: string;
  sshPort: string;
  sshUsername: string;
  sshRemoteWorkspacePath: string;
  sshPrivateKey: string;
  sshPrivateKeySecretId: string;
  sshKnownHosts: string;
  sshStrictHostKeyChecking: boolean;
  sandboxProvider: string;
  sandboxConfig: Record<string, unknown>;
  // K8s driver fields. The shared `k8sEnvironmentConfigSchema` is `.strict()`
  // and rejects empty strings, so the submit handler builds a nested `config`
  // object that omits blanks via `buildK8sEnvironmentConfig`.
  k8sKubeconfigSecretRef: string;
  k8sUseInClusterAuth: boolean;
  k8sNamespace: string;
  k8sServiceAccountName: string;
  k8sNodeSelector: string;
  k8sTolerations: string;
  k8sLabels: string;
  k8sImagePullPolicy: string;
  k8sResourcesRequestsCpu: string;
  k8sResourcesRequestsMemory: string;
  k8sResourcesLimitsCpu: string;
  k8sResourcesLimitsMemory: string;
  k8sWorkspaceVolumeClaim: string;
  k8sWorkspaceMountPath: string;
  k8sSecretsNamespace: string;
  k8sProviderAnthropicKind: "ccrotate";
  k8sProviderAnthropicAccounts: string;
  k8sProviderOpenaiKind: "ccrotate";
  k8sProviderOpenaiAccounts: string;
  k8sProviderExtras: Record<string, { kind: "ccrotate"; accounts: string[] }>;
};

// AGENT_ADAPTER_TYPES doesn't include the k8s-only adapters, so concatenate
// them so the fallback row source matches the K8s column header.
const ENVIRONMENT_SUPPORT_ROWS = [...AGENT_ADAPTER_TYPES, ...K8S_ADAPTERS].map((adapterType) => ({
  adapterType,
  support: getAdapterEnvironmentSupport(adapterType),
}));

function buildEnvironmentPayload(form: EnvironmentFormState) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    driver: form.driver,
    config:
      form.driver === "ssh"
        ? {
            host: form.sshHost.trim(),
            port: Number.parseInt(form.sshPort || "22", 10) || 22,
            username: form.sshUsername.trim(),
            remoteWorkspacePath: form.sshRemoteWorkspacePath.trim(),
            privateKey: form.sshPrivateKey.trim() || null,
            privateKeySecretRef:
              form.sshPrivateKey.trim().length > 0 || !form.sshPrivateKeySecretId
                ? null
                : { type: "secret_ref" as const, secretId: form.sshPrivateKeySecretId, version: "latest" as const },
            knownHosts: form.sshKnownHosts.trim() || null,
            strictHostKeyChecking: form.sshStrictHostKeyChecking,
          }
        : form.driver === "sandbox"
          ? {
              provider: form.sandboxProvider.trim(),
              ...form.sandboxConfig,
            }
          : form.driver === "k8s"
            ? buildK8sEnvironmentConfig(form)
            : {},
  } as const;
}

function createEmptyEnvironmentForm(): EnvironmentFormState {
  return {
    name: "",
    description: "",
    driver: "ssh",
    sshHost: "",
    sshPort: "22",
    sshUsername: "",
    sshRemoteWorkspacePath: "",
    sshPrivateKey: "",
    sshPrivateKeySecretId: "",
    sshKnownHosts: "",
    sshStrictHostKeyChecking: true,
    sandboxProvider: "",
    sandboxConfig: {},
    k8sKubeconfigSecretRef: "",
    k8sUseInClusterAuth: true,
    k8sNamespace: "",
    k8sServiceAccountName: "",
    k8sNodeSelector: "",
    k8sTolerations: "",
    k8sLabels: "",
    k8sImagePullPolicy: "",
    k8sResourcesRequestsCpu: "",
    k8sResourcesRequestsMemory: "",
    k8sResourcesLimitsCpu: "",
    k8sResourcesLimitsMemory: "",
    k8sWorkspaceVolumeClaim: "",
    k8sWorkspaceMountPath: "",
    k8sSecretsNamespace: "",
    k8sProviderAnthropicKind: "ccrotate",
    k8sProviderAnthropicAccounts: "",
    k8sProviderOpenaiKind: "ccrotate",
    k8sProviderOpenaiAccounts: "",
    k8sProviderExtras: {},
  };
}

function readSshConfig(environment: Environment) {
  const config = environment.config ?? {};
  return {
    host: typeof config.host === "string" ? config.host : "",
    port:
      typeof config.port === "number"
        ? String(config.port)
        : typeof config.port === "string"
          ? config.port
          : "22",
    username: typeof config.username === "string" ? config.username : "",
    remoteWorkspacePath:
      typeof config.remoteWorkspacePath === "string" ? config.remoteWorkspacePath : "",
    privateKey: "",
    privateKeySecretId:
      config.privateKeySecretRef &&
      typeof config.privateKeySecretRef === "object" &&
      !Array.isArray(config.privateKeySecretRef) &&
      typeof (config.privateKeySecretRef as { secretId?: unknown }).secretId === "string"
        ? String((config.privateKeySecretRef as { secretId: string }).secretId)
        : "",
    knownHosts: typeof config.knownHosts === "string" ? config.knownHosts : "",
    strictHostKeyChecking:
      typeof config.strictHostKeyChecking === "boolean"
        ? config.strictHostKeyChecking
        : true,
  };
}

function formatKeyValueLines(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.entries(value as Record<string, unknown>)
    .filter(([_, v]) => typeof v === "string")
    .map(([k, v]) => `${k}=${v as string}`)
    .join("\n");
}

function readK8sFormFromConfig(environment: Environment) {
  const config = (environment.config ?? {}) as Record<string, unknown>;
  const ref =
    typeof config.kubeconfigSecretRef === "string" ? (config.kubeconfigSecretRef as string) : "";
  const resources =
    config.resources && typeof config.resources === "object" && !Array.isArray(config.resources)
      ? (config.resources as { requests?: { cpu?: unknown; memory?: unknown }; limits?: { cpu?: unknown; memory?: unknown } })
      : null;
  return {
    k8sKubeconfigSecretRef: ref,
    k8sUseInClusterAuth: ref.length === 0,
    k8sNamespace: typeof config.namespace === "string" ? (config.namespace as string) : "",
    k8sServiceAccountName:
      typeof config.serviceAccountName === "string" ? (config.serviceAccountName as string) : "",
    k8sNodeSelector: formatKeyValueLines(config.nodeSelector),
    k8sTolerations: Array.isArray(config.tolerations)
      ? JSON.stringify(config.tolerations, null, 2)
      : "",
    k8sLabels: formatKeyValueLines(config.labels),
    k8sImagePullPolicy:
      typeof config.imagePullPolicy === "string" ? (config.imagePullPolicy as string) : "",
    k8sResourcesRequestsCpu:
      resources?.requests && typeof resources.requests.cpu === "string" ? resources.requests.cpu : "",
    k8sResourcesRequestsMemory:
      resources?.requests && typeof resources.requests.memory === "string"
        ? resources.requests.memory
        : "",
    k8sResourcesLimitsCpu:
      resources?.limits && typeof resources.limits.cpu === "string" ? resources.limits.cpu : "",
    k8sResourcesLimitsMemory:
      resources?.limits && typeof resources.limits.memory === "string"
        ? resources.limits.memory
        : "",
    k8sWorkspaceVolumeClaim:
      typeof config.workspaceVolumeClaim === "string" ? (config.workspaceVolumeClaim as string) : "",
    k8sWorkspaceMountPath:
      typeof config.workspaceMountPath === "string" ? (config.workspaceMountPath as string) : "",
    k8sSecretsNamespace:
      typeof config.secretsNamespace === "string" ? (config.secretsNamespace as string) : "",
    k8sProviderAnthropicKind: "ccrotate" as const,
    k8sProviderAnthropicAccounts: formatProviderAccounts(config.providers, "anthropic"),
    k8sProviderOpenaiKind: "ccrotate" as const,
    k8sProviderOpenaiAccounts: formatProviderAccounts(config.providers, "openai"),
    k8sProviderExtras: readProviderExtras(config.providers),
  };
}

function formatProviderAccounts(providers: unknown, key: string): string {
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return "";
  const entry = (providers as Record<string, unknown>)[key];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
  const accounts = (entry as Record<string, unknown>).accounts;
  if (!Array.isArray(accounts)) return "";
  return accounts.filter((a) => typeof a === "string").join("\n");
}

function readSandboxConfig(environment: Environment) {
  const config = environment.config ?? {};
  const { provider: rawProvider, ...providerConfig } = config;
  return {
    provider: typeof rawProvider === "string" && rawProvider.trim().length > 0
      ? rawProvider
        : "fake",
    config: providerConfig,
  };
}

function normalizeJsonSchema(schema: unknown): JsonSchema | null {
  return schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema as JsonSchema
    : null;
}

function summarizeSandboxConfig(config: Record<string, unknown>): string | null {
  for (const key of ["template", "image", "region", "workspacePath"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function SupportMark({ supported }: { supported: boolean }) {
  return supported ? (
    <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
      <Check className="h-3 w-3" />
      Yes
    </span>
  ) : (
    <span className="text-muted-foreground">No</span>
  );
}

export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId
  } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);
  const [editingEnvironmentId, setEditingEnvironmentId] = useState<string | null>(null);
  const [environmentForm, setEnvironmentForm] = useState<EnvironmentFormState>(createEmptyEnvironmentForm);
  const [probeResults, setProbeResults] = useState<Record<string, EnvironmentProbeResult | null>>({});

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setLogoUrl(selectedCompany.logoUrl ?? "");
  }, [selectedCompany]);

  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSnippet, setInviteSnippet] = useState<string | null>(null);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [snippetCopyDelightId, setSnippetCopyDelightId] = useState(0);

  const environmentsEnabled = experimentalSettings?.enableEnvironments === true;
  const cloudSyncEnabled = experimentalSettings?.enableCloudSync === true;

  const { data: environments } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.environments.list(selectedCompanyId) : ["environments", "none"],
    queryFn: () => environmentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && environmentsEnabled,
  });
  const { data: environmentCapabilities } = useQuery({
    queryKey: selectedCompanyId ? ["environment-capabilities", selectedCompanyId] : ["environment-capabilities", "none"],
    queryFn: () => environmentsApi.capabilities(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && environmentsEnabled,
  });

  const { data: secrets } = useQuery({
    queryKey: selectedCompanyId ? ["company-secrets", selectedCompanyId] : ["company-secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? ""));

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const syncLogoState = (nextLogoUrl: string | null) => {
    setLogoUrl(nextLogoUrl ?? "");
    void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  };

  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadCompanyLogo(selectedCompanyId!, file)
        .then((asset) => companiesApi.update(selectedCompanyId!, { logoAssetId: asset.assetId })),
    onSuccess: (company) => {
      syncLogoState(company.logoUrl);
      setLogoUploadError(null);
    }
  });

  const clearLogoMutation = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { logoAssetId: null }),
    onSuccess: (company) => {
      setLogoUploadError(null);
      syncLogoState(company.logoUrl);
    }
  });

  const environmentMutation = useMutation({
    mutationFn: async (form: EnvironmentFormState) => {
      const body = buildEnvironmentPayload(form);

      if (editingEnvironmentId) {
        return await environmentsApi.update(editingEnvironmentId, body);
      }

      return await environmentsApi.create(selectedCompanyId!, body);
    },
    onSuccess: async (environment) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.environments.list(selectedCompanyId!),
      });
      setEditingEnvironmentId(null);
      setEnvironmentForm(createEmptyEnvironmentForm());
      pushToast({
        title: editingEnvironmentId ? "Environment updated" : "Environment created",
        body: `${environment.name} is ready.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to save environment",
        body: error instanceof Error ? error.message : "Environment save failed.",
        tone: "error",
      });
    },
  });

  const environmentProbeMutation = useMutation({
    mutationFn: async (environmentId: string) => await environmentsApi.probe(environmentId),
    onSuccess: (probe, environmentId) => {
      setProbeResults((current) => ({
        ...current,
        [environmentId]: probe,
      }));
      pushToast({
        title: probe.ok ? "Environment probe passed" : "Environment probe failed",
        body: probe.summary,
        tone: probe.ok ? "success" : "error",
      });
    },
    onError: (error, environmentId) => {
      const failedEnvironment = (environments ?? []).find((environment) => environment.id === environmentId);
      setProbeResults((current) => ({
        ...current,
        [environmentId]: {
          ok: false,
          driver: failedEnvironment?.driver ?? "local",
          summary: error instanceof Error ? error.message : "Environment probe failed.",
          details: null,
        },
      }));
      pushToast({
        title: "Environment probe failed",
        body: error instanceof Error ? error.message : "Environment probe failed.",
        tone: "error",
      });
    },
  });

  const draftEnvironmentProbeMutation = useMutation({
    mutationFn: async (form: EnvironmentFormState) => {
      const body = buildEnvironmentPayload(form);
      return await environmentsApi.probeConfig(selectedCompanyId!, body);
    },
    onSuccess: (probe) => {
      pushToast({
        title: probe.ok ? "Draft probe passed" : "Draft probe failed",
        body: probe.summary,
        tone: probe.ok ? "success" : "error",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Draft probe failed",
        body: error instanceof Error ? error.message : "Environment probe failed.",
        tone: "error",
      });
    },
  });

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setLogoUploadError(null);
    logoUploadMutation.mutate(file);
  }

  function handleClearLogo() {
    clearLogoMutation.mutate();
  }

  useEffect(() => {
    setInviteError(null);
    setInviteSnippet(null);
    setSnippetCopied(false);
    setSnippetCopyDelightId(0);
    setEditingEnvironmentId(null);
    setEnvironmentForm(createEmptyEnvironmentForm());
    setProbeResults({});
  }, [selectedCompanyId]);

  const archiveMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.archive(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings" }
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null
    });
  }

  function handleEditEnvironment(environment: Environment) {
    setEditingEnvironmentId(environment.id);
    if (environment.driver === "ssh") {
      const ssh = readSshConfig(environment);
      setEnvironmentForm({
        ...createEmptyEnvironmentForm(),
        name: environment.name,
        description: environment.description ?? "",
        driver: "ssh",
        sshHost: ssh.host,
        sshPort: ssh.port,
        sshUsername: ssh.username,
        sshRemoteWorkspacePath: ssh.remoteWorkspacePath,
        sshPrivateKey: ssh.privateKey,
        sshPrivateKeySecretId: ssh.privateKeySecretId,
        sshKnownHosts: ssh.knownHosts,
        sshStrictHostKeyChecking: ssh.strictHostKeyChecking,
      });
      return;
    }

    if (environment.driver === "sandbox") {
      const sandbox = readSandboxConfig(environment);
      setEnvironmentForm({
        ...createEmptyEnvironmentForm(),
        name: environment.name,
        description: environment.description ?? "",
        driver: "sandbox",
        sandboxProvider: sandbox.provider,
        sandboxConfig: sandbox.config,
      });
      return;
    }

    if (environment.driver === "k8s") {
      const k8s = readK8sFormFromConfig(environment);
      setEnvironmentForm({
        ...createEmptyEnvironmentForm(),
        name: environment.name,
        description: environment.description ?? "",
        driver: "k8s",
        ...k8s,
      });
      return;
    }

    setEnvironmentForm({
      ...createEmptyEnvironmentForm(),
      name: environment.name,
      description: environment.description ?? "",
      driver: "local",
    });
  }

  function handleCancelEnvironmentEdit() {
    setEditingEnvironmentId(null);
    setEnvironmentForm(createEmptyEnvironmentForm());
  }

  const discoveredPluginSandboxProviders = Object.entries(environmentCapabilities?.sandboxProviders ?? {})
    .filter(([provider, capability]) => provider !== "fake" && capability.supportsRunExecution)
    .map(([provider, capability]) => ({
      provider,
      displayName: capability.displayName || provider,
      description: capability.description,
      configSchema: normalizeJsonSchema(capability.configSchema),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  const sandboxCreationEnabled = discoveredPluginSandboxProviders.length > 0;
  const sandboxSupportVisible = sandboxCreationEnabled;
  const pluginSandboxProviders =
    environmentForm.sandboxProvider.trim().length > 0 &&
    environmentForm.sandboxProvider !== "fake" &&
    !discoveredPluginSandboxProviders.some((provider) => provider.provider === environmentForm.sandboxProvider)
      ? [
          ...discoveredPluginSandboxProviders,
          { provider: environmentForm.sandboxProvider, displayName: environmentForm.sandboxProvider, description: undefined, configSchema: null },
        ]
      : discoveredPluginSandboxProviders;

  const selectedSandboxProvider = pluginSandboxProviders.find(
    (provider) => provider.provider === environmentForm.sandboxProvider,
  ) ?? null;
  const selectedSandboxSchema = selectedSandboxProvider?.configSchema ?? null;
  const sandboxConfigErrors =
    environmentForm.driver === "sandbox" && selectedSandboxSchema
      ? validateJsonSchemaForm(selectedSandboxSchema as any, environmentForm.sandboxConfig)
      : {};

  useEffect(() => {
    if (environmentForm.driver !== "sandbox") return;
    if (environmentForm.sandboxProvider.trim().length > 0 && environmentForm.sandboxProvider !== "fake") return;
    const firstProvider = discoveredPluginSandboxProviders[0]?.provider;
    if (!firstProvider) return;
    const firstSchema = discoveredPluginSandboxProviders[0]?.configSchema;
    setEnvironmentForm((current) => (
      current.driver !== "sandbox" || (current.sandboxProvider.trim().length > 0 && current.sandboxProvider !== "fake")
        ? current
        : {
            ...current,
            sandboxProvider: firstProvider,
            sandboxConfig: firstSchema ? getDefaultValues(firstSchema as any) : {},
          }
    ));
  }, [discoveredPluginSandboxProviders, environmentForm.driver, environmentForm.sandboxProvider]);

  const environmentFormValid =
    environmentForm.name.trim().length > 0 &&
    (environmentForm.driver !== "ssh" ||
      (
        environmentForm.sshHost.trim().length > 0 &&
        environmentForm.sshUsername.trim().length > 0 &&
        environmentForm.sshRemoteWorkspacePath.trim().length > 0
      )) &&
    (environmentForm.driver !== "sandbox" ||
      environmentForm.sandboxProvider.trim().length > 0 &&
      environmentForm.sandboxProvider !== "fake" &&
      Object.keys(sandboxConfigErrors).length === 0) &&
    (environmentForm.driver !== "k8s" ||
      (
        // Either in-cluster auth, or non-empty kubeconfig secret ref.
        (environmentForm.k8sUseInClusterAuth ||
          environmentForm.k8sKubeconfigSecretRef.trim().length > 0) &&
        // Tolerations textarea must be empty or valid JSON array.
          parseTolerationsJson(environmentForm.k8sTolerations) !== null
      ));

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Company Settings</h1>
      </div>

      {/* General */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          General
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label="Company name" hint="The display name for your company.">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field
            label="Description"
            hint="Optional description shown in the company profile."
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={description}
              placeholder="Optional company description"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Appearance
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <CompanyPatternIcon
                companyName={companyName || selectedCompany.name}
                logoUrl={logoUrl || null}
                brandColor={brandColor || null}
                className="rounded-[14px]"
              />
            </div>
            <div className="flex-1 space-y-3">
              <Field
                label="Logo"
                hint="Upload a PNG, JPEG, WEBP, GIF, or SVG logo image."
              >
                <div className="space-y-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    onChange={handleLogoFileChange}
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
                  />
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleClearLogo}
                        disabled={clearLogoMutation.isPending}
                      >
                        {clearLogoMutation.isPending ? "Removing..." : "Remove logo"}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <span className="text-xs text-destructive">
                      {logoUploadError ??
                        (logoUploadMutation.error instanceof Error
                          ? logoUploadMutation.error.message
                          : "Logo upload failed")}
                    </span>
                  )}
                  {clearLogoMutation.isError && (
                    <span className="text-xs text-destructive">
                      {clearLogoMutation.error.message}
                    </span>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-muted-foreground">Uploading logo...</span>
                  )}
                </div>
              </Field>
              <Field
                label="Brand color"
                hint="Sets the hue for the company icon. Leave empty for auto-generated color."
              >
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={brandColor || "#6366f1"}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <input
                    type="text"
                    value={brandColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                        setBrandColor(v);
                      }
                    }}
                    placeholder="Auto"
                    className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-muted-foreground"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </div>

      {/* Save button for General + Appearance */}
      {generalDirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveGeneral}
            disabled={generalMutation.isPending || !companyName.trim()}
          >
            {generalMutation.isPending ? "Saving..." : "Save changes"}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">Saved</span>
          )}
          {generalMutation.isError && (
            <span className="text-xs text-destructive">
              {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : "Failed to save"}
            </span>
          )}
        </div>
      )}

      {environmentsEnabled ? (
      <div className="space-y-4" data-testid="company-settings-environments-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Environments
        </div>
        <div className="space-y-4 rounded-md border border-border px-4 py-4">
          <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Environment choices use the same adapter support matrix as agent defaults. SSH is always available for
            remote-managed adapters, and sandbox environments appear only when a run-capable sandbox provider plugin is
            installed.
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-xs">
              <caption className="sr-only">Environment support by adapter</caption>
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Adapter</th>
                  <th className="px-3 py-2 font-medium">Local</th>
                  <th className="px-3 py-2 font-medium">SSH</th>
                  <th className="px-3 py-2 font-medium">K8s</th>
                  {sandboxSupportVisible ? (
                    <th className="px-3 py-2 font-medium">Sandbox</th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {(environmentCapabilities?.adapters.map((support) => ({
                  adapterType: support.adapterType,
                  support,
                })) ?? ENVIRONMENT_SUPPORT_ROWS).map(({ adapterType, support }) => (
                  <tr key={adapterType}>
                    <td className="py-2 pr-3 font-medium">
                      {adapterLabels[adapterType] ?? adapterType}
                    </td>
                    <td className="px-3 py-2">
                      <SupportMark supported={support.drivers.local === "supported"} />
                    </td>
                    <td className="px-3 py-2">
                      <SupportMark supported={support.drivers.ssh === "supported"} />
                    </td>
                    <td className="px-3 py-2">
                      <SupportMark supported={support.drivers.k8s === "supported"} />
                    </td>
                    {sandboxSupportVisible ? (
                      <td className="px-3 py-2">
                        <SupportMark
                          supported={discoveredPluginSandboxProviders.some((provider) =>
                            support.sandboxProviders[provider.provider] === "supported")}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-3">
            {(environments ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground">No environments saved for this company yet.</div>
            ) : (
              (environments ?? []).map((environment) => {
                const probe = probeResults[environment.id] ?? null;
                const isEditing = editingEnvironmentId === environment.id;
                return (
                  <div
                    key={environment.id}
                    className="rounded-md border border-border/70 px-3 py-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="text-sm font-medium">
                          {environment.name} <span className="text-muted-foreground">· {environment.driver}</span>
                        </div>
                        {environment.description ? (
                          <div className="text-xs text-muted-foreground">{environment.description}</div>
                        ) : null}
                        {environment.driver === "ssh" ? (
                          <div className="text-xs text-muted-foreground">
                            {typeof environment.config.host === "string" ? environment.config.host : "SSH host"} ·{" "}
                            {typeof environment.config.username === "string" ? environment.config.username : "user"}
                          </div>
                        ) : environment.driver === "sandbox" ? (
                          <div className="text-xs text-muted-foreground">
                            {(() => {
                              const provider =
                                typeof environment.config.provider === "string" ? environment.config.provider : "sandbox";
                              const displayName =
                                environmentCapabilities?.sandboxProviders?.[provider]?.displayName ?? provider;
                              const summary = summarizeSandboxConfig(environment.config as Record<string, unknown>);
                              return `${displayName} sandbox provider${summary ? ` · ${summary}` : ""}`;
                            })()}
                          </div>
                        ) : environment.driver === "k8s" ? (
                          <div className="text-xs text-muted-foreground">
                            {(() => {
                              const ns =
                                typeof environment.config.namespace === "string"
                                  ? (environment.config.namespace as string)
                                  : "(driver default namespace)";
                              const auth =
                                typeof environment.config.kubeconfigSecretRef === "string" &&
                                  (environment.config.kubeconfigSecretRef as string).length > 0
                                  ? `kubeconfig: ${environment.config.kubeconfigSecretRef as string}`
                                  : "in-cluster auth";
                              return `${ns} · ${auth}`;
                            })()}
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground">Runs on this Paperclip host.</div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {environment.driver !== "local" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => environmentProbeMutation.mutate(environment.id)}
                            disabled={environmentProbeMutation.isPending}
                          >
                            {environmentProbeMutation.isPending
                              ? "Testing..."
                              : environment.driver === "ssh"
                                ? "Test connection"
                                : environment.driver === "k8s"
                                  ? "Test cluster"
                                  : "Test provider"}
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleEditEnvironment(environment)}
                        >
                          {isEditing ? "Editing" : "Edit"}
                        </Button>
                      </div>
                    </div>
                    {probe ? (
                      <div
                        className={
                          probe.ok
                            ? "mt-3 rounded border border-green-500/30 bg-green-500/5 px-2.5 py-2 text-xs text-green-700"
                            : "mt-3 rounded border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
                        }
                      >
                        <div className="font-medium">{probe.summary}</div>
                        {probe.details?.error && typeof probe.details.error === "string" ? (
                          <div className="mt-1 font-mono text-[11px]">{probe.details.error}</div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          <div className="border-t border-border/60 pt-4">
            <div className="mb-3 text-sm font-medium">
              {editingEnvironmentId ? "Edit environment" : "Add environment"}
            </div>
            <div className="space-y-3">
              <Field label="Name" hint="Operator-facing name for this execution target.">
                <input
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  type="text"
                  value={environmentForm.name}
                  onChange={(e) => setEnvironmentForm((current) => ({ ...current, name: e.target.value }))}
                />
              </Field>
              <Field label="Description" hint="Optional note about what this machine is for.">
                <input
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  type="text"
                  value={environmentForm.description}
                  onChange={(e) => setEnvironmentForm((current) => ({ ...current, description: e.target.value }))}
                />
              </Field>
              <Field label="Driver" hint="Local runs on this host. SSH stores a remote machine target. Kubernetes runs adapter pods in a cluster. Sandbox stores plugin-backed provider config on the shared environment seam.">
                <select
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  value={environmentForm.driver}
                  onChange={(e) =>
                    setEnvironmentForm((current) => ({
                      ...current,
                      sandboxProvider:
                        e.target.value === "sandbox"
                          ? current.sandboxProvider.trim() || discoveredPluginSandboxProviders[0]?.provider || ""
                          : current.sandboxProvider,
                      sandboxConfig:
                        e.target.value === "sandbox"
                          ? (
                              current.sandboxProvider.trim().length > 0 && current.driver === "sandbox"
                                ? current.sandboxConfig
                                : discoveredPluginSandboxProviders[0]?.configSchema
                                  ? getDefaultValues(discoveredPluginSandboxProviders[0].configSchema as any)
                                  : {}
                            )
                          : current.sandboxConfig,
                      driver:
                        e.target.value === "local"
                          ? "local"
                          : e.target.value === "sandbox"
                            ? "sandbox"
                            : e.target.value === "k8s"
                              ? "k8s"
                              : "ssh",
                    }))}
                >
                  <option value="ssh">SSH</option>
                  <option value="k8s">Kubernetes</option>
                  {sandboxCreationEnabled || environmentForm.driver === "sandbox" ? (
                    <option value="sandbox">Sandbox</option>
                  ) : null}
                  <option value="local">Local</option>
                </select>
              </Field>

              {environmentForm.driver === "ssh" ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Host" hint="DNS name or IP address for the remote machine.">
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      value={environmentForm.sshHost}
                      onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshHost: e.target.value }))}
                    />
                  </Field>
                  <Field label="Port" hint="Defaults to 22.">
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="number"
                      min={1}
                      max={65535}
                      value={environmentForm.sshPort}
                      onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshPort: e.target.value }))}
                    />
                  </Field>
                  <Field label="Username" hint="SSH login user.">
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      value={environmentForm.sshUsername}
                      onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshUsername: e.target.value }))}
                    />
                  </Field>
                  <Field label="Remote workspace path" hint="Absolute path that Paperclip will verify during SSH connection tests.">
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      placeholder="/Users/paperclip/workspace"
                      value={environmentForm.sshRemoteWorkspacePath}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({ ...current, sshRemoteWorkspacePath: e.target.value }))}
                    />
                  </Field>
                  <Field label="Private key" hint="Optional PEM private key. Leave blank to rely on the server's SSH agent or default keychain.">
                    <div className="space-y-2">
                      <select
                        className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                        value={environmentForm.sshPrivateKeySecretId}
                        onChange={(e) =>
                          setEnvironmentForm((current) => ({
                            ...current,
                            sshPrivateKeySecretId: e.target.value,
                            sshPrivateKey: e.target.value ? "" : current.sshPrivateKey,
                          }))}
                      >
                        <option value="">No saved secret</option>
                        {(secrets ?? []).map((secret) => (
                          <option key={secret.id} value={secret.id}>{secret.name}</option>
                        ))}
                      </select>
                      <textarea
                        className="h-32 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none"
                        value={environmentForm.sshPrivateKey}
                        disabled={!!environmentForm.sshPrivateKeySecretId}
                        onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshPrivateKey: e.target.value }))}
                      />
                    </div>
                  </Field>
                  <Field label="Known hosts" hint="Optional known_hosts block used when strict host key checking is enabled.">
                    <textarea
                      className="h-32 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none"
                      value={environmentForm.sshKnownHosts}
                      onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshKnownHosts: e.target.value }))}
                    />
                  </Field>
                  <div className="md:col-span-2">
                    <ToggleField
                      label="Strict host key checking"
                      hint="Keep this on unless you deliberately want probe-time host key acceptance disabled."
                      checked={environmentForm.sshStrictHostKeyChecking}
                      onChange={(checked) =>
                        setEnvironmentForm((current) => ({ ...current, sshStrictHostKeyChecking: checked }))}
                    />
                  </div>
                </div>
              ) : null}

              {environmentForm.driver === "sandbox" ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Provider" hint="Installed run-capable sandbox provider plugins appear here.">
                    <select
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      value={environmentForm.sandboxProvider}
                      onChange={(e) => {
                        const nextProviderKey = e.target.value;
                        const nextProvider = pluginSandboxProviders.find((provider) => provider.provider === nextProviderKey) ?? null;
                        setEnvironmentForm((current) => ({
                          ...current,
                          sandboxProvider: nextProviderKey,
                          sandboxConfig:
                            current.sandboxProvider === nextProviderKey
                              ? current.sandboxConfig
                              : nextProvider?.configSchema
                                ? getDefaultValues(nextProvider.configSchema as any)
                                : {},
                        }));
                      }}
                    >
                      {pluginSandboxProviders.map((provider) => (
                        <option key={provider.provider} value={provider.provider}>
                          {provider.displayName}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="md:col-span-2 space-y-3">
                    {selectedSandboxProvider?.description ? (
                      <div className="text-xs text-muted-foreground">
                        {selectedSandboxProvider.description}
                      </div>
                    ) : null}
                    {selectedSandboxSchema ? (
                      <JsonSchemaForm
                        schema={selectedSandboxSchema as any}
                        values={environmentForm.sandboxConfig}
                        onChange={(values) =>
                          setEnvironmentForm((current) => ({ ...current, sandboxConfig: values }))}
                        errors={sandboxConfigErrors}
                      />
                    ) : (
                      <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        This provider does not declare additional configuration fields.
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              {environmentForm.driver === "k8s" ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <ToggleField
                      label="In-cluster auth"
                      hint="When enabled, Paperclip authenticates using its own pod's service account (the kubeconfig secret is ignored). Disable to point at an external cluster via a stored kubeconfig secret."
                      checked={environmentForm.k8sUseInClusterAuth}
                      onChange={(checked) =>
                        setEnvironmentForm((current) => ({
                          ...current,
                          k8sUseInClusterAuth: checked,
                        }))}
                    />
                  </div>
                  <Field
                    label="Kubeconfig secret"
                    hint="Name of a Paperclip secret holding a kubeconfig YAML. Required unless 'In-cluster auth' is on."
                  >
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none disabled:opacity-50"
                      type="text"
                      placeholder="kubeconfig-prod"
                      value={environmentForm.k8sKubeconfigSecretRef}
                      disabled={environmentForm.k8sUseInClusterAuth}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({
                          ...current,
                          k8sKubeconfigSecretRef: e.target.value,
                        }))}
                    />
                  </Field>
                  <Field label="Namespace" hint="Namespace where adapter pods are scheduled. Defaults to the driver's configured namespace.">
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      placeholder="paperclip"
                      value={environmentForm.k8sNamespace}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({ ...current, k8sNamespace: e.target.value }))}
                    />
                  </Field>
                  <Field label="Service account" hint="ServiceAccount the adapter pod runs as. Optional.">
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      placeholder="paperclip-runner"
                      value={environmentForm.k8sServiceAccountName}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({
                          ...current,
                          k8sServiceAccountName: e.target.value,
                        }))}
                    />
                  </Field>
                  <Field label="Image pull policy" hint="Pull policy for adapter container images.">
                    <select
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      value={environmentForm.k8sImagePullPolicy}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({
                          ...current,
                          k8sImagePullPolicy: e.target.value,
                        }))}
                    >
                      <option value="">(driver default)</option>
                      <option value="Always">Always</option>
                      <option value="IfNotPresent">IfNotPresent</option>
                      <option value="Never">Never</option>
                    </select>
                  </Field>
                  <Field label="Workspace volume claim" hint="Name of a PersistentVolumeClaim providing the workspace volume mounted into adapter pods.">
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      placeholder="paperclip-workspace"
                      value={environmentForm.k8sWorkspaceVolumeClaim}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({
                          ...current,
                          k8sWorkspaceVolumeClaim: e.target.value,
                        }))}
                    />
                  </Field>
                  <Field label="Workspace mount path" hint="Absolute path in the adapter pod where the workspace volume is mounted.">
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      placeholder="/workspace"
                      value={environmentForm.k8sWorkspaceMountPath}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({
                          ...current,
                          k8sWorkspaceMountPath: e.target.value,
                        }))}
                    />
                  </Field>
                  <Field label="Secrets namespace" hint="Namespace where Paperclip-managed Kubernetes Secrets live. Defaults to the same namespace as the adapter pod.">
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      placeholder="paperclip-secrets"
                      value={environmentForm.k8sSecretsNamespace}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({
                          ...current,
                          k8sSecretsNamespace: e.target.value,
                        }))}
                    />
                  </Field>
                  <Field label="Requests CPU" hint="Pod CPU request, e.g. 500m or 1.">
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      placeholder="500m"
                      value={environmentForm.k8sResourcesRequestsCpu}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({
                          ...current,
                          k8sResourcesRequestsCpu: e.target.value,
                        }))}
                    />
                  </Field>
                  <Field label="Requests memory" hint="Pod memory request, e.g. 1Gi.">
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      placeholder="1Gi"
                      value={environmentForm.k8sResourcesRequestsMemory}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({
                          ...current,
                          k8sResourcesRequestsMemory: e.target.value,
                        }))}
                    />
                  </Field>
                  <Field label="Limits CPU" hint="Pod CPU limit, e.g. 1.">
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      placeholder="1"
                      value={environmentForm.k8sResourcesLimitsCpu}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({
                          ...current,
                          k8sResourcesLimitsCpu: e.target.value,
                        }))}
                    />
                  </Field>
                  <Field label="Limits memory" hint="Pod memory limit, e.g. 2Gi.">
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      placeholder="2Gi"
                      value={environmentForm.k8sResourcesLimitsMemory}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({
                          ...current,
                          k8sResourcesLimitsMemory: e.target.value,
                        }))}
                    />
                  </Field>
                  <div className="md:col-span-2">
                    <Field label="Node selector" hint="One key=value pair per line. Pods are scheduled on nodes matching all entries.">
                      <textarea
                        className="h-24 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none"
                        placeholder="tier=runner&#10;zone=us-east-1a"
                        value={environmentForm.k8sNodeSelector}
                        onChange={(e) =>
                          setEnvironmentForm((current) => ({
                            ...current,
                            k8sNodeSelector: e.target.value,
                          }))}
                      />
                    </Field>
                  </div>
                  <div className="md:col-span-2">
                    <Field label="Labels" hint="One key=value pair per line. Applied as pod labels.">
                      <textarea
                        className="h-24 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none"
                        placeholder="app=paperclip&#10;team=core"
                        value={environmentForm.k8sLabels}
                        onChange={(e) =>
                          setEnvironmentForm((current) => ({ ...current, k8sLabels: e.target.value }))}
                      />
                    </Field>
                  </div>
                  <div className="md:col-span-2">
                    <Field label="Tolerations" hint="JSON array of Kubernetes toleration objects. Leave blank if not needed.">
                      <textarea
                        className="h-32 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none"
                        placeholder='[{"key":"dedicated","operator":"Equal","value":"paperclip","effect":"NoSchedule"}]'
                        value={environmentForm.k8sTolerations}
                        onChange={(e) =>
                          setEnvironmentForm((current) => ({
                            ...current,
                            k8sTolerations: e.target.value,
                          }))}
                      />
                      {parseTolerationsJson(environmentForm.k8sTolerations) === null ? (
                        <div className="mt-1 text-xs text-destructive">
                          Tolerations must be a JSON array.
                        </div>
                      ) : null}
                    </Field>
                  </div>
                  <div className="md:col-span-2">
                    <div className="mb-2 text-sm font-medium">Provider pools</div>
                    <div className="text-xs text-muted-foreground mb-3">
                      Constrain ccrotate to a subset of accounts at preRun. One email per line (or comma-separated). Leave blank to use the global pool.
                    </div>
                    {Object.keys(environmentForm.k8sProviderExtras).length > 0 ? (
                      <div className="mb-3 rounded-md border border-yellow-500/40 bg-yellow-500/5 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
                        Preserved {Object.keys(environmentForm.k8sProviderExtras).length} provider pool
                        {Object.keys(environmentForm.k8sProviderExtras).length === 1 ? "" : "s"} not editable here:{" "}
                        <span className="font-mono">{Object.keys(environmentForm.k8sProviderExtras).sort().join(", ")}</span>
                        . These keys are passed through unchanged on save.
                      </div>
                    ) : null}
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <Field label="Anthropic accounts" hint="Used by claude_k8s adapters. Passed as `ccrotate next --target claude --accounts <csv>`.">
                        <select
                          aria-label="Anthropic pool kind"
                          className="mb-2 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs outline-none"
                          value={environmentForm.k8sProviderAnthropicKind}
                          onChange={(e) =>
                            setEnvironmentForm((current) => ({
                              ...current,
                              k8sProviderAnthropicKind: e.target.value as "ccrotate",
                            }))}
                        >
                          <option value="ccrotate">ccrotate</option>
                        </select>
                        <textarea
                          className="h-24 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none"
                          placeholder={"omar.ramadan@blockcast.net\nbot1@blockcast.net"}
                          value={environmentForm.k8sProviderAnthropicAccounts}
                          onChange={(e) =>
                            setEnvironmentForm((current) => ({
                              ...current,
                              k8sProviderAnthropicAccounts: e.target.value,
                            }))}
                        />
                      </Field>
                      <Field label="OpenAI accounts" hint="Used by opencode_k8s adapters. Passed as `ccrotate next --target codex --accounts <csv>`.">
                        <select
                          aria-label="OpenAI pool kind"
                          className="mb-2 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs outline-none"
                          value={environmentForm.k8sProviderOpenaiKind}
                          onChange={(e) =>
                            setEnvironmentForm((current) => ({
                              ...current,
                              k8sProviderOpenaiKind: e.target.value as "ccrotate",
                            }))}
                        >
                          <option value="ccrotate">ccrotate</option>
                        </select>
                        <textarea
                          className="h-24 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none"
                          placeholder={"omar@blockcast.net\nprinceomz2004@gmail.com"}
                          value={environmentForm.k8sProviderOpenaiAccounts}
                          onChange={(e) =>
                            setEnvironmentForm((current) => ({
                              ...current,
                              k8sProviderOpenaiAccounts: e.target.value,
                            }))}
                        />
                      </Field>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => environmentMutation.mutate(environmentForm)}
                  disabled={environmentMutation.isPending || !environmentFormValid}
                >
                  {environmentMutation.isPending
                    ? editingEnvironmentId
                      ? "Saving..."
                      : "Creating..."
                    : editingEnvironmentId
                      ? "Save environment"
                      : "Create environment"}
                </Button>
                {editingEnvironmentId ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleCancelEnvironmentEdit}
                    disabled={environmentMutation.isPending}
                  >
                    Cancel
                  </Button>
                ) : null}
                {environmentForm.driver !== "local" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => draftEnvironmentProbeMutation.mutate(environmentForm)}
                    disabled={draftEnvironmentProbeMutation.isPending || !environmentFormValid}
                  >
                    {draftEnvironmentProbeMutation.isPending ? "Testing..." : "Test draft"}
                  </Button>
                ) : null}
                {environmentMutation.isError ? (
                  <span className="text-xs text-destructive">
                    {environmentMutation.error instanceof Error
                      ? environmentMutation.error.message
                      : "Failed to save environment"}
                  </span>
                ) : null}
                {draftEnvironmentProbeMutation.data ? (
                  <span className={draftEnvironmentProbeMutation.data.ok ? "text-xs text-green-600" : "text-xs text-destructive"}>
                    {draftEnvironmentProbeMutation.data.summary}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
      ) : null}


      {/* Hiring */}
      <div className="space-y-4" data-testid="company-settings-team-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Hiring
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label="Require board approval for new hires"
            hint="New agent hires stay pending until approved by board."
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
            toggleTestId="company-settings-team-approval-toggle"
          />
        </div>
      </div>

      {/* Import / Export */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Company Packages
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Import and export have moved to dedicated pages accessible from the{" "}
            <a href="/org" className="underline hover:text-foreground">Org Chart</a> header.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {cloudSyncEnabled ? (
              <Button size="sm" asChild>
                <a href="/company/settings/cloud-upstream">
                  <CloudUpload className="mr-1.5 h-3.5 w-3.5" />
                  Send to Paperclip Cloud
                </a>
              </Button>
            ) : null}
            <Button size="sm" variant="outline" asChild>
              <a href="/company/export">
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Export
              </a>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href="/company/import">
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Import
              </a>
            </Button>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-destructive uppercase tracking-wide">
          Danger Zone
        </div>
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Archive this company to hide it from the sidebar. This persists in
            the database.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={
                archiveMutation.isPending ||
                selectedCompany.status === "archived"
              }
              onClick={() => {
                if (!selectedCompanyId) return;
                const confirmed = window.confirm(
                  `Archive company "${selectedCompany.name}"? It will be hidden from the sidebar.`
                );
                if (!confirmed) return;
                const nextCompanyId =
                  companies.find(
                    (company) =>
                      company.id !== selectedCompanyId &&
                      company.status !== "archived"
                  )?.id ?? null;
                archiveMutation.mutate({
                  companyId: selectedCompanyId,
                  nextCompanyId
                });
              }}
            >
              {archiveMutation.isPending
                ? "Archiving..."
                : selectedCompany.status === "archived"
                ? "Already archived"
                : "Archive company"}
            </Button>
            {archiveMutation.isError && (
              <span className="text-xs text-destructive">
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : "Failed to archive company"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
