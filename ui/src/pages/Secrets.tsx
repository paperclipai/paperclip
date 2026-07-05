import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  ArchiveRestore,
  Archive,
  Ban,
  CheckCircle2,
  Cloud,
  Copy,
  Database,
  Edit3,
  ExternalLink,
  KeyRound,
  Link2,
  Lock,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  X,
  Filter,
  Info,
  Pencil,
  UserRound,
  Users,
} from "lucide-react";
import { Link } from "react-router-dom";
import type {
  CompanySecret,
  CompanySecretUsageBinding,
  CompanySecretProviderConfig,
  SecretProviderConfigDiscoveryCandidate,
  SecretProviderConfigDiscoveryPreviewResult,
  SecretAccessEvent,
  SecretManagedMode,
  SecretProvider,
  SecretProviderConfigStatus,
  SecretProviderDescriptor,
  SecretStatus,
  UserSecretCoverageSummary,
  UserSecretDefinition,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import {
  secretsApi,
  type CreateSecretInput,
  type CreateSecretProviderConfigInput,
  type SecretProviderHealthResponse,
  type UpdateSecretProviderConfigInput,
} from "../api/secrets";
import { ApiError } from "../api/client";
import { accessApi, type CompanyUserDirectoryEntry } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "../lib/utils";
import { copyTextToClipboard } from "../lib/clipboard";
import { PageTabBar } from "../components/PageTabBar";
import { ImportFromVaultDialog } from "./secrets/ImportFromVaultDialog";
import { MyUserSecretsTab } from "./secrets/MyUserSecretsTab";
import { SetMyUserSecretDialog } from "./secrets/SetMyUserSecretDialog";
import {
  coverageSummaryLabel,
  UserSecretChip,
} from "./secrets/user-secret-presentation";
import type { MyUserSecretEntry } from "../api/secrets";

type CreateMode = "managed" | "external";
type SecretValueProvider = "company" | "user";
type ProvidedByFilter = "all" | SecretValueProvider;
type SecretsTab = "secrets" | "my-secrets" | "vaults";

type UnifiedSecretRow =
  | { id: string; kind: "company"; secret: CompanySecret }
  | { id: string; kind: "user"; definition: UserSecretDefinition };

type ProviderVaultForm = {
  provider: SecretProvider;
  displayName: string;
  status: SecretProviderConfigStatus;
  isDefault: boolean;
  backupReminderAcknowledged: boolean;
  region: string;
  namespace: string;
  secretNamePrefix: string;
  kmsKeyId: string;
  ownerTag: string;
  environmentTag: string;
  projectId: string;
  location: string;
  address: string;
  mountPath: string;
  secretPathPrefix: string;
};

type SafeProviderErrorDetails = {
  code?: string;
  provider?: string;
  operation?: string;
  providerConfigId?: string;
  providerVaultContext?: string;
  region?: string;
  credentialPath?: string;
  requiredCapability?: string;
  actionableMessage?: string;
  safeAlternative?: string;
};

const EMPTY_SECRETS: CompanySecret[] = [];
const EMPTY_USER_SECRET_DEFINITIONS: UserSecretDefinition[] = [];
const EMPTY_MY_USER_SECRETS: MyUserSecretEntry[] = [];
const EMPTY_SECRET_PROVIDERS: SecretProviderDescriptor[] = [];
const EMPTY_PROVIDER_CONFIGS: CompanySecretProviderConfig[] = [];

const PROVIDER_ORDER: SecretProvider[] = [
  "local_encrypted",
  "aws_secrets_manager",
  "gcp_secret_manager",
  "vault",
];

function defaultProviderVaultStatus(provider: SecretProvider): SecretProviderConfigStatus {
  return provider === "gcp_secret_manager" || provider === "vault" ? "coming_soon" : "ready";
}

function emptyProviderVaultForm(provider: SecretProvider = "local_encrypted"): ProviderVaultForm {
  return {
    provider,
    displayName: "",
    status: defaultProviderVaultStatus(provider),
    isDefault: false,
    backupReminderAcknowledged: false,
    region: "",
    namespace: "",
    secretNamePrefix: "",
    kmsKeyId: "",
    ownerTag: "",
    environmentTag: "",
    projectId: "",
    location: "",
    address: "",
    mountPath: "",
    secretPathPrefix: "",
  };
}

function providerConfigValue(config: CompanySecretProviderConfig["config"], key: string) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function apiErrorDetails(error: unknown): SafeProviderErrorDetails | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body;
  if (!body || typeof body !== "object") return null;
  const details = (body as Record<string, unknown>).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  return details as SafeProviderErrorDetails;
}

function apiErrorCode(error: unknown): string | null {
  return apiErrorDetails(error)?.code ?? null;
}

function isAwsDiscoveryAccessDenied(error: unknown): boolean {
  const details = apiErrorDetails(error);
  if (details?.provider === "aws_secrets_manager" && details.operation === "secret_provider_config.discovery.preview") {
    return details.code === "access_denied";
  }
  if (!(error instanceof ApiError)) return false;
  return apiErrorCode(error) === "access_denied";
}

function readableErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

function providerVaultFormFromConfig(config: CompanySecretProviderConfig): ProviderVaultForm {
  return {
    ...emptyProviderVaultForm(config.provider),
    displayName: config.displayName,
    status: config.status,
    isDefault: config.isDefault,
    backupReminderAcknowledged:
      Boolean((config.config as Record<string, unknown> | undefined)?.backupReminderAcknowledged),
    region: providerConfigValue(config.config, "region"),
    namespace: providerConfigValue(config.config, "namespace"),
    secretNamePrefix: providerConfigValue(config.config, "secretNamePrefix"),
    kmsKeyId: providerConfigValue(config.config, "kmsKeyId"),
    ownerTag: providerConfigValue(config.config, "ownerTag"),
    environmentTag: providerConfigValue(config.config, "environmentTag"),
    projectId: providerConfigValue(config.config, "projectId"),
    location: providerConfigValue(config.config, "location"),
    address: providerConfigValue(config.config, "address"),
    mountPath: providerConfigValue(config.config, "mountPath"),
    secretPathPrefix: providerConfigValue(config.config, "secretPathPrefix"),
  };
}

function formatRelative(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  if (diff < 0) return date.toLocaleString();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function statusTextTone(status: SecretStatus) {
  switch (status) {
    case "active":
      return "text-emerald-700 dark:text-emerald-300";
    case "disabled":
      return "text-amber-700 dark:text-amber-300";
    case "archived":
      return "text-muted-foreground";
    case "deleted":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

function providerLabel(providers: SecretProviderDescriptor[] | undefined, id: SecretProvider) {
  return providers?.find((p) => p.id === id)?.label ?? id.replaceAll("_", " ");
}

function normalizeSecretKeyForPreview(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeUserSecretKeyForPreview(input: string) {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}


function modeLabel(managedMode: SecretManagedMode) {
  return managedMode === "paperclip_managed" ? "Paperclip-managed" : "Linked external";
}

function modeDescription(managedMode: SecretManagedMode) {
  return managedMode === "paperclip_managed"
    ? "Paperclip owns create and rotation writes for this provider secret."
    : "Paperclip resolves this provider reference but does not rotate the provider value.";
}

function statusLabel(status: SecretStatus) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusDotTone(status: SecretStatus) {
  switch (status) {
    case "active":
      return "bg-emerald-500";
    case "disabled":
      return "bg-amber-500";
    case "archived":
      return "bg-muted-foreground";
    case "deleted":
      return "bg-destructive";
    default:
      return "bg-muted-foreground";
  }
}

function StatusBadge({ status }: { status: SecretStatus }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", statusTextTone(status))}>
      <span className={cn("h-1.5 w-1.5 rounded-full", statusDotTone(status))} aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

function providerIndicatorLabel(
  secret: CompanySecret,
  providers: SecretProviderDescriptor[],
  providerConfigs: CompanySecretProviderConfig[],
) {
  const provider = providerLabel(providers, secret.provider);
  const vault = providerVaultLabel(providerConfigs, secret.providerConfigId);
  const custody = modeLabel(secret.managedMode);
  return [
    `${custody} · ${provider}`,
    vault ? `Vault: ${vault}` : null,
    secret.externalRef ? `Reference: ${secret.externalRef}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function SecretProviderIndicator({
  secret,
  providers,
  providerConfigs,
}: {
  secret: CompanySecret;
  providers: SecretProviderDescriptor[];
  providerConfigs: CompanySecretProviderConfig[];
}) {
  const label = providerIndicatorLabel(secret, providers, providerConfigs);
  const Icon = secret.managedMode === "external_reference" ? ExternalLink : Lock;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={label}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground"
        >
          <Icon className="h-3 w-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 whitespace-pre-wrap break-words">{label}</TooltipContent>
    </Tooltip>
  );
}

function UpdatedWithTooltip({
  updatedAt,
  tooltip,
}: {
  updatedAt: Date | string | null | undefined;
  tooltip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={tooltip}
          className="inline-flex cursor-help border-b border-dotted border-muted-foreground/60 text-xs text-muted-foreground"
        >
          {formatRelative(updatedAt)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 whitespace-pre-wrap">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function healthEntryForProvider(
  health: SecretProviderHealthResponse | null,
  providerId: SecretProvider,
) {
  return health?.providers.find((entry) => entry.provider === providerId) ?? null;
}

export function getCreateProviderBlockReason(
  provider: SecretProviderDescriptor | null | undefined,
  mode: CreateMode,
  health: SecretProviderHealthResponse | null,
  providerConfig?: CompanySecretProviderConfig | null,
) {
  if (!provider) return "Select a provider.";
  if (mode === "managed" && provider.supportsManagedValues === false) {
    return `${provider.label} does not support Paperclip-managed secret values.`;
  }
  if (mode === "external" && provider.supportsExternalReferences === false) {
    return `${provider.label} does not support linked external references.`;
  }
  const selectedProviderConfigBlockReason = providerConfig?.provider === provider.id
    ? getProviderConfigBlockReason(providerConfig)
    : null;
  const selectedProviderConfigReady =
    providerConfig?.provider === provider.id && !selectedProviderConfigBlockReason;
  if (provider.configured === false) {
    if (selectedProviderConfigReady) return null;
    if (selectedProviderConfigBlockReason) return selectedProviderConfigBlockReason;
    const healthEntry = healthEntryForProvider(health, provider.id);
    const deploymentMessage = `Deployment default ${provider.label} is not configured.`;
    const nextStep = " Select a ready provider vault or configure the deployment default.";
    return healthEntry?.message
      ? `${deploymentMessage}${nextStep} ${healthEntry.message}`
      : `${deploymentMessage}${nextStep}`;
  }
  const healthEntry = healthEntryForProvider(health, provider.id);
  if (healthEntry?.status === "error") {
    return `${provider.label} health check failed: ${healthEntry.message}`;
  }
  return null;
}

function providerHealthText(
  provider: SecretProviderDescriptor | null | undefined,
  health: SecretProviderHealthResponse | null,
  providerConfig?: CompanySecretProviderConfig | null,
) {
  if (!provider) return null;
  if (
    provider.configured === false &&
    providerConfig?.provider === provider.id &&
    !getProviderConfigBlockReason(providerConfig)
  ) {
    return `Using selected provider vault. Deployment default ${provider.label} is not configured.`;
  }
  const entry = healthEntryForProvider(health, provider.id);
  if (!entry) return null;
  const warnings = entry.warnings?.join(" ");
  return [entry.message, warnings].filter(Boolean).join(" ");
}

function detailString(details: Record<string, unknown> | undefined, key: string) {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getProviderConfigBlockReason(
  config: CompanySecretProviderConfig | null | undefined,
) {
  if (!config) return null;
  if (config.status === "disabled") return "This provider vault is disabled.";
  if (config.status === "coming_soon") return "This provider vault is saved as draft metadata only.";
  if (config.healthStatus === "error") {
    return config.healthMessage ?? "This provider vault health check failed.";
  }
  return null;
}

export function getSelectableProviderConfig(
  configs: CompanySecretProviderConfig[],
  provider: SecretProvider,
) {
  const providerConfigs = configs.filter((config) => config.provider === provider);
  return (
    providerConfigs.find((config) => config.isDefault && !getProviderConfigBlockReason(config)) ??
    providerConfigs.find((config) => !getProviderConfigBlockReason(config)) ??
    null
  );
}

export function getDefaultProviderConfigId(
  configs: CompanySecretProviderConfig[],
  provider: SecretProvider,
) {
  const selected = getSelectableProviderConfig(configs, provider);
  const providerConfigs = configs.filter((config) => config.provider === provider);
  return (
    selected?.id ??
    providerConfigs.find((config) => config.isDefault)?.id ??
    ""
  );
}

export function findCreateProviderReplacement({
  providers,
  providerConfigs,
  currentProvider,
  mode,
  health,
}: {
  providers: SecretProviderDescriptor[];
  providerConfigs: CompanySecretProviderConfig[];
  currentProvider: SecretProvider;
  mode: CreateMode;
  health: SecretProviderHealthResponse | null;
}) {
  return (
    providers.find((provider) => {
      const selectedConfig =
        provider.id === currentProvider
          ? providerConfigs.find(
              (config) => config.provider === provider.id && !getProviderConfigBlockReason(config),
            ) ?? null
          : getSelectableProviderConfig(providerConfigs, provider.id);
      return !getCreateProviderBlockReason(provider, mode, health, selectedConfig);
    }) ?? null
  );
}

function providerVaultLabel(configs: CompanySecretProviderConfig[], id: string | null | undefined) {
  if (!id) return "Deployment default";
  return configs.find((config) => config.id === id)?.displayName ?? "Unknown vault";
}

function buildProviderVaultConfig(form: ProviderVaultForm): Record<string, unknown> {
  const compact = (value: string) => value.trim() || null;
  switch (form.provider) {
    case "local_encrypted":
      return { backupReminderAcknowledged: form.backupReminderAcknowledged };
    case "aws_secrets_manager":
      return {
        region: form.region.trim(),
        namespace: compact(form.namespace),
        secretNamePrefix: compact(form.secretNamePrefix),
        kmsKeyId: compact(form.kmsKeyId),
        ownerTag: compact(form.ownerTag),
        environmentTag: compact(form.environmentTag),
      };
    case "gcp_secret_manager":
      return {
        projectId: compact(form.projectId),
        location: compact(form.location),
        namespace: compact(form.namespace),
        secretNamePrefix: compact(form.secretNamePrefix),
      };
    case "vault":
      return {
        address: compact(form.address),
        namespace: compact(form.namespace),
        mountPath: compact(form.mountPath),
        secretPathPrefix: compact(form.secretPathPrefix),
      };
    default:
      return {};
  }
}

function getAwsProviderVaultDiscoveryQuery(form: ProviderVaultForm): string | null {
  return (
    form.secretNamePrefix.trim() ||
    form.namespace.trim() ||
    form.environmentTag.trim() ||
    form.ownerTag.trim() ||
    null
  );
}

export function getAwsManagedPathPreview(input: {
  provider: SecretProviderDescriptor | null | undefined;
  health: SecretProviderHealthResponse | null;
  companyId: string;
  secretKeySource: string;
}) {
  if (input.provider?.id !== "aws_secrets_manager") return null;
  const healthEntry = healthEntryForProvider(input.health, "aws_secrets_manager");
  const prefix = detailString(healthEntry?.details, "prefix") ?? "paperclip";
  const deploymentId = detailString(healthEntry?.details, "deploymentId") ?? "{deploymentId}";
  const secretKey = normalizeSecretKeyForPreview(input.secretKeySource) || "{secretKey}";
  return `${prefix}/${deploymentId}/${input.companyId}/${secretKey}`;
}

export function Secrets() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const [activeTab, setActiveTab] = useState<SecretsTab>("secrets");
  const [secretDetailTab, setSecretDetailTab] = useState("details");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SecretStatus | "all">("active");
  const [providerFilter, setProviderFilter] = useState<SecretProvider | "all">("all");
  const [providedByFilter, setProvidedByFilter] = useState<ProvidedByFilter>("all");
  const [selectedSecretId, setSelectedSecretId] = useState<string | null>(null);
  const [selectedDefinitionId, setSelectedDefinitionId] = useState<string | null>(null);
  const [usageDialogSecretId, setUsageDialogSecretId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importInitialVaultId, setImportInitialVaultId] = useState<string | null>(null);
  const [secretValueProvider, setSecretValueProvider] = useState<SecretValueProvider>("company");
  const [createMode, setCreateMode] = useState<CreateMode>("managed");
  const [editingDefinition, setEditingDefinition] = useState<UserSecretDefinition | null>(null);
  const [createKeyDirty, setCreateKeyDirty] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    key: "",
    value: "",
    description: "",
    usageGuidance: "",
    externalRef: "",
    provider: "local_encrypted" as SecretProvider,
    providerConfigId: "",
  });
  const [createError, setCreateError] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateValue, setRotateValue] = useState("");
  const [rotateExternalRef, setRotateExternalRef] = useState("");
  const [rotateProviderConfigId, setRotateProviderConfigId] = useState("");
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<CompanySecret | null>(null);
  const [definitionDeleteConfirm, setDefinitionDeleteConfirm] = useState<UserSecretDefinition | null>(null);
  const [setMyValueFor, setSetMyValueFor] = useState<MyUserSecretEntry | null>(null);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const [editingVault, setEditingVault] = useState<CompanySecretProviderConfig | null>(null);
  const [removeVaultConfirm, setRemoveVaultConfirm] = useState<CompanySecretProviderConfig | null>(null);
  const [vaultForm, setVaultForm] = useState<ProviderVaultForm>(() => emptyProviderVaultForm());
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [vaultDiscovery, setVaultDiscovery] =
    useState<SecretProviderConfigDiscoveryPreviewResult | null>(null);
  const [vaultDiscoveryError, setVaultDiscoveryError] = useState<unknown | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Secrets" }]);
  }, [setBreadcrumbs]);

  const secretsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.list(selectedCompanyId)
      : ["secrets", "__disabled__"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const userDefinitionsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.userDefinitions(selectedCompanyId)
      : ["user-secret-definitions", "__disabled__"],
    queryFn: () => secretsApi.listUserSecretDefinitions(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const myUserSecretsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.myUserSecrets(selectedCompanyId)
      : ["my-user-secrets", "__disabled__"],
    queryFn: () => secretsApi.listMyUserSecrets(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const providersQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.providers(selectedCompanyId)
      : ["secret-providers", "__disabled__"],
    queryFn: () => secretsApi.providers(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    staleTime: 5 * 60_000,
  });

  const providerHealthQuery = useQuery({
    queryKey: selectedCompanyId
      ? ["secret-provider-health", selectedCompanyId]
      : ["secret-provider-health", "__disabled__"],
    queryFn: () => secretsApi.providerHealth(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 60_000,
    retry: false,
  });

  const providerConfigsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.providerConfigs(selectedCompanyId)
      : ["secret-provider-configs", "__disabled__"],
    queryFn: () => secretsApi.providerConfigs(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });

  const secrets = secretsQuery.data ?? EMPTY_SECRETS;
  const userDefinitions = userDefinitionsQuery.data ?? EMPTY_USER_SECRET_DEFINITIONS;
  const myUserSecrets = myUserSecretsQuery.data ?? EMPTY_MY_USER_SECRETS;
  const providers = providersQuery.data ?? EMPTY_SECRET_PROVIDERS;
  const providerConfigs = providerConfigsQuery.data ?? EMPTY_PROVIDER_CONFIGS;
  const selectedSecret = useMemo(
    () => secrets.find((secret) => secret.id === selectedSecretId) ?? null,
    [secrets, selectedSecretId],
  );
  const selectedDefinition = useMemo(
    () => userDefinitions.find((definition) => definition.id === selectedDefinitionId) ?? null,
    [selectedDefinitionId, userDefinitions],
  );
  const selectedDefinitionMyEntry = useMemo(() => {
    if (!selectedDefinition) return null;
    return myUserSecrets.find((entry) => entry.definition.id === selectedDefinition.id) ?? {
      definition: selectedDefinition,
      secret: null,
    };
  }, [myUserSecrets, selectedDefinition]);
  const usageDialogSecret = useMemo(
    () => secrets.find((secret) => secret.id === usageDialogSecretId) ?? null,
    [secrets, usageDialogSecretId],
  );
  const selectedCreateProvider = useMemo(
    () => providers.find((provider) => provider.id === createForm.provider) ?? null,
    [providers, createForm.provider],
  );
  const createProviderConfigs = useMemo(
    () => providerConfigs.filter((config) => config.provider === createForm.provider),
    [createForm.provider, providerConfigs],
  );
  const selectedCreateProviderConfig = useMemo(
    () => providerConfigs.find((config) => config.id === createForm.providerConfigId) ?? null,
    [createForm.providerConfigId, providerConfigs],
  );
  const selectedRotateProviderConfigs = useMemo(
    () => providerConfigs.filter((config) => config.provider === selectedSecret?.provider),
    [providerConfigs, selectedSecret?.provider],
  );
  const selectedRotateProviderConfig = useMemo(
    () => providerConfigs.find((config) => config.id === rotateProviderConfigId) ?? null,
    [providerConfigs, rotateProviderConfigId],
  );
  const createProviderBlockReason = getCreateProviderBlockReason(
    selectedCreateProvider,
    createMode,
    providerHealthQuery.data ?? null,
    selectedCreateProviderConfig,
  ) ?? getProviderConfigBlockReason(selectedCreateProviderConfig);
  const rotateProviderBlockReason = getProviderConfigBlockReason(selectedRotateProviderConfig);
  const createProviderHealthText = providerHealthText(
    selectedCreateProvider,
    providerHealthQuery.data ?? null,
    selectedCreateProviderConfig,
  );
  const awsManagedPathPreview = getAwsManagedPathPreview({
    provider: selectedCreateProvider,
    health: providerHealthQuery.data ?? null,
    companyId: selectedCompanyId ?? "{companyId}",
    secretKeySource: createForm.key.trim() || createForm.name,
  });

  const unifiedRows = useMemo<UnifiedSecretRow[]>(
    () => [
      ...secrets.map((secret) => ({ id: `company:${secret.id}`, kind: "company" as const, secret })),
      ...userDefinitions.map((definition) => ({
        id: `user:${definition.id}`,
        kind: "user" as const,
        definition,
      })),
    ],
    [secrets, userDefinitions],
  );

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return unifiedRows.filter((row) => {
      const providedBy: SecretValueProvider = row.kind === "company" ? "company" : "user";
      const status = row.kind === "company" ? row.secret.status : row.definition.status;
      if (providedByFilter !== "all" && providedBy !== providedByFilter) return false;
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (providerFilter !== "all" && row.kind === "company" && row.secret.provider !== providerFilter) {
        return false;
      }
      if (!needle) return true;
      if (row.kind === "company") {
        return (
          row.secret.name.toLowerCase().includes(needle) ||
          row.secret.key.toLowerCase().includes(needle) ||
          (row.secret.description?.toLowerCase().includes(needle) ?? false) ||
          (row.secret.externalRef?.toLowerCase().includes(needle) ?? false)
        );
      }
      return (
        row.definition.name.toLowerCase().includes(needle) ||
        row.definition.key.toLowerCase().includes(needle) ||
        (row.definition.description?.toLowerCase().includes(needle) ?? false) ||
        (row.definition.usageGuidance?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [providedByFilter, providerFilter, search, statusFilter, unifiedRows]);
  const activeSecretFilterCount =
    (statusFilter === "active" ? 0 : 1) +
    (providerFilter === "all" ? 0 : 1) +
    (providedByFilter === "all" ? 0 : 1);

  const usageQuery = useQuery({
    queryKey: selectedSecret ? queryKeys.secrets.usage(selectedSecret.id) : ["secrets", "usage", "__disabled__"],
    queryFn: () => secretsApi.usage(selectedSecret!.id),
    enabled: Boolean(selectedSecret),
  });
  const eventsQuery = useQuery({
    queryKey: selectedSecret
      ? queryKeys.secrets.accessEvents(selectedSecret.id)
      : ["secrets", "access-events", "__disabled__"],
    queryFn: () => secretsApi.accessEvents(selectedSecret!.id),
    enabled: Boolean(selectedSecret),
  });

  const usageDialogQuery = useQuery({
    queryKey: usageDialogSecret
      ? queryKeys.secrets.usage(usageDialogSecret.id)
      : ["secrets", "usage-dialog", "__disabled__"],
    queryFn: () => secretsApi.usage(usageDialogSecret!.id),
    enabled: Boolean(usageDialogSecret),
  });

  function invalidateAll(extraIds: string[] = []) {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.secrets.userDefinitions(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.secrets.myUserSecrets(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.secrets.providerConfigs(selectedCompanyId) });
    for (const id of extraIds) {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.usage(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.accessEvents(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.userDefinitionCoverage(selectedCompanyId, id) });
    }
  }

  function openCreateSecret() {
    setEditingDefinition(null);
    setSecretValueProvider("company");
    setCreateMode("managed");
    setCreateKeyDirty(false);
    setCreateError(null);
    setCreateForm({
      name: "",
      key: "",
      value: "",
      description: "",
      usageGuidance: "",
      externalRef: "",
      provider: "local_encrypted",
      providerConfigId: getDefaultProviderConfigId(providerConfigs, "local_encrypted"),
    });
    setCreateOpen(true);
  }

  function openEditDefinition(definition: UserSecretDefinition) {
    setEditingDefinition(definition);
    setSecretValueProvider("user");
    setCreateMode("managed");
    setCreateKeyDirty(true);
    setCreateError(null);
    setCreateForm({
      name: definition.name,
      key: definition.key,
      value: "",
      description: definition.description ?? "",
      usageGuidance: definition.usageGuidance ?? "",
      externalRef: "",
      provider: "local_encrypted",
      providerConfigId: "",
    });
    setCreateOpen(true);
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      const sharedDefinitionPayload = {
        name: createForm.name.trim(),
        description: createForm.description.trim() || null,
        usageGuidance: createForm.usageGuidance.trim() || null,
      };
      if (editingDefinition) {
        const definition = await secretsApi.updateUserSecretDefinition(
          selectedCompanyId!,
          editingDefinition.id,
          sharedDefinitionPayload,
        );
        return { kind: "user" as const, item: definition, action: "updated" as const };
      }
      if (secretValueProvider === "user") {
        const definition = await secretsApi.createUserSecretDefinition(selectedCompanyId!, {
          ...sharedDefinitionPayload,
          key: createForm.key.trim(),
          status: "active",
        });
        return { kind: "user" as const, item: definition, action: "created" as const };
      }

      const input: CreateSecretInput = {
        name: createForm.name.trim(),
        provider: createForm.provider,
        providerConfigId: createForm.providerConfigId || null,
        managedMode: createMode === "external" ? "external_reference" : "paperclip_managed",
        description: createForm.description.trim() || null,
      };
      if (createForm.key.trim()) input.key = createForm.key.trim();
      if (createMode === "managed") {
        input.value = createForm.value;
      } else {
        input.externalRef = createForm.externalRef.trim();
      }
      const secret = await secretsApi.create(selectedCompanyId!, input);
      return { kind: "company" as const, item: secret, action: "created" as const };
    },
    onSuccess: (result) => {
      pushToast({
        title:
          result.kind === "company"
            ? "Secret created"
            : result.action === "updated"
              ? "User-provided secret updated"
              : "User-provided secret created",
        body: result.item.name,
        tone: "success",
      });
      setCreateOpen(false);
      setEditingDefinition(null);
      setSecretValueProvider("company");
      setCreateKeyDirty(false);
      setCreateForm({
        name: "",
        key: "",
        value: "",
        description: "",
        usageGuidance: "",
        externalRef: "",
        provider: createForm.provider,
        providerConfigId: getDefaultProviderConfigId(providerConfigs, createForm.provider),
      });
      setCreateError(null);
      if (result.kind === "company") {
        setSelectedSecretId(result.item.id);
        setSelectedDefinitionId(null);
        invalidateAll([result.item.id]);
      } else {
        setSelectedDefinitionId(result.item.id);
        setSelectedSecretId(null);
        invalidateAll([result.item.id]);
      }
    },
    onError: (error) => {
      setCreateError(error instanceof ApiError ? error.message : (error as Error).message);
    },
  });

  const rotateMutation = useMutation({
    mutationFn: () => {
      if (!selectedSecret) throw new Error("Select a secret first");
      if (selectedSecret.managedMode === "external_reference") {
        return secretsApi.rotate(selectedSecret.id, {
          externalRef: rotateExternalRef.trim() || selectedSecret.externalRef || undefined,
          providerConfigId: rotateProviderConfigId || null,
        });
      }
      return secretsApi.rotate(selectedSecret.id, {
        value: rotateValue,
        providerConfigId: rotateProviderConfigId || null,
      });
    },
    onSuccess: (updated) => {
      pushToast({ title: "Rotated", body: `${updated.name} → v${updated.latestVersion}`, tone: "success" });
      setRotateOpen(false);
      setRotateValue("");
      setRotateExternalRef("");
      setRotateProviderConfigId("");
      setRotateError(null);
      invalidateAll([updated.id]);
    },
    onError: (error) => {
      setRotateError(error instanceof Error ? error.message : "Rotate failed");
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: SecretStatus }) => {
      switch (status) {
        case "active":
          return secretsApi.enable(id);
        case "disabled":
          return secretsApi.disable(id);
        case "archived":
          return secretsApi.archive(id);
        default:
          return secretsApi.update(id, { status });
      }
    },
    onSuccess: (updated) => {
      pushToast({ title: `Secret ${updated.status}`, body: updated.name, tone: "info" });
      invalidateAll([updated.id]);
    },
    onError: (error) => {
      pushToast({
        title: "Status update failed",
        body: error instanceof Error ? error.message : "Try again",
        tone: "error",
      });
    },
  });

  const definitionStatusMutation = useMutation({
    mutationFn: ({ definition, status }: { definition: UserSecretDefinition; status: SecretStatus }) =>
      secretsApi.updateUserSecretDefinition(selectedCompanyId!, definition.id, { status }),
    onSuccess: (updated) => {
      pushToast({ title: `User-provided secret ${updated.status}`, body: updated.name, tone: "info" });
      invalidateAll([updated.id]);
    },
    onError: (error) => {
      pushToast({
        title: "Status update failed",
        body: error instanceof Error ? error.message : "Try again",
        tone: "error",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => secretsApi.remove(id),
    onSuccess: (_response, id) => {
      pushToast({ title: "Secret deleted", tone: "info" });
      setDeleteConfirm(null);
      if (selectedSecretId === id) setSelectedSecretId(null);
      invalidateAll([id]);
    },
    onError: (error) => {
      pushToast({
        title: "Delete failed",
        body: error instanceof Error ? error.message : "Try again",
        tone: "error",
      });
    },
  });

  const deleteDefinitionMutation = useMutation({
    mutationFn: (definition: UserSecretDefinition) =>
      secretsApi.removeUserSecretDefinition(selectedCompanyId!, definition.id),
    onSuccess: (_response, definition) => {
      pushToast({ title: "User-provided secret removed", body: definition.name, tone: "info" });
      setDefinitionDeleteConfirm(null);
      if (selectedDefinitionId === definition.id) setSelectedDefinitionId(null);
      invalidateAll([definition.id]);
    },
    onError: (error) => {
      pushToast({
        title: "Delete failed",
        body: error instanceof Error ? error.message : "Try again",
        tone: "error",
      });
    },
  });

  const saveVaultMutation = useMutation({
    mutationFn: () => {
      const data: CreateSecretProviderConfigInput | UpdateSecretProviderConfigInput = {
        displayName: vaultForm.displayName.trim(),
        status: vaultForm.status,
        isDefault: vaultForm.isDefault,
        config: buildProviderVaultConfig(vaultForm),
      };
      if (editingVault) {
        return secretsApi.updateProviderConfig(editingVault.id, data);
      }
      return secretsApi.createProviderConfig(selectedCompanyId!, {
        ...(data as UpdateSecretProviderConfigInput),
        provider: vaultForm.provider,
      } as CreateSecretProviderConfigInput);
    },
    onSuccess: (saved) => {
      pushToast({ title: editingVault ? "Provider vault updated" : "Provider vault created", body: saved.displayName, tone: "success" });
      setVaultDialogOpen(false);
      setEditingVault(null);
      setVaultForm(emptyProviderVaultForm());
      setVaultError(null);
      invalidateAll();
    },
    onError: (error) => {
      setVaultError(error instanceof ApiError ? error.message : (error as Error).message);
    },
  });

  const discoverVaultMutation = useMutation({
    mutationFn: () =>
      secretsApi.providerConfigDiscoveryPreview(selectedCompanyId!, {
        provider: "aws_secrets_manager",
        config: buildProviderVaultConfig(vaultForm),
        query: getAwsProviderVaultDiscoveryQuery(vaultForm),
        pageSize: 25,
      }),
    onSuccess: (preview) => {
      setVaultDiscovery(preview);
      setVaultDiscoveryError(null);
    },
    onError: (error) => {
      setVaultDiscovery(null);
      setVaultDiscoveryError(error);
    },
  });

  const disableVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.disableProviderConfig(id),
    onSuccess: (updated) => {
      pushToast({ title: "Provider vault disabled", body: updated.displayName, tone: "info" });
      invalidateAll();
    },
    onError: (error) => {
      pushToast({
        title: "Disable failed",
        body: error instanceof Error ? error.message : "Try again",
        tone: "error",
      });
    },
  });

  const removeVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.removeProviderConfig(id),
    onSuccess: (removed) => {
      pushToast({
        title: "Provider vault removed",
        body: `${removed.displayName} was removed from Paperclip only.`,
        tone: "info",
      });
      setRemoveVaultConfirm(null);
      invalidateAll();
    },
    onError: (error) => {
      pushToast({
        title: "Remove failed",
        body: error instanceof Error ? error.message : "Try again",
        tone: "error",
      });
    },
  });

  const defaultVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.setDefaultProviderConfig(id),
    onSuccess: (updated) => {
      pushToast({ title: "Default vault set", body: updated.displayName, tone: "success" });
      invalidateAll();
    },
    onError: (error) => {
      pushToast({
        title: "Default update failed",
        body: error instanceof Error ? error.message : "Try again",
        tone: "error",
      });
    },
  });

  const healthVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.checkProviderConfigHealth(id),
    onSuccess: (health) => {
      pushToast({ title: "Health checked", body: health.message, tone: health.status === "error" ? "error" : "info" });
      invalidateAll();
    },
    onError: (error) => {
      pushToast({
        title: "Health check failed",
        body: error instanceof Error ? error.message : "Try again",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!createOpen || providers.length === 0) return;
    const currentBlockReason = getCreateProviderBlockReason(
      providers.find((provider) => provider.id === createForm.provider) ?? null,
      createMode,
      providerHealthQuery.data ?? null,
      providerConfigs.find((config) => config.id === createForm.providerConfigId) ?? null,
    );
    if (!currentBlockReason) return;
    const replacement = findCreateProviderReplacement({
      providers,
      providerConfigs,
      currentProvider: createForm.provider,
      mode: createMode,
      health: providerHealthQuery.data ?? null,
    });
    if (replacement && replacement.id !== createForm.provider) {
      setCreateForm((current) => ({
        ...current,
        provider: replacement.id,
        providerConfigId: getDefaultProviderConfigId(providerConfigs, replacement.id),
      }));
    }
  }, [createForm.provider, createMode, createOpen, providerConfigs, providerHealthQuery.data, providers]);

  useEffect(() => {
    if (!createOpen) return;
    const current = providerConfigs.find((config) => config.id === createForm.providerConfigId);
    if (current?.provider === createForm.provider) return;
    const nextProviderConfigId = getDefaultProviderConfigId(providerConfigs, createForm.provider);
    if (nextProviderConfigId === createForm.providerConfigId) return;
    setCreateForm((form) => ({
      ...form,
      providerConfigId: nextProviderConfigId,
    }));
  }, [createForm.provider, createForm.providerConfigId, createOpen, providerConfigs]);

  useEffect(() => {
    if (!rotateOpen || !selectedSecret) return;
    setRotateProviderConfigId(
      selectedSecret.providerConfigId ?? getDefaultProviderConfigId(providerConfigs, selectedSecret.provider),
    );
  }, [providerConfigs, rotateOpen, selectedSecret]);

  function openCreateVault(provider: SecretProvider = "local_encrypted") {
    setEditingVault(null);
    setVaultForm(emptyProviderVaultForm(provider));
    setVaultError(null);
    setVaultDiscovery(null);
    setVaultDiscoveryError(null);
    setVaultDialogOpen(true);
  }

  function openEditVault(config: CompanySecretProviderConfig) {
    setEditingVault(config);
    setVaultForm(providerVaultFormFromConfig(config));
    setVaultError(null);
    setVaultDiscovery(null);
    setVaultDiscoveryError(null);
    setVaultDialogOpen(true);
  }

  function openImportFromVault(config?: CompanySecretProviderConfig | null) {
    setImportInitialVaultId(config?.id ?? null);
    setImportOpen(true);
  }

  function applyVaultDiscoveryCandidate(candidate: SecretProviderConfigDiscoveryCandidate) {
    if (candidate.provider !== "aws_secrets_manager") return;
    const config = candidate.config as Record<string, unknown>;
    setVaultForm((current) => ({
      ...current,
      displayName: current.displayName.trim() ? current.displayName : candidate.displayName,
      region: providerConfigValue(config, "region"),
      namespace: providerConfigValue(config, "namespace"),
      secretNamePrefix: providerConfigValue(config, "secretNamePrefix"),
      kmsKeyId: providerConfigValue(config, "kmsKeyId"),
      ownerTag: providerConfigValue(config, "ownerTag"),
      environmentTag: providerConfigValue(config, "environmentTag"),
    }));
  }

  function openCompanySecret(secret: CompanySecret) {
    setSecretDetailTab("details");
    setSelectedSecretId(secret.id);
    setSelectedDefinitionId(null);
  }

  function openUserDefinition(definition: UserSecretDefinition) {
    setSecretDetailTab("details");
    setSelectedDefinitionId(definition.id);
    setSelectedSecretId(null);
  }

  function openRotateSecret(secret: CompanySecret) {
    openCompanySecret(secret);
    setRotateOpen(true);
    setRotateValue("");
    setRotateExternalRef("");
    setRotateProviderConfigId(
      secret.providerConfigId ?? getDefaultProviderConfigId(providerConfigs, secret.provider),
    );
    setRotateError(null);
  }

  function copySecretKey(key: string) {
    void copyTextToClipboard(key)
      .then(() => pushToast({ title: "Secret key copied", body: key, tone: "success" }))
      .catch((error) =>
        pushToast({
          title: "Copy failed",
          body: error instanceof Error ? error.message : "Unable to copy secret key",
          tone: "error",
        }),
      );
  }

  function renderRowActions(row: UnifiedSecretRow) {
    const name = row.kind === "company" ? row.secret.name : row.definition.name;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${name}`}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            onSelect={() => {
              if (row.kind === "company") openCompanySecret(row.secret);
              else openUserDefinition(row.definition);
            }}
          >
            <KeyRound className="h-4 w-4" /> View details
          </DropdownMenuItem>
          {row.kind === "company" ? (
            <>
              <DropdownMenuItem onSelect={() => setUsageDialogSecretId(row.secret.id)}>
                <Link2 className="h-4 w-4" /> View references ({row.secret.referenceCount ?? 0})
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openRotateSecret(row.secret)}>
                <RefreshCw className="h-4 w-4" />
                {row.secret.managedMode === "external_reference" ? "Update reference" : "Update value"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={statusMutation.isPending}
                onSelect={() =>
                  statusMutation.mutate({
                    id: row.secret.id,
                    status: row.secret.status === "active" ? "disabled" : "active",
                  })
                }
              >
                {row.secret.status === "active" ? <Ban className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                {row.secret.status === "active" ? "Disable" : "Activate"}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={statusMutation.isPending}
                onSelect={() =>
                  statusMutation.mutate({
                    id: row.secret.id,
                    status: row.secret.status === "archived" ? "active" : "archived",
                  })
                }
              >
                {row.secret.status === "archived" ? (
                  <ArchiveRestore className="h-4 w-4" />
                ) : (
                  <Archive className="h-4 w-4" />
                )}
                {row.secret.status === "archived" ? "Unarchive" : "Archive"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteConfirm(row.secret)}>
                <Trash2 className="h-4 w-4" /> Delete secret
              </DropdownMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuItem
                disabled={row.definition.status !== "active"}
                onSelect={() =>
                  setSetMyValueFor(
                    myUserSecrets.find((entry) => entry.definition.id === row.definition.id) ?? {
                      definition: row.definition,
                      secret: null,
                    },
                  )
                }
              >
                <KeyRound className="h-4 w-4" />
                {myUserSecrets.find((entry) => entry.definition.id === row.definition.id)?.secret
                  ? "Update my value"
                  : "Set my value"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openEditDefinition(row.definition)}>
                <Pencil className="h-4 w-4" /> Edit definition
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={definitionStatusMutation.isPending}
                onSelect={() =>
                  definitionStatusMutation.mutate({
                    definition: row.definition,
                    status: row.definition.status === "active" ? "disabled" : "active",
                  })
                }
              >
                {row.definition.status === "active" ? (
                  <Ban className="h-4 w-4" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                {row.definition.status === "active" ? "Disable" : "Activate"}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={definitionStatusMutation.isPending}
                onSelect={() =>
                  definitionStatusMutation.mutate({
                    definition: row.definition,
                    status: row.definition.status === "archived" ? "active" : "archived",
                  })
                }
              >
                {row.definition.status === "archived" ? (
                  <ArchiveRestore className="h-4 w-4" />
                ) : (
                  <Archive className="h-4 w-4" />
                )}
                {row.definition.status === "archived" ? "Unarchive" : "Archive"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDefinitionDeleteConfirm(row.definition)}>
                <Trash2 className="h-4 w-4" /> Delete definition
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Select a company to manage secrets.</div>
    );
  }

  return (
    <TooltipProvider>
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Secrets</h1>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as SecretsTab)}
        className="flex min-h-0 flex-1 flex-col gap-4"
      >
        <PageTabBar
          items={[
            { value: "secrets", label: "Secrets" },
            { value: "my-secrets", label: "My secrets" },
            { value: "vaults", label: "Provider vaults" },
          ]}
          align="start"
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as SecretsTab)}
        />

        <TabsContent value="secrets" className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          <SecretsHowToUse />
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-48 sm:w-64 md:w-80">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name, key, ref"
                className="pl-7 text-xs sm:text-sm"
                aria-label="Search secrets"
                data-page-search-target="true"
              />
            </div>
            <SecretsFiltersPopover
              statusFilter={statusFilter}
              providerFilter={providerFilter}
              providedByFilter={providedByFilter}
              providers={providers}
              activeFilterCount={activeSecretFilterCount}
              onStatusChange={setStatusFilter}
              onProviderChange={setProviderFilter}
              onProvidedByChange={setProvidedByFilter}
            />
            <ImportFromVaultButton
              providerConfigs={providerConfigs}
              onClick={() => openImportFromVault()}
              onManageVaults={() => setActiveTab("vaults")}
              className="ml-auto"
            />
            <Button onClick={openCreateSecret} size="sm">
              <Plus className="h-3.5 w-3.5 mr-1" /> New secret
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {secretsQuery.isError || userDefinitionsQuery.isError ? (
              <div className="text-sm text-destructive flex items-center gap-2 py-4">
                <AlertCircle className="h-4 w-4" /> Failed to load secrets:{" "}
                {((secretsQuery.error ?? userDefinitionsQuery.error) as Error).message}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void secretsQuery.refetch();
                    void userDefinitionsQuery.refetch();
                  }}
                >
                  Retry
                </Button>
              </div>
            ) : unifiedRows.length === 0 && !secretsQuery.isPending && !userDefinitionsQuery.isPending ? (
              <EmptyState
                icon={KeyRound}
                message="No secrets yet. Create a shared company secret or one that each user supplies."
                action="New secret"
                onAction={openCreateSecret}
              />
            ) : filteredRows.length === 0 ? (
              <EmptyState icon={Search} message="No secrets match your filters." />
            ) : (
              <div className="@container min-w-0 overflow-x-hidden text-sm" data-testid="secrets-list-container">
                <div
                  role="table"
                  aria-label="Secrets"
                  className="hidden min-w-0 @min-[40rem]:block"
                  data-testid="secrets-table-view"
                >
                  <div
                    role="row"
                    className="grid grid-cols-[minmax(12rem,2.4fr)_minmax(5.25rem,0.75fr)_minmax(7rem,1fr)_minmax(5rem,0.7fr)_2.75rem] items-center gap-3 bg-muted/40 px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    <div role="columnheader" className="font-medium">Secret</div>
                    <div role="columnheader" className="font-medium">Status</div>
                    <div role="columnheader" className="font-medium">Version / coverage</div>
                    <div role="columnheader" className="font-medium">Updated</div>
                    <div role="columnheader" className="sr-only">Actions</div>
                  </div>
                  <div role="rowgroup">
                    {filteredRows.map((row) => {
                      const status = row.kind === "company" ? row.secret.status : row.definition.status;
                      const updatedAt = row.kind === "company" ? row.secret.updatedAt : row.definition.updatedAt;
                      const updatedTooltip =
                        row.kind === "company"
                          ? [
                              `Updated: ${formatRelative(row.secret.updatedAt)}`,
                              `Last rotated: ${formatRelative(row.secret.lastRotatedAt)}`,
                              `Last resolved: ${formatRelative(row.secret.lastResolvedAt)}`,
                            ].join("\n")
                          : `Updated: ${formatRelative(row.definition.updatedAt)}\nLast resolved: user values resolve per member`;
                      return (
                        <div
                          key={row.id}
                          role="row"
                          className={cn(
                            "grid cursor-pointer grid-cols-[minmax(12rem,2.4fr)_minmax(5.25rem,0.75fr)_minmax(7rem,1fr)_minmax(5rem,0.7fr)_2.75rem] items-center gap-3 border-b border-border/60 px-3 py-3 hover:bg-accent/40",
                            row.kind === "company" && selectedSecretId === row.secret.id && "bg-accent/60",
                            row.kind === "user" && selectedDefinitionId === row.definition.id && "bg-accent/60",
                          )}
                          onClick={() => {
                            if (row.kind === "company") openCompanySecret(row.secret);
                            else openUserDefinition(row.definition);
                          }}
                        >
                          <div role="cell" className="min-w-0">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate font-medium text-foreground">
                                {row.kind === "company" ? row.secret.name : row.definition.name}
                              </span>
                              {row.kind === "company" ? (
                                <SecretProviderIndicator
                                  secret={row.secret}
                                  providers={providers}
                                  providerConfigs={providerConfigs}
                                />
                              ) : (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span
                                      aria-label="Each user provides and owns their own value"
                                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-violet-500/30 bg-violet-500/5 text-violet-700 dark:text-violet-200"
                                    >
                                      <UserRound className="h-3 w-3" />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>Each user provides and owns their own value</TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                            <code className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                              {row.kind === "company" ? row.secret.key : row.definition.key}
                            </code>
                            <div className="mt-1">
                              {row.kind === "company" ? (
                                <MetaChip>
                                  <ShieldCheck className="h-3 w-3" /> Company
                                </MetaChip>
                              ) : (
                                <UserSecretChip label="Each user" />
                              )}
                            </div>
                          </div>
                          <div role="cell">
                            <StatusBadge status={status} />
                          </div>
                          <div role="cell" className="min-w-0 text-xs">
                            {row.kind === "company" ? (
                              <span className="truncate text-muted-foreground">
                                <span className="font-mono text-foreground">v{row.secret.latestVersion}</span>
                                <span> · {row.secret.managedMode === "external_reference" ? "linked" : "managed"}</span>
                              </span>
                            ) : (
                              <CoverageInline companyId={selectedCompanyId} definitionId={row.definition.id} compact />
                            )}
                          </div>
                          <div role="cell">
                            <UpdatedWithTooltip updatedAt={updatedAt} tooltip={updatedTooltip} />
                          </div>
                          <div role="cell" className="text-right" onClick={(event) => event.stopPropagation()}>
                            {renderRowActions(row)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-2 @min-[40rem]:hidden" data-testid="secrets-card-view">
                  {filteredRows.map((row) => {
                    const status = row.kind === "company" ? row.secret.status : row.definition.status;
                    return (
                      <div
                        key={row.id}
                        className={cn(
                          "cursor-pointer rounded-md border border-border bg-background p-3 hover:bg-accent/30",
                          row.kind === "company" && selectedSecretId === row.secret.id && "bg-accent/60",
                          row.kind === "user" && selectedDefinitionId === row.definition.id && "bg-accent/60",
                        )}
                        onClick={() => {
                          if (row.kind === "company") openCompanySecret(row.secret);
                          else openUserDefinition(row.definition);
                        }}
                      >
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-medium text-foreground">
                              {row.kind === "company" ? row.secret.name : row.definition.name}
                            </div>
                            <code className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                              {row.kind === "company" ? row.secret.key : row.definition.key}
                            </code>
                          </div>
                          <div onClick={(event) => event.stopPropagation()}>{renderRowActions(row)}</div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {row.kind === "company" ? (
                            <>
                              <MetaChip>
                                <ShieldCheck className="h-3 w-3" /> Company
                              </MetaChip>
                              <SecretProviderIndicator
                                secret={row.secret}
                                providers={providers}
                                providerConfigs={providerConfigs}
                              />
                              <StatusBadge status={status} />
                            </>
                          ) : (
                            <>
                              <UserSecretChip label="Each user" />
                              <StatusBadge status={status} />
                              <CoverageInline companyId={selectedCompanyId} definitionId={row.definition.id} compact />
                            </>
                          )}
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="min-w-0 truncate">
                            {row.kind === "company" ? (
                              <>
                                v{row.secret.latestVersion} ·{" "}
                                {row.secret.managedMode === "external_reference" ? "linked" : "managed"}
                              </>
                            ) : (
                              "Member-owned values"
                            )}
                          </span>
                          <span>Updated {formatRelative(row.kind === "company" ? row.secret.updatedAt : row.definition.updatedAt)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </TabsContent>
        <TabsContent
          value="my-secrets"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"
        >
          <MyUserSecretsTab companyId={selectedCompanyId} />
        </TabsContent>
        <TabsContent value="vaults" className="min-h-0 flex-1 overflow-y-auto">
          <ProviderVaultsTab
            providers={providers}
            providerConfigs={providerConfigs}
            loading={providerConfigsQuery.isPending}
            error={providerConfigsQuery.error}
            onRetry={() => providerConfigsQuery.refetch()}
            onCreate={openCreateVault}
            onEdit={openEditVault}
            onDisable={(config) => disableVaultMutation.mutate(config.id)}
            onRemove={(config) => setRemoveVaultConfirm(config)}
            onSetDefault={(config) => defaultVaultMutation.mutate(config.id)}
            onHealthCheck={(config) => healthVaultMutation.mutate(config.id)}
            onImportSecrets={openImportFromVault}
            pendingActionId={
              disableVaultMutation.variables ??
              removeVaultMutation.variables ??
              defaultVaultMutation.variables ??
              healthVaultMutation.variables ??
              null
            }
          />
        </TabsContent>
      </Tabs>

      <Sheet
        open={Boolean(selectedSecret || selectedDefinition)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSecretId(null);
            setSelectedDefinitionId(null);
          }
        }}
      >
        <SheetContent className="w-full sm:max-w-xl flex flex-col gap-0">
          {selectedSecret ? (
            <>
              <SheetHeader className="space-y-3">
                <SheetTitle className="flex min-w-0 items-center gap-2 pr-8 text-base">
                  <KeyRound className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{selectedSecret.name}</span>
                  <span className="shrink-0">
                    <StatusBadge status={selectedSecret.status} />
                  </span>
                </SheetTitle>
                <SheetDescription className="sr-only">
                  {providerLabel(providers, selectedSecret.provider)} secret {selectedSecret.key}
                </SheetDescription>
                <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/20 px-2 py-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {selectedSecret.key}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-xs"
                    onClick={() => copySecretKey(selectedSecret.key)}
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" /> Copy
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <MetaChip>
                    <ShieldCheck className="h-3 w-3" /> Company
                  </MetaChip>
                  <MetaChip>{modeLabel(selectedSecret.managedMode)}</MetaChip>
                  <MetaChip>{providerLabel(providers, selectedSecret.provider)}</MetaChip>
                  <MetaChip>v{selectedSecret.latestVersion}</MetaChip>
                </div>
              </SheetHeader>
              <div className="flex items-center gap-2 px-4 pb-2">
                <Button
                  size="sm"
                  onClick={() => openRotateSecret(selectedSecret)}
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  {selectedSecret.managedMode === "external_reference" ? "Update reference" : "Update value"}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" aria-label={`More actions for ${selectedSecret.name}`}>
                      <MoreHorizontal className="mr-1 h-3.5 w-3.5" /> More
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem
                      disabled={statusMutation.isPending}
                      onSelect={() =>
                        statusMutation.mutate({
                          id: selectedSecret.id,
                          status: selectedSecret.status === "active" ? "disabled" : "active",
                        })
                      }
                    >
                      {selectedSecret.status === "active" ? (
                        <Ban className="h-4 w-4" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" />
                      )}
                      {selectedSecret.status === "active" ? "Disable" : "Activate"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={statusMutation.isPending}
                      onSelect={() =>
                        statusMutation.mutate({
                          id: selectedSecret.id,
                          status: selectedSecret.status === "archived" ? "active" : "archived",
                        })
                      }
                    >
                      {selectedSecret.status === "archived" ? (
                        <ArchiveRestore className="h-4 w-4" />
                      ) : (
                        <Archive className="h-4 w-4" />
                      )}
                      {selectedSecret.status === "archived" ? "Unarchive" : "Archive"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setDeleteConfirm(selectedSecret)}>
                      <Trash2 className="h-4 w-4" /> Delete secret
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Tabs value={secretDetailTab} onValueChange={setSecretDetailTab} className="flex-1 min-h-0 flex flex-col">
                <div className="border-b border-border px-4">
                  <PageTabBar
                    items={[
                      { value: "details", label: "Details" },
                      { value: "usage", label: usageQuery.data ? `Usage (${usageQuery.data.bindings.length})` : "Usage" },
                      { value: "events", label: "Access events" },
                    ]}
                    align="start"
                    value={secretDetailTab}
                    onValueChange={setSecretDetailTab}
                  />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
                  <TabsContent value="details">
                    <SecretDetailsTab
                      secret={selectedSecret}
                      providers={providers}
                      providerConfigs={providerConfigs}
                      onViewUsage={() => setSecretDetailTab("usage")}
                    />
                  </TabsContent>
                  <TabsContent value="usage">
                    <SecretUsageTab loading={usageQuery.isPending} bindings={usageQuery.data?.bindings ?? []} />
                  </TabsContent>
                  <TabsContent value="events">
                    <SecretEventsTab
                      loading={eventsQuery.isPending}
                      events={eventsQuery.data ?? []}
                      companyId={selectedCompanyId}
                    />
                  </TabsContent>
                </div>
              </Tabs>
            </>
          ) : selectedDefinition ? (
            <>
              <SheetHeader className="space-y-3">
                <SheetTitle className="flex min-w-0 items-center gap-2 pr-8 text-base">
                  <UserRound className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{selectedDefinition.name}</span>
                  <span className="shrink-0">
                    <StatusBadge status={selectedDefinition.status} />
                  </span>
                </SheetTitle>
                <SheetDescription className="sr-only">
                  Each user secret definition {selectedDefinition.key}
                </SheetDescription>
                <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/20 px-2 py-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {selectedDefinition.key}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-xs"
                    onClick={() => copySecretKey(selectedDefinition.key)}
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" /> Copy
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <UserSecretChip label="Each user" />
                  <MetaChip>
                    <CoverageInline companyId={selectedCompanyId} definitionId={selectedDefinition.id} compact />
                  </MetaChip>
                </div>
              </SheetHeader>
              <div className="flex items-center gap-2 px-4 pb-2">
                <Button
                  size="sm"
                  onClick={() =>
                    setSetMyValueFor(
                      selectedDefinitionMyEntry ?? { definition: selectedDefinition, secret: null },
                    )
                  }
                  disabled={selectedDefinition.status !== "active"}
                >
                  <KeyRound className="h-3.5 w-3.5 mr-1" />
                  {selectedDefinitionMyEntry?.secret ? "Update my value" : "Set my value"}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" aria-label={`More actions for ${selectedDefinition.name}`}>
                      <MoreHorizontal className="mr-1 h-3.5 w-3.5" /> More
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onSelect={() => openEditDefinition(selectedDefinition)}>
                      <Pencil className="h-4 w-4" /> Edit definition
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={definitionStatusMutation.isPending}
                      onSelect={() =>
                        definitionStatusMutation.mutate({
                          definition: selectedDefinition,
                          status: selectedDefinition.status === "active" ? "disabled" : "active",
                        })
                      }
                    >
                      {selectedDefinition.status === "active" ? (
                        <Ban className="h-4 w-4" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" />
                      )}
                      {selectedDefinition.status === "active" ? "Disable" : "Activate"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={definitionStatusMutation.isPending}
                      onSelect={() =>
                        definitionStatusMutation.mutate({
                          definition: selectedDefinition,
                          status: selectedDefinition.status === "archived" ? "active" : "archived",
                        })
                      }
                    >
                      {selectedDefinition.status === "archived" ? (
                        <ArchiveRestore className="h-4 w-4" />
                      ) : (
                        <Archive className="h-4 w-4" />
                      )}
                      {selectedDefinition.status === "archived" ? "Unarchive" : "Archive"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setDefinitionDeleteConfirm(selectedDefinition)}>
                      <Trash2 className="h-4 w-4" /> Delete definition
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Tabs value={secretDetailTab} onValueChange={setSecretDetailTab} className="flex-1 min-h-0 flex flex-col">
                <div className="border-b border-border px-4">
                  <PageTabBar
                    items={[
                      { value: "details", label: "Details" },
                      { value: "coverage", label: "Coverage" },
                      { value: "usage", label: "Usage" },
                      { value: "events", label: "Access events" },
                    ]}
                    align="start"
                    value={secretDetailTab}
                    onValueChange={setSecretDetailTab}
                  />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
                  <TabsContent value="details">
                    <UserSecretDetailsTab
                      companyId={selectedCompanyId}
                      definition={selectedDefinition}
                      onViewCoverage={() => setSecretDetailTab("coverage")}
                    />
                  </TabsContent>
                  <TabsContent value="coverage">
                    <UserSecretCoverageTab
                      companyId={selectedCompanyId}
                      definitionId={selectedDefinition.id}
                    />
                  </TabsContent>
                  <TabsContent value="usage">
                    <UserSecretUsageTab definition={selectedDefinition} />
                  </TabsContent>
                  <TabsContent value="events">
                    <UserSecretAccessEventsTab />
                  </TabsContent>
                </div>
              </Tabs>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog
        open={Boolean(usageDialogSecret)}
        onOpenChange={(open) => !open && setUsageDialogSecretId(null)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Secret references</DialogTitle>
            <DialogDescription>
              {usageDialogSecret
                ? `${usageDialogSecret.name} is referenced by ${usageDialogSecret.referenceCount ?? 0} ${
                    (usageDialogSecret.referenceCount ?? 0) === 1 ? "place" : "places"
                  }.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <SecretUsageTab
            loading={usageDialogQuery.isPending}
            bindings={usageDialogQuery.data?.bindings ?? []}
          />
        </DialogContent>
      </Dialog>

      {selectedCompanyId && (
        <ImportFromVaultDialog
          open={importOpen}
          onOpenChange={(open) => {
            setImportOpen(open);
            if (!open) setImportInitialVaultId(null);
          }}
          companyId={selectedCompanyId}
          providerConfigs={providerConfigs}
          existingSecrets={secrets}
          initialProviderConfigId={importInitialVaultId}
          onManageVaults={() => {
            setImportOpen(false);
            setImportInitialVaultId(null);
            setActiveTab("vaults");
          }}
          onImportComplete={() => {
            void secretsQuery.refetch();
          }}
        />
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:max-w-lg sm:p-6">
          <DialogHeader>
            <DialogTitle>{editingDefinition ? "Edit user-provided secret" : "Create secret"}</DialogTitle>
            <DialogDescription>
              Choose who provides the value. Shared fields keep their values when you switch modes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium" htmlFor="new-secret-name">Name</label>
                <Input
                  id="new-secret-name"
                  value={createForm.name}
                  onChange={(event) => {
                    const name = event.target.value;
                    setCreateForm((current) => ({
                      ...current,
                      name,
                      key: createKeyDirty
                        ? current.key
                        : secretValueProvider === "user"
                          ? normalizeUserSecretKeyForPreview(name)
                          : normalizeSecretKeyForPreview(name),
                    }));
                  }}
                  placeholder={secretValueProvider === "user" ? "Personal GitHub token" : "OPENAI_API_KEY"}
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-medium" htmlFor="new-secret-key">
                  Key {secretValueProvider === "company" ? <span className="text-muted-foreground/70">(optional)</span> : null}
                </label>
                <Input
                  id="new-secret-key"
                  value={createForm.key}
                  onChange={(event) => {
                    setCreateKeyDirty(true);
                    setCreateForm((current) => ({ ...current, key: event.target.value }));
                  }}
                  placeholder={secretValueProvider === "user" ? "PERSONAL_GH_TOKEN" : "auto from name"}
                  disabled={Boolean(editingDefinition)}
                  className={secretValueProvider === "user" ? "font-mono text-sm" : undefined}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {secretValueProvider === "user"
                    ? editingDefinition
                      ? "Stable env binding key. Cannot be changed."
                      : "Env-style key used by user-secret bindings."
                    : "Shared secret keys keep lowercase dash normalization."}
                </p>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium" htmlFor="new-secret-description">
                Description <span className="text-muted-foreground/70">(optional)</span>
              </label>
              <Input
                id="new-secret-description"
                value={createForm.description}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, description: event.target.value }))
                }
                placeholder="What is this secret used for? (no values)"
              />
            </div>

            {!editingDefinition ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-foreground">Who provides the value?</p>
                <Tabs
                  value={secretValueProvider}
                  onValueChange={(value) => {
                    const next = value as SecretValueProvider;
                    setSecretValueProvider(next);
                    setCreateForm((current) => ({
                      ...current,
                      key: createKeyDirty
                        ? current.key
                        : next === "user"
                          ? normalizeUserSecretKeyForPreview(current.name)
                          : normalizeSecretKeyForPreview(current.name),
                    }));
                  }}
                >
                  <TabsList className="grid h-auto w-full grid-cols-2">
                    <TabsTrigger value="company">Company</TabsTrigger>
                    <TabsTrigger value="user">Each user</TabsTrigger>
                  </TabsList>
                </Tabs>
                <p className="text-[11px] text-muted-foreground">
                  Company stores one shared value. Each user lets every member supply their own value under My secrets.
                </p>
              </div>
            ) : null}

            {secretValueProvider === "company" ? (
              <>
                <Tabs value={createMode} onValueChange={(value) => setCreateMode(value as CreateMode)}>
                  <TabsList className="grid h-auto w-full grid-cols-2">
                    <TabsTrigger
                      value="managed"
                      className="min-h-9 whitespace-normal px-1.5 text-center text-xs leading-tight sm:text-sm"
                    >
                      Managed value
                    </TabsTrigger>
                    <TabsTrigger
                      value="external"
                      className="min-h-9 whitespace-normal px-1.5 text-center text-xs leading-tight sm:text-sm"
                    >
                      External reference
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <div>
                  <label className="text-xs font-medium" htmlFor="new-secret-provider">Provider</label>
                  <select
                    id="new-secret-provider"
                    className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
                    value={createForm.provider}
                    onChange={(event) =>
                      setCreateForm((current) => {
                        const provider = event.target.value as SecretProvider;
                        return {
                          ...current,
                          provider,
                          providerConfigId: getDefaultProviderConfigId(providerConfigs, provider),
                        };
                      })
                    }
                  >
                    {providers.map((provider) => (
                      <option
                        key={provider.id}
                        value={provider.id}
                        disabled={Boolean(
                          getCreateProviderBlockReason(
                            provider,
                            createMode,
                            providerHealthQuery.data ?? null,
                            getSelectableProviderConfig(providerConfigs, provider.id),
                          ),
                        )}
                      >
                        {provider.label}
                        {provider.configured === false &&
                        !getSelectableProviderConfig(providerConfigs, provider.id)
                          ? " (deployment default missing)"
                          : provider.requiresExternalRef
                            ? " (external only)"
                            : ""}
                      </option>
                    ))}
                  </select>
                  {createProviderBlockReason ? (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
                      <AlertCircle className="h-3 w-3" />
                      {createProviderBlockReason}
                    </p>
                  ) : createProviderHealthText ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">{createProviderHealthText}</p>
                  ) : null}
                </div>
                <div>
                  <label className="text-xs font-medium" htmlFor="new-secret-vault">Provider vault</label>
                  <select
                    id="new-secret-vault"
                    className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
                    value={createForm.providerConfigId}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, providerConfigId: event.target.value }))
                    }
                  >
                    <option value="">Deployment default</option>
                    {createProviderConfigs.map((config) => {
                      const blockReason = getProviderConfigBlockReason(config);
                      return (
                        <option key={config.id} value={config.id} disabled={Boolean(blockReason)}>
                          {config.displayName}
                          {config.isDefault ? " (default)" : ""}
                          {blockReason ? ` (${blockReason})` : ""}
                        </option>
                      );
                    })}
                  </select>
                  {selectedCreateProviderConfig ? (
                    <ProviderVaultInlineWarning config={selectedCreateProviderConfig} />
                  ) : (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Existing deployment-level provider settings stay available for backwards compatibility.
                    </p>
                  )}
                </div>
                {createMode === "managed" ? (
                  <>
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                  Paperclip-managed secrets are created in the selected provider and future rotations
                  write a new provider version through Paperclip.
                  {awsManagedPathPreview ? (
                    <div className="mt-1">
                      AWS managed path:{" "}
                      <code className="break-all rounded bg-background/70 px-1 py-0.5">
                        {awsManagedPathPreview}
                      </code>
                    </div>
                  ) : null}
                </div>
                <div>
                  <label className="text-xs font-medium" htmlFor="new-secret-value">Value</label>
                  <Textarea
                    id="new-secret-value"
                    value={createForm.value}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, value: event.target.value }))
                    }
                    rows={3}
                    className="min-w-0 overflow-x-hidden break-all font-mono text-xs"
                    placeholder="Stored once, never re-displayed"
                  />
                </div>
                  </>
                ) : (
                  <div>
                    <label className="text-xs font-medium" htmlFor="new-secret-ref">External reference</label>
                    <Input
                      id="new-secret-ref"
                      value={createForm.externalRef}
                      onChange={(event) =>
                        setCreateForm((current) => ({ ...current, externalRef: event.target.value }))
                      }
                      placeholder="arn:aws:secretsmanager:..."
                      className="font-mono text-xs"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Existing provider secrets are resolve-only in Paperclip. Rotate the value in the provider,
                      then update this reference only if the path, ARN, or version changes.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="rounded-md border border-violet-500/30 bg-violet-500/5 p-2 text-[11px] text-violet-800 dark:text-violet-200">
                  Every member supplies their own value under My secrets. Agents resolve the responsible
                  user&apos;s value at runtime.
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground" htmlFor="new-secret-usage-guidance">
                    Usage guidance <span className="text-muted-foreground/70">(optional)</span>
                  </label>
                  <Textarea
                    id="new-secret-usage-guidance"
                    value={createForm.usageGuidance}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, usageGuidance: event.target.value }))
                    }
                    placeholder="Tell members how to create their token, required scopes, etc."
                    className="min-h-[70px] text-sm"
                  />
                </div>
              </>
            )}
            {createError ? <p className="text-xs text-destructive">{createError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setCreateError(null);
                createMutation.mutate();
              }}
              disabled={
                createMutation.isPending ||
                !createForm.name.trim() ||
                (secretValueProvider === "user"
                  ? !createForm.key.trim()
                  : Boolean(createProviderBlockReason) ||
                    (createMode === "managed" ? !createForm.value : !createForm.externalRef.trim()))
              }
            >
              {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              {editingDefinition
                ? "Save changes"
                : secretValueProvider === "user"
                  ? "Create user-provided secret"
                  : createMode === "managed"
                    ? "Create secret"
                    : "Link reference"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={vaultDialogOpen} onOpenChange={setVaultDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingVault ? "Edit provider vault" : "Create provider vault"}</DialogTitle>
            <DialogDescription>
              Save only non-sensitive routing metadata. Credentials stay in the runtime environment or provider identity.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium" htmlFor="vault-provider">Provider</label>
                <select
                  id="vault-provider"
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none disabled:opacity-60"
                  value={vaultForm.provider}
                  disabled={Boolean(editingVault)}
                  onChange={(event) => {
                    const provider = event.target.value as SecretProvider;
                    setVaultForm(emptyProviderVaultForm(provider));
                    setVaultDiscovery(null);
                    setVaultDiscoveryError(null);
                  }}
                >
                  {PROVIDER_ORDER.map((provider) => (
                    <option key={provider} value={provider}>
                      {providerLabel(providers, provider)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium" htmlFor="vault-name">Display name</label>
                <Input
                  id="vault-name"
                  value={vaultForm.displayName}
                  onChange={(event) =>
                    setVaultForm((current) => ({ ...current, displayName: event.target.value }))
                  }
                  placeholder="Production local vault"
                />
              </div>
              <div>
                <label className="text-xs font-medium" htmlFor="vault-status">Status</label>
                <select
                  id="vault-status"
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
                  value={vaultForm.status}
                  onChange={(event) => {
                    const status = event.target.value as SecretProviderConfigStatus;
                    setVaultForm((current) => ({
                      ...current,
                      status,
                      isDefault:
                        status === "coming_soon" || status === "disabled" ? false : current.isDefault,
                    }));
                  }}
                >
                  <option value="ready" disabled={vaultForm.provider === "gcp_secret_manager" || vaultForm.provider === "vault"}>
                    Ready
                  </option>
                  <option value="warning" disabled={vaultForm.provider === "gcp_secret_manager" || vaultForm.provider === "vault"}>
                    Warning
                  </option>
                  <option value="coming_soon">Coming soon</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>
              <label className="flex items-center gap-2 pt-6 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-border"
                  checked={vaultForm.isDefault}
                  disabled={vaultForm.status === "coming_soon" || vaultForm.status === "disabled"}
                  onChange={(event) =>
                    setVaultForm((current) => ({ ...current, isDefault: event.target.checked }))
                  }
                />
                Default for {providerLabel(providers, vaultForm.provider)}
              </label>
            </div>

            <ProviderVaultFields form={vaultForm} onChange={setVaultForm} />

            {!editingVault && vaultForm.provider === "aws_secrets_manager" ? (
              <AwsProviderVaultDiscoveryPanel
                form={vaultForm}
                preview={vaultDiscovery}
                error={vaultDiscoveryError}
                loading={discoverVaultMutation.isPending}
                onDiscover={() => {
                  setVaultDiscovery(null);
                  setVaultDiscoveryError(null);
                  discoverVaultMutation.mutate();
                }}
                onApply={applyVaultDiscoveryCandidate}
              />
            ) : null}

            {vaultForm.provider === "gcp_secret_manager" || vaultForm.provider === "vault" ? (
              <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-xs text-sky-700 dark:text-sky-300">
                This provider can save draft routing metadata, but runtime writes and resolution stay disabled until
                the provider module is implemented and reviewed.
              </div>
            ) : null}
            {vaultError ? <p className="text-xs text-destructive">{vaultError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVaultDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setVaultError(null);
                saveVaultMutation.mutate();
              }}
              disabled={
                saveVaultMutation.isPending ||
                !vaultForm.displayName.trim() ||
                (vaultForm.provider === "aws_secrets_manager" && !vaultForm.region.trim())
              }
            >
              {saveVaultMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              {editingVault ? "Save vault" : "Create vault"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {selectedSecret?.managedMode === "external_reference" ? "Update external reference" : "Update secret value"}
            </DialogTitle>
            <DialogDescription>
              {selectedSecret?.managedMode === "external_reference"
                ? "Creates a new Paperclip metadata version that points at an existing provider secret. Paperclip does not write a new provider value."
                : "Creates a new provider-backed version. Consumers pinned to latest pick up the new value on the next run."}
            </DialogDescription>
          </DialogHeader>
          <div>
            <label className="text-xs font-medium" htmlFor="rotate-secret-vault">Provider vault</label>
            <select
              id="rotate-secret-vault"
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
              value={rotateProviderConfigId}
              onChange={(event) => setRotateProviderConfigId(event.target.value)}
            >
              <option value="">Deployment default</option>
              {selectedRotateProviderConfigs.map((config) => {
                const blockReason = getProviderConfigBlockReason(config);
                return (
                  <option key={config.id} value={config.id} disabled={Boolean(blockReason)}>
                    {config.displayName}
                    {config.isDefault ? " (default)" : ""}
                    {blockReason ? ` (${blockReason})` : ""}
                  </option>
                );
              })}
            </select>
            {selectedRotateProviderConfig ? (
              <ProviderVaultInlineWarning config={selectedRotateProviderConfig} />
            ) : (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Rotating with the deployment default preserves current fallback behavior.
              </p>
            )}
          </div>
          {selectedSecret?.managedMode === "external_reference" ? (
            <div>
              <label className="text-xs font-medium" htmlFor="rotate-ref">External reference</label>
              <Input
                id="rotate-ref"
                value={rotateExternalRef}
                onChange={(event) => setRotateExternalRef(event.target.value)}
                placeholder={selectedSecret.externalRef ?? "Updated reference"}
                className="font-mono text-xs"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Rotate the actual value in the provider before changing this Paperclip reference.
              </p>
            </div>
          ) : (
            <div>
              <label className="text-xs font-medium" htmlFor="rotate-value">New value</label>
              <Textarea
                id="rotate-value"
                value={rotateValue}
                onChange={(event) => setRotateValue(event.target.value)}
                rows={3}
                className="font-mono text-xs"
                placeholder="Paste the new value"
              />
            </div>
          )}
          {rotateError ? <p className="text-xs text-destructive">{rotateError}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setRotateError(null);
                rotateMutation.mutate();
              }}
              disabled={
                rotateMutation.isPending ||
                Boolean(rotateProviderBlockReason) ||
                (selectedSecret?.managedMode === "external_reference"
                  ? !rotateExternalRef.trim() && !selectedSecret?.externalRef
                  : !rotateValue)
              }
            >
              {rotateMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              {selectedSecret?.managedMode === "external_reference" ? "Update reference" : "Update value"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteConfirm)} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete secret</DialogTitle>
            <DialogDescription>
              Permanently removes <strong>{deleteConfirm?.name}</strong>. Active bindings will fail until you remap them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(definitionDeleteConfirm)}
        onOpenChange={(open) => !open && setDefinitionDeleteConfirm(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete user-provided secret</DialogTitle>
            <DialogDescription>
              Permanently removes <strong>{definitionDeleteConfirm?.name}</strong> for the whole company.
              Existing member values become unreferenced and active bindings must be remapped.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDefinitionDeleteConfirm(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() =>
                definitionDeleteConfirm && deleteDefinitionMutation.mutate(definitionDeleteConfirm)
              }
              disabled={deleteDefinitionMutation.isPending}
            >
              {deleteDefinitionMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SetMyUserSecretDialog
        companyId={selectedCompanyId}
        definition={setMyValueFor?.definition ?? null}
        existingSecret={setMyValueFor?.secret ?? null}
        open={setMyValueFor !== null}
        onOpenChange={(open) => {
          if (!open) setSetMyValueFor(null);
        }}
      />

      <Dialog open={Boolean(removeVaultConfirm)} onOpenChange={(open) => !open && setRemoveVaultConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove provider vault</DialogTitle>
            <DialogDescription>
              Removes <strong>{removeVaultConfirm?.displayName}</strong> from Paperclip only.{" "}
              {removeVaultConfirm?.provider === "aws_secrets_manager"
                ? "This does not delete the remote AWS Secrets Manager vault, secrets, or any AWS data."
                : "This does not delete any remote provider data."}{" "}
              Secrets using this vault will lose the vault association until you assign another one.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveVaultConfirm(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => removeVaultConfirm && removeVaultMutation.mutate(removeVaultConfirm.id)}
              disabled={removeVaultMutation.isPending}
            >
              {removeVaultMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Remove from Paperclip
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}

function SecretsHowToUse() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium text-foreground">Use secrets by binding them to runtime environment variables.</p>
        <p>
          Create or link a secret here, then open an agent&apos;s Environment variables or a project&apos;s Env field.
          Add the env key the process expects, for example <code className="font-mono">GH_TOKEN</code>, choose{" "}
          <span className="font-medium text-foreground">Secret</span>, and select the stored secret version.
        </p>
        <p>
          Paperclip resolves the value server-side when the run starts and injects it as that env var. Project env
          applies to every task in the project and overrides agent env on matching keys.
        </p>
      </div>
    </div>
  );
}

function SecretsFiltersPopover({
  statusFilter,
  providerFilter,
  providedByFilter,
  providers,
  activeFilterCount,
  onStatusChange,
  onProviderChange,
  onProvidedByChange,
}: {
  statusFilter: SecretStatus | "all";
  providerFilter: SecretProvider | "all";
  providedByFilter: ProvidedByFilter;
  providers: SecretProviderDescriptor[];
  activeFilterCount: number;
  onStatusChange: (value: SecretStatus | "all") => void;
  onProviderChange: (value: SecretProvider | "all") => void;
  onProvidedByChange: (value: ProvidedByFilter) => void;
}) {
  const resetFilters = () => {
    onStatusChange("active");
    onProviderChange("all");
    onProvidedByChange("all");
  };

  const statusOptions: Array<{ value: SecretStatus | "all"; label: string }> = [
    { value: "active", label: "Active" },
    { value: "all", label: "All statuses" },
    { value: "disabled", label: "Disabled" },
    { value: "archived", label: "Archived" },
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className={cn("relative h-8 w-8 shrink-0", activeFilterCount > 0 && "text-blue-600 dark:text-blue-400")}
          title={activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}
        >
          <Filter className="h-3.5 w-3.5" />
          {activeFilterCount > 0 ? (
            <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white">
              {activeFilterCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(520px,calc(100vw-2rem))] max-h-[min(80vh,34rem)] overflow-y-auto overscroll-contain p-0"
      >
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Filters</span>
            {activeFilterCount > 0 ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={resetFilters}
              >
                <X className="h-3 w-3" />
                Clear
              </button>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Status</span>
              <div className="space-y-0.5">
                {statusOptions.map((option) => (
                  <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                    <Checkbox
                      checked={statusFilter === option.value}
                      onCheckedChange={() => onStatusChange(option.value)}
                    />
                    <span className="text-sm">{option.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Provided by</span>
              <div className="space-y-0.5">
                {[
                  { value: "all" as const, label: "All sources" },
                  { value: "company" as const, label: "Company" },
                  { value: "user" as const, label: "Each user" },
                ].map((option) => (
                  <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                    <Checkbox
                      checked={providedByFilter === option.value}
                      onCheckedChange={() => onProvidedByChange(option.value)}
                    />
                    <span className="text-sm">{option.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Provider</span>
              <div className="max-h-48 space-y-0.5 overflow-y-auto pr-1">
                <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                  <Checkbox
                    checked={providerFilter === "all"}
                    onCheckedChange={() => onProviderChange("all")}
                  />
                  <span className="text-sm">All providers</span>
                </label>
                {providers.map((provider) => (
                  <label key={provider.id} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                    <Checkbox
                      checked={providerFilter === provider.id}
                      onCheckedChange={() => onProviderChange(provider.id)}
                    />
                    <span className="text-sm">{provider.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function providerConfigStatusTone(status: SecretProviderConfigStatus) {
  switch (status) {
    case "ready":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "warning":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "coming_soon":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "disabled":
      return "border-muted bg-muted text-muted-foreground";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function providerFamilyIcon(provider: SecretProvider) {
  switch (provider) {
    case "local_encrypted":
      return Database;
    case "aws_secrets_manager":
      return Cloud;
    case "gcp_secret_manager":
      return ShieldCheck;
    case "vault":
      return KeyRound;
    default:
      return KeyRound;
  }
}

function ProviderVaultInlineWarning({ config }: { config: CompanySecretProviderConfig }) {
  const blockReason = getProviderConfigBlockReason(config);
  const message = blockReason ?? config.healthMessage;
  if (!message) {
    return (
      <p className="mt-1 text-[11px] text-muted-foreground">
        {config.isDefault ? "Default vault" : "Vault"} · {config.status.replace("_", " ")}
      </p>
    );
  }
  const warning = config.status === "warning" || config.healthStatus === "warning";
  return (
    <p className={cn("mt-1 flex items-center gap-1 text-[11px]", warning ? "text-amber-600 dark:text-amber-400" : "text-destructive")}>
      {warning ? <AlertTriangle className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
      {message}
    </p>
  );
}

interface ImportFromVaultButtonProps {
  providerConfigs: CompanySecretProviderConfig[];
  onClick: () => void;
  onManageVaults: () => void;
  className?: string;
}

function ImportFromVaultButton({
  providerConfigs,
  onClick,
  onManageVaults,
  className,
}: ImportFromVaultButtonProps) {
  const awsConfigs = providerConfigs.filter(
    (config) => config.provider === "aws_secrets_manager",
  );
  const eligible = awsConfigs.filter(
    (config) => config.status === "ready" || config.status === "warning",
  );

  if (awsConfigs.length === 0) return null;

  if (eligible.length === 0) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={onManageVaults}
        className={cn("text-xs text-muted-foreground", className)}
        title="Configure an AWS provider vault to enable remote import"
      >
        <Cloud className="h-3.5 w-3.5 mr-1" /> AWS vault disabled — manage
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className={className}
      data-testid="import-from-vault-button"
    >
      <Cloud className="h-3.5 w-3.5 mr-1" /> Import from vault
    </Button>
  );
}

export function ProviderVaultsTab({
  providers,
  providerConfigs,
  loading,
  error,
  onRetry,
  onCreate,
  onEdit,
  onDisable,
  onRemove,
  onSetDefault,
  onHealthCheck,
  onImportSecrets,
  pendingActionId,
}: {
  providers: SecretProviderDescriptor[];
  providerConfigs: CompanySecretProviderConfig[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onCreate: (provider: SecretProvider) => void;
  onEdit: (config: CompanySecretProviderConfig) => void;
  onDisable: (config: CompanySecretProviderConfig) => void;
  onRemove: (config: CompanySecretProviderConfig) => void;
  onSetDefault: (config: CompanySecretProviderConfig) => void;
  onHealthCheck: (config: CompanySecretProviderConfig) => void;
  onImportSecrets: (config: CompanySecretProviderConfig) => void;
  pendingActionId: string | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading provider vaults
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-4 text-sm text-destructive flex items-center gap-2">
        <AlertCircle className="h-4 w-4" /> Failed to load provider vaults: {(error as Error).message}
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const providerRows = PROVIDER_ORDER.map((providerId) => ({
    id: providerId,
    provider: providerMap.get(providerId),
    Icon: providerFamilyIcon(providerId),
    isComingSoonFamily: providerId === "gcp_secret_manager" || providerId === "vault",
    configs: providerConfigs.filter((config) => config.provider === providerId),
  }));

  return (
    <div className="flex min-h-full gap-6">
      <aside className="hidden w-56 shrink-0 md:block">
        <nav className="sticky top-0 space-y-1">
          {providerRows.map(({ id, provider, Icon }) => (
            <a
              key={id}
              href={`#provider-vaults-${id}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            >
              <Icon className="h-4 w-4" />
              <span className="truncate">{provider?.label ?? id.replaceAll("_", " ")}</span>
            </a>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1 space-y-6">
        {providerRows.map(({ id, provider, Icon, isComingSoonFamily, configs }) => (
          <section key={id} id={`provider-vaults-${id}`} className={cn("scroll-mt-6 space-y-2", isComingSoonFamily && "opacity-50")}>
            <div className="flex flex-wrap items-center gap-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">{provider?.label ?? id.replaceAll("_", " ")}</h2>
              {isComingSoonFamily ? (
                <span className="ml-auto text-xs text-muted-foreground">Coming soon</span>
              ) : (
                <Button variant="outline" size="sm" className="ml-auto" onClick={() => onCreate(id)}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add vault
                </Button>
              )}
            </div>
            {configs.length === 0 ? (
              <div className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
                {isComingSoonFamily
                  ? "Not yet supported."
                  : "No company-specific vaults yet. Secrets can still use the deployment default provider settings."}
              </div>
            ) : (
              <div className="space-y-3">
                {configs.map((config) => (
                  <ProviderVaultCard
                    key={config.id}
                    config={config}
                    pending={pendingActionId === config.id}
                    onEdit={() => onEdit(config)}
                    onDisable={() => onDisable(config)}
                    onRemove={() => onRemove(config)}
                    onSetDefault={() => onSetDefault(config)}
                    onHealthCheck={() => onHealthCheck(config)}
                    onImportSecrets={() => onImportSecrets(config)}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function ProviderVaultCard({
  config,
  pending,
  onEdit,
  onDisable,
  onRemove,
  onSetDefault,
  onHealthCheck,
  onImportSecrets,
}: {
  config: CompanySecretProviderConfig;
  pending: boolean;
  onEdit: () => void;
  onDisable: () => void;
  onRemove: () => void;
  onSetDefault: () => void;
  onHealthCheck: () => void;
  onImportSecrets: () => void;
}) {
  const blockReason = getProviderConfigBlockReason(config);
  const details = config.healthDetails;
  return (
    <div className="rounded-md border border-border bg-background p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium leading-snug">{config.displayName}</h3>
            {config.isDefault ? (
              <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                <Star className="h-3 w-3 fill-current" />
                Default
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn("font-medium", providerConfigStatusTone(config.status))}>
              {config.status.replace("_", " ")}
            </Badge>
            {config.healthStatus ? (
              <span className="text-xs text-muted-foreground">
                Health {config.healthStatus.replace("_", " ")} · {formatRelative(config.healthCheckedAt)}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">Health not checked</span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Edit3 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {config.healthMessage || blockReason ? (
        <div className={cn("mt-3 rounded-md p-2 text-xs", blockReason ? "bg-destructive/5 text-destructive" : "bg-muted/40 text-muted-foreground")}>
          {blockReason ?? config.healthMessage}
          {details?.guidance?.length ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {details.guidance.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onHealthCheck} disabled={pending}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
          Check health
        </Button>
        {config.provider === "aws_secrets_manager" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onImportSecrets}
            disabled={pending || Boolean(blockReason)}
            title={
              blockReason
                ? blockReason
                : "Refresh AWS metadata and import existing secrets"
            }
            data-testid={`provider-vault-refresh-secrets-${config.id}`}
          >
            <Cloud className="h-3.5 w-3.5 mr-1" />
            Refresh secrets
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          onClick={onSetDefault}
          disabled={pending || Boolean(blockReason) || config.isDefault}
        >
          <Star className="h-3.5 w-3.5 mr-1" />
          Make default
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onDisable}
          disabled={pending || config.status === "disabled"}
        >
          <Ban className="h-3.5 w-3.5 mr-1" />
          Disable
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onRemove}
          disabled={pending}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1" />
          Remove
        </Button>
      </div>
    </div>
  );
}

function ProviderVaultFields({
  form,
  onChange,
}: {
  form: ProviderVaultForm;
  onChange: React.Dispatch<React.SetStateAction<ProviderVaultForm>>;
}) {
  const setField = (key: keyof ProviderVaultForm, value: string | boolean) => {
    onChange((current) => ({ ...current, [key]: value }));
  };

  if (form.provider === "local_encrypted") {
    return (
      <label className="flex items-start gap-2 rounded-md border border-border bg-muted/20 p-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-border"
          checked={form.backupReminderAcknowledged}
          onChange={(event) => setField("backupReminderAcknowledged", event.target.checked)}
        />
        <span>
          I understand backup and restore require both the database metadata and the local encrypted master key file.
        </span>
      </label>
    );
  }

  if (form.provider === "aws_secrets_manager") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="AWS region" value={form.region} onChange={(value) => setField("region", value)} placeholder="us-east-1" required />
        <TextField label="Namespace" value={form.namespace} onChange={(value) => setField("namespace", value)} placeholder="production" />
        <TextField label="Secret name prefix" value={form.secretNamePrefix} onChange={(value) => setField("secretNamePrefix", value)} placeholder="paperclip" />
        <TextField label="KMS key id" value={form.kmsKeyId} onChange={(value) => setField("kmsKeyId", value)} placeholder="alias/paperclip-secrets" />
        <TextField label="Owner tag" value={form.ownerTag} onChange={(value) => setField("ownerTag", value)} placeholder="platform" />
        <TextField label="Environment tag" value={form.environmentTag} onChange={(value) => setField("environmentTag", value)} placeholder="prod" />
      </div>
    );
  }

  if (form.provider === "gcp_secret_manager") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Project id" value={form.projectId} onChange={(value) => setField("projectId", value)} placeholder="paperclip-prod" />
        <TextField label="Location" value={form.location} onChange={(value) => setField("location", value)} placeholder="global" />
        <TextField label="Namespace" value={form.namespace} onChange={(value) => setField("namespace", value)} placeholder="production" />
        <TextField label="Secret name prefix" value={form.secretNamePrefix} onChange={(value) => setField("secretNamePrefix", value)} placeholder="paperclip" />
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField label="Address" value={form.address} onChange={(value) => setField("address", value)} placeholder="https://vault.example.com" />
      <TextField label="Namespace" value={form.namespace} onChange={(value) => setField("namespace", value)} placeholder="admin" />
      <TextField label="Mount path" value={form.mountPath} onChange={(value) => setField("mountPath", value)} placeholder="secret" />
      <TextField label="Secret path prefix" value={form.secretPathPrefix} onChange={(value) => setField("secretPathPrefix", value)} placeholder="paperclip/prod" />
    </div>
  );
}

function AwsProviderVaultDiscoveryPanel({
  form,
  preview,
  error,
  loading,
  onDiscover,
  onApply,
}: {
  form: ProviderVaultForm;
  preview: SecretProviderConfigDiscoveryPreviewResult | null;
  error: unknown | null;
  loading: boolean;
  onDiscover: () => void;
  onApply: (candidate: SecretProviderConfigDiscoveryCandidate) => void;
}) {
  const canDiscover = Boolean(form.region.trim());
  const warnings = preview?.warnings ?? [];

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">AWS discovery</p>
          <p className="text-xs text-muted-foreground">
            Uses the current draft routing fields to inspect AWS Secrets Manager metadata. Values are not read.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onDiscover}
          disabled={!canDiscover || loading}
          data-testid="aws-vault-discovery-button"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
          ) : (
            <Search className="h-3.5 w-3.5 mr-1" />
          )}
          Find existing AWS values
        </Button>
      </div>

      {!canDiscover ? (
        <p className="text-xs text-muted-foreground">Enter an AWS region before discovery.</p>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Searching AWS Secrets Manager metadata
        </div>
      ) : null}

      {error ? (
        <AwsProviderVaultDiscoveryError form={form} error={error} />
      ) : null}

      {warnings.length > 0 ? (
        <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
          {warnings.map((warning) => (
            <div key={warning} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      ) : null}

      {preview && preview.candidates.length === 0 && !loading ? (
        <div className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          No AWS vault metadata candidates found. Manual entry is still available.
        </div>
      ) : null}

      {preview && preview.candidates.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Database className="h-3.5 w-3.5" />
            <span>
              {preview.candidates.length} candidate{preview.candidates.length === 1 ? "" : "s"} from{" "}
              {preview.sampledSecretCount} sampled secret{preview.sampledSecretCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="space-y-2" data-testid="aws-vault-discovery-candidates">
            {preview.candidates.map((candidate, index) => (
              <AwsProviderVaultDiscoveryCandidateRow
                key={`${candidate.displayName}-${index}`}
                candidate={candidate}
                onApply={() => onApply(candidate)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AwsProviderVaultDiscoveryError({
  form,
  error,
}: {
  form: ProviderVaultForm;
  error: unknown;
}) {
  const details = apiErrorDetails(error);
  const isAccessDenied = isAwsDiscoveryAccessDenied(error);
  const region = (details?.region ?? form.region.trim()) || "unspecified";
  const message = readableErrorMessage(error);
  const safeDetails = {
    message,
    status: error instanceof ApiError ? error.status : undefined,
    provider: details?.provider ?? form.provider,
    operation: details?.operation ?? "secret_provider_config.discovery.preview",
    providerVaultContext: details?.providerVaultContext ?? "draft_config",
    region,
    code: details?.code,
    requiredCapability: details?.requiredCapability,
    credentialPath: details?.credentialPath,
    safeAlternative: details?.safeAlternative,
  };
  const detailsText = JSON.stringify(safeDetails, null, 2);

  const copyDetails = () => {
    void navigator.clipboard?.writeText(detailsText);
  };

  return (
    <div
      className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
      role="alert"
      data-testid="aws-vault-discovery-error"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="font-medium">
              {isAccessDenied ? "AWS discovery needs ListSecrets permission" : "AWS discovery failed"}
            </p>
            <p className="mt-1 leading-relaxed text-destructive/85">
              {isAccessDenied
                ? details?.actionableMessage ??
                  "Discovery needs secretsmanager:ListSecrets in the selected region for the Paperclip server runtime/provider credential path."
                : message}
            </p>
          </div>
          {isAccessDenied ? (
            <p className="leading-relaxed text-destructive/85">
              {details?.safeAlternative ??
                "If you already know the exact AWS Secrets Manager ARN, paste/link that ARN instead of using discovery. Exact-resource DescribeSecret and runtime read permissions are still required."}
            </p>
          ) : null}
          <dl className="grid gap-1 text-destructive/80 sm:grid-cols-2">
            <div>
              <dt className="font-medium">Region</dt>
              <dd>{region}</dd>
            </div>
            <div>
              <dt className="font-medium">Operation</dt>
              <dd>{details?.operation ?? "secret_provider_config.discovery.preview"}</dd>
            </div>
            <div>
              <dt className="font-medium">Provider</dt>
              <dd>{details?.provider ?? "aws_secrets_manager"}</dd>
            </div>
            <div>
              <dt className="font-medium">Vault context</dt>
              <dd>{details?.providerVaultContext ?? "draft_config"}</dd>
            </div>
          </dl>
          <div className="rounded-md border border-destructive/20 bg-background/70 p-2 text-foreground">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-medium text-muted-foreground">Safe request/error details</span>
              <Button type="button" variant="ghost" size="sm" onClick={copyDetails}>
                Copy
              </Button>
            </div>
            <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
              {detailsText}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function AwsProviderVaultDiscoveryCandidateRow({
  candidate,
  onApply,
}: {
  candidate: SecretProviderConfigDiscoveryCandidate;
  onApply: () => void;
}) {
  const fieldSummary = [
    providerConfigValue(candidate.config, "region"),
    providerConfigValue(candidate.config, "namespace"),
    providerConfigValue(candidate.config, "secretNamePrefix"),
  ].filter(Boolean);

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium leading-snug">{candidate.displayName}</p>
            <span className="text-xs text-muted-foreground">
              {candidate.sampleCount} sample{candidate.sampleCount === 1 ? "" : "s"}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {fieldSummary.length > 0 ? fieldSummary.join(" / ") : "No stable namespace or prefix detected"}
          </p>
          {candidate.samples[0] ? (
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {candidate.samples[0].name}
            </p>
          ) : null}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onApply}>
          Use values
        </Button>
      </div>
      {candidate.warnings.length > 0 ? (
        <div className="mt-2 space-y-1 text-xs text-amber-700 dark:text-amber-300">
          {candidate.warnings.map((warning) => (
            <div key={warning} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const id = `provider-vault-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div>
      <label className="text-xs font-medium" htmlFor={id}>
        {label}
        {required ? null : <span className="text-muted-foreground/70"> (optional)</span>}
      </label>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </div>
  );
}

function CoverageInline({
  companyId,
  definitionId,
  compact = false,
}: {
  companyId: string;
  definitionId: string;
  compact?: boolean;
}) {
  const coverageQuery = useQuery({
    queryKey: queryKeys.secrets.userDefinitionCoverage(companyId, definitionId),
    queryFn: () => secretsApi.userSecretDefinitionCoverage(companyId, definitionId),
    staleTime: 30_000,
  });
  const summary = coverageQuery.data;
  if (coverageQuery.isPending) return <span className="text-muted-foreground">Loading…</span>;
  if (coverageQuery.isError) return <span className="text-destructive">Coverage unavailable</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
      <Users className="h-3 w-3" />
      <span className="truncate">
        {compact && summary
          ? `${summary.configuredCount}/${summary.configuredCount + summary.missingCount + summary.inactiveCount} set`
          : coverageSummaryLabel(summary)}
      </span>
      {summary && summary.missingCount > 0 ? (
        <span className="shrink-0 text-amber-600 dark:text-amber-400">
          · {compact ? `${summary.missingCount} miss` : `${summary.missingCount} missing`}
        </span>
      ) : null}
    </span>
  );
}

function UserSecretDetailsTab({
  companyId,
  definition,
  onViewCoverage,
}: {
  companyId: string;
  definition: UserSecretDefinition;
  onViewCoverage: () => void;
}) {
  return (
    <dl className="divide-y divide-border/60 text-xs">
      <DetailRow label="Description">
        <span>{definition.description ?? <span className="text-muted-foreground">—</span>}</span>
      </DetailRow>
      <DetailRow label="Provided by">Each user</DetailRow>
      <DetailRow label="Key">
        <code>{definition.key}</code>
      </DetailRow>
      <DetailRow label="Status"><StatusBadge status={definition.status} /></DetailRow>
      <DetailRow label="Coverage">
        <button
          type="button"
          className="inline-flex min-w-0 items-center gap-1 text-left text-primary hover:underline"
          onClick={onViewCoverage}
        >
          <CoverageInline companyId={companyId} definitionId={definition.id} />
          <span className="shrink-0 text-muted-foreground">· View in Coverage</span>
        </button>
      </DetailRow>
      <DetailRow label="Created">{formatRelative(definition.createdAt)}</DetailRow>
      <DetailRow label="Updated">{formatRelative(definition.updatedAt)}</DetailRow>
      <DetailRow label="Usage guidance">
        {definition.usageGuidance ?? <span className="text-muted-foreground">—</span>}
      </DetailRow>
      <div className="mt-3 rounded-md border border-violet-500/30 bg-violet-500/5 p-2 text-[11px] text-violet-800 dark:text-violet-200">
        No value is stored on this admin row. Each member manages their own value under My secrets.
      </div>
    </dl>
  );
}

function UserSecretCoverageTab({
  companyId,
  definitionId,
}: {
  companyId: string;
  definitionId: string;
}) {
  const coverageQuery = useQuery({
    queryKey: queryKeys.secrets.userDefinitionCoverage(companyId, definitionId),
    queryFn: () => secretsApi.userSecretDefinitionCoverage(companyId, definitionId),
    staleTime: 30_000,
  });
  if (coverageQuery.isPending) {
    return <div className="py-6 text-center text-xs text-muted-foreground">Loading…</div>;
  }
  if (coverageQuery.isError) {
    return <div className="py-6 text-center text-xs text-destructive">Coverage unavailable.</div>;
  }
  const summary: UserSecretCoverageSummary = coverageQuery.data;
  const total = summary.configuredCount + summary.missingCount + summary.inactiveCount;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5" />
        <span>{coverageSummaryLabel(summary)}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="text-lg font-semibold text-emerald-700 dark:text-emerald-300">
            {summary.configuredCount}
          </div>
          <div className="text-muted-foreground">Set</div>
        </div>
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="text-lg font-semibold text-amber-700 dark:text-amber-300">
            {summary.missingCount}
          </div>
          <div className="text-muted-foreground">Missing</div>
        </div>
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <div className="text-lg font-semibold text-muted-foreground">
            {summary.inactiveCount}
          </div>
          <div className="text-muted-foreground">Inactive</div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Coverage is counts only across {total} member{total === 1 ? "" : "s"}. Secret values are never shown here.
      </p>
    </div>
  );
}

function UserSecretUsageTab({ definition }: { definition: UserSecretDefinition }) {
  return (
    <div className="space-y-3 text-xs text-muted-foreground">
      <div className="rounded-md border border-border bg-muted/20 p-3">
        Bind runtime environment variables to this user-provided secret by choosing{" "}
        <span className="font-medium text-foreground">User secret</span> and selecting{" "}
        <code className="font-mono">{definition.key}</code>.
      </div>
      {definition.usageGuidance ? (
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Member guidance</p>
          <p className="text-foreground">{definition.usageGuidance}</p>
        </div>
      ) : null}
    </div>
  );
}

function UserSecretAccessEventsTab() {
  return (
    <div className="py-6 text-center text-xs text-muted-foreground">
      Access events are recorded on each member&apos;s stored value when runtime resolution occurs.
    </div>
  );
}

function SecretDetailsTab({
  secret,
  providers,
  providerConfigs,
  onViewUsage,
}: {
  secret: CompanySecret;
  providers: SecretProviderDescriptor[];
  providerConfigs: CompanySecretProviderConfig[];
  onViewUsage: () => void;
}) {
  const bindingLabel = (secret.referenceCount ?? 0) === 1
    ? "1 binding"
    : `${secret.referenceCount ?? 0} bindings`;

  return (
    <dl className="divide-y divide-border/60 text-xs">
      <DetailRow label="Description">
        <span>{secret.description ?? <span className="text-muted-foreground">—</span>}</span>
      </DetailRow>
      <DetailRow label="Provided by">Company</DetailRow>
      <DetailRow label="Custody">{modeLabel(secret.managedMode)}</DetailRow>
      <DetailRow label="Provider">{providerLabel(providers, secret.provider)}</DetailRow>
      <DetailRow label="Provider vault">{providerVaultLabel(providerConfigs, secret.providerConfigId)}</DetailRow>
      <DetailRow label="External ARN">
        {secret.externalRef ? (
          <span className="break-all font-mono">{secret.externalRef}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </DetailRow>
      <DetailRow label="Latest version">v{secret.latestVersion}</DetailRow>
      <DetailRow label="References">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-left text-primary hover:underline"
          onClick={onViewUsage}
        >
          {bindingLabel}
          <span className="text-muted-foreground">· View in Usage</span>
        </button>
      </DetailRow>
      <DetailRow label="Created">{formatRelative(secret.createdAt)}</DetailRow>
      <DetailRow label="Updated">{formatRelative(secret.updatedAt)}</DetailRow>
      <DetailRow label="Last rotated">{formatRelative(secret.lastRotatedAt)}</DetailRow>
      <DetailRow label="Last resolved">{formatRelative(secret.lastResolvedAt)}</DetailRow>
      <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-700 dark:text-amber-300">
        {modeDescription(secret.managedMode)} Paperclip never re-displays stored values.
      </div>
    </dl>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

function SecretUsageTab({ loading, bindings }: { loading: boolean; bindings: CompanySecretUsageBinding[] }) {
  if (loading) {
    return <div className="py-6 text-center text-xs text-muted-foreground">Loading…</div>;
  }
  if (bindings.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        No active bindings. Add this secret in agent, project, environment, or plugin config to start using it.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {bindings.map((binding) => (
        <div
          key={binding.id}
          className="rounded-md border border-border bg-muted/30 p-2 text-xs"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium capitalize">{binding.target.type}</span>
            <span className="font-mono text-muted-foreground">v{binding.versionSelector}</span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            {binding.target.href ? (
              <Link to={binding.target.href} className="truncate font-medium text-primary hover:underline">
                {binding.target.label}
              </Link>
            ) : (
              <span className="truncate font-medium">{binding.target.label}</span>
            )}
            {binding.target.status ? (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                {binding.target.status.replaceAll("_", " ")}
              </Badge>
            ) : null}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground break-all">
            {binding.targetId}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {binding.configPath} {binding.required ? "· required" : "· optional"}
          </div>
        </div>
      ))}
    </div>
  );
}

function SecretEventsTab({
  loading,
  events,
  companyId,
}: {
  loading: boolean;
  events: SecretAccessEvent[];
  companyId: string;
}) {
  // Resolve responsible/owner user ids to human names for user-scoped events.
  const anyUserScoped = events.some(
    (event) =>
      event.secretScope === "user" || event.responsibleUserId || event.credentialOwnerUserId,
  );
  const { data: directory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: anyUserScoped,
    staleTime: 60_000,
  });
  const userLabel = (userId: string | null): string => {
    if (!userId) return "—";
    const entry: CompanyUserDirectoryEntry | undefined = directory?.users.find(
      (u) => u.principalId === userId,
    );
    return entry?.user?.name?.trim() || entry?.user?.email?.trim() || `${userId.slice(0, 8)}…`;
  };

  if (loading) {
    return <div className="py-6 text-center text-xs text-muted-foreground">Loading…</div>;
  }
  if (events.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        No access events recorded yet. Each runtime resolution writes a redacted entry here.
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {events.map((event) => (
        <div key={event.id} className="rounded border border-border px-2 py-1.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 capitalize">
              {event.consumerType} · {event.outcome}
              {event.secretScope === "user" ? (
                <Badge
                  variant="outline"
                  className="border-violet-500/30 bg-violet-500/10 text-[10px] text-violet-700 dark:text-violet-300"
                >
                  User secret
                </Badge>
              ) : null}
            </span>
            <span className="text-[11px] text-muted-foreground">{formatRelative(event.createdAt)}</span>
          </div>
          <div className="font-mono text-[11px] text-muted-foreground break-all">
            {event.consumerId}
          </div>
          {event.responsibleUserId ? (
            <div className="text-[11px] text-muted-foreground">
              Responsible user: <span className="text-foreground">{userLabel(event.responsibleUserId)}</span>
            </div>
          ) : null}
          {event.credentialOwnerUserId &&
          event.credentialOwnerUserId !== event.responsibleUserId ? (
            <div className="text-[11px] text-muted-foreground">
              Credential owner: <span className="text-foreground">{userLabel(event.credentialOwnerUserId)}</span>
            </div>
          ) : null}
          {event.errorCode ? (
            <div className="text-[11px] text-destructive">{event.errorCode}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
