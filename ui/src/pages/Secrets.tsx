import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  ArchiveRestore,
  Archive,
  Ban,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CornerLeftUp,
  Copy,
  Database,
  Edit3,
  Eye,
  EyeOff,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderPlus,
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
import { Link, useSearchParams } from "react-router-dom";
import type {
  Agent,
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
import { hidesCompanySection } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useHiddenSettings } from "../hooks/useHiddenSettings";
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
import { agentsApi } from "../api/agents";
import { envKeyFromSecretName } from "../components/environment-variables-editor/model";
import {
  AGENT_ACCESS_CONFIG_PATH_PREFIX,
  aliasFromConfigPath,
  consumerTypeLabel,
  deliveryModeForConfigPath,
  deliveryModeLabel,
} from "../lib/secret-delivery";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
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
import { useCopyAction } from "../lib/use-copy-action";
import { PageTabBar } from "../components/PageTabBar";
import { AgentMultiSelect, AgentSelect } from "../components/AgentMultiSelect";
import { AgentAvatar } from "../components/AgentAvatar";
import { RadioCardGroup } from "@/components/ui/radio-card";
import {
  ENV_KEY_PATTERN,
  apiAliasesReferencingSecret,
  buildSecretAgentUsage,
  envKeysReferencingSecret,
  grantAgentSecretAccess,
  revokeAgentSecretAccess,
  type AgentAccessReference,
} from "./secrets/agent-secret-access";
import {
  SECRET_ORIGIN_GROUPS,
  classifySecretOrigin,
  managedSecretLabel,
  type SecretOrigin,
} from "./secrets/secret-origin";
import { HowSecretsWork, ManagedSecretGroup, SecretProvidedBy, SecretUsedBy } from "./secrets/secret-list-parts";
import { ImportFromVaultDialog } from "./secrets/ImportFromVaultDialog";
import { MyUserSecretsTab } from "./secrets/MyUserSecretsTab";
import { ProposalsTab } from "./secrets/ProposalsTab";
import { SecretPathName } from "./secrets/SecretPathName";
import {
  buildSecretPathBreadcrumbs,
  buildSecretPathListing,
  getSecretPathRowName,
  normalizeSecretPath,
  splitSecretPath,
  validateSecretFolderSegment,
  type SecretPathFolder,
} from "./secrets/secret-path";
import { SetMyUserSecretDialog } from "./secrets/SetMyUserSecretDialog";
import {
  coverageSummaryLabel,
  UserSecretChip,
} from "./secrets/user-secret-presentation";
import type { MyUserSecretEntry } from "../api/secrets";
import { describeError } from "@/api/errors";

type CreateMode = "managed" | "external";
// "value" writes a new secret value (for external references: through to the
// provider); "reference" re-points an external reference without writing.
type RotateMode = "value" | "reference";
type SecretValueProvider = "company" | "user";
type ProvidedByFilter = "all" | SecretValueProvider;
type SecretsTab = "secrets" | "my-secrets" | "vaults" | "proposals";
/** "current" is everything still in play: active and disabled, not archived. */
type SecretStatusFilter = "current" | "disabled" | "archived";

/** The last segment of a slash-delimited secret name: what the secret is called inside its folder. */
function secretLeafName(name: string): string {
  return splitSecretPath(name).at(-1) ?? name;
}

/** "12 secrets · 3 folders" — folder part omitted when there are no subfolders. */
function formatSecretPathCounts(secretCount: number, folderCount: number): string {
  const parts = [`${secretCount} ${secretCount === 1 ? "secret" : "secrets"}`];
  if (folderCount > 0) {
    parts.push(`${folderCount} ${folderCount === 1 ? "folder" : "folders"}`);
  }
  return parts.join(" · ");
}

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
const EMPTY_AGENTS: Agent[] = [];
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
  return describeError(error).body;
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

/** The provider as a person would name it: Paperclip's own storage is not "local encrypted". */
function vaultKindLabel(providers: SecretProviderDescriptor[] | undefined, id: SecretProvider) {
  return id === "local_encrypted" ? "Paperclip-encrypted" : providerLabel(providers, id);
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

function modeDescription(managedMode: SecretManagedMode, canWriteExternalValue = false) {
  if (managedMode === "paperclip_managed") {
    return "Paperclip owns create and rotation writes for this provider secret.";
  }
  return canWriteExternalValue
    ? "Paperclip resolves this provider reference and can write new values to it via Update value."
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
    <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-(length:--text-micro) text-muted-foreground">
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
    const deploymentMessage = `${provider.label} is not set up on this Paperclip server.`;
    const nextStep = " Choose a vault that is ready, or ask your administrator to set it up.";
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

function detailString(details: Record<string, unknown> | undefined, key: string) {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getProviderConfigBlockReason(
  config: CompanySecretProviderConfig | null | undefined,
) {
  if (!config) return null;
  if (config.status === "disabled") return "This vault is disabled.";
  if (config.status === "coming_soon") return "Paperclip can't store or read secrets in this vault yet.";
  if (config.healthStatus === "error") {
    return config.healthMessage ?? "Paperclip couldn't reach this vault.";
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

export interface CreateVaultOption {
  value: string;
  provider: SecretProvider;
  providerConfigId: string;
  label: string;
  blockReason: string | null;
}

export function createVaultOptionValue(provider: SecretProvider, providerConfigId: string) {
  return `${provider}:${providerConfigId}`;
}

/**
 * Every place a new secret can be stored, as one list: each provider's
 * built-in storage plus each vault the organization connected. The dialog
 * shows a picker only when this has more than one entry.
 */
export function buildCreateVaultOptions(input: {
  providers: SecretProviderDescriptor[];
  providerConfigs: CompanySecretProviderConfig[];
  mode: CreateMode;
  health: SecretProviderHealthResponse | null;
}): CreateVaultOption[] {
  const options: CreateVaultOption[] = [];
  const defaultLocalConfigId = getSelectableProviderConfig(input.providerConfigs, "local_encrypted")?.id ?? "";
  for (const provider of input.providers) {
    const builtInBlockReason = getCreateProviderBlockReason(provider, input.mode, input.health, null);
    // Once a provider has a usable vault, new secrets for it always go to a
    // vault, so its built-in storage is not a choice the form can honor.
    const hasUsableVault = Boolean(getSelectableProviderConfig(input.providerConfigs, provider.id));
    if (!hasUsableVault && (provider.id === "local_encrypted" || !builtInBlockReason)) {
      options.push({
        value: createVaultOptionValue(provider.id, ""),
        provider: provider.id,
        providerConfigId: "",
        label:
          provider.id === "local_encrypted"
            ? `Paperclip${defaultLocalConfigId ? "" : " (default)"}`
            : provider.label,
        blockReason: builtInBlockReason,
      });
    }
    for (const config of input.providerConfigs) {
      if (config.provider !== provider.id || config.status === "disabled" || config.status === "coming_soon") continue;
      options.push({
        value: createVaultOptionValue(provider.id, config.id),
        provider: provider.id,
        providerConfigId: config.id,
        label: `${config.displayName} · ${vaultKindLabel(input.providers, provider.id)}${config.id === defaultLocalConfigId ? " (default)" : ""}`,
        blockReason:
          getProviderConfigBlockReason(config) ??
          getCreateProviderBlockReason(provider, input.mode, input.health, config),
      });
    }
  }
  return options;
}

/** Splits a pasted `NAME=value` (optionally `export NAME="value"`) into its two halves. */
export function parseEnvAssignment(text: string): { name: string; value: string } | null {
  const lines = text.trim().split("\n");
  if (lines.length !== 1) return null;
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(lines[0].trim());
  if (!match) return null;
  const value = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  return value ? { name: match[1], value } : null;
}

function providerVaultLabel(configs: CompanySecretProviderConfig[], id: string | null | undefined) {
  if (!id) return "Paperclip's default";
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
  // Operator-hidden sub-tabs (UI-only; the secrets APIs stay live for agents).
  const { hidden: hiddenSettings } = useHiddenSettings();
  const hideVaultsTab = hidesCompanySection(hiddenSettings, "company.secrets.vaults");
  const hideProposalsTab = hidesCompanySection(hiddenSettings, "company.secrets.proposals");
  useEffect(() => {
    if ((activeTab === "vaults" && hideVaultsTab) || (activeTab === "proposals" && hideProposalsTab)) {
      setActiveTab("secrets");
    }
  }, [activeTab, hideVaultsTab, hideProposalsTab]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SecretStatusFilter>("current");
  const [managedOpen, setManagedOpen] = useState(false);
  const [openManagedGroups, setOpenManagedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [providerFilter, setProviderFilter] = useState<SecretProvider | "all">("all");
  const [providedByFilter, setProvidedByFilter] = useState<ProvidedByFilter>("all");
  const [searchParams, setSearchParams] = useSearchParams();
  // The detail sheet is deep-linkable: `?secret=<id>` /
  // `?definition=<id>` are the source of truth for the current selection, so
  // every open secret has a shareable URL and Back closes the sheet.
  const selectedSecretId = searchParams.get("secret");
  const selectedDefinitionId = searchParams.get("definition");
  const setDetailSelection = useCallback(
    (secretId: string | null, definitionId: string | null = null) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (secretId) next.set("secret", secretId);
        else next.delete("secret");
        if (definitionId) next.set("definition", definitionId);
        else next.delete("definition");
        return next;
      });
    },
    [setSearchParams],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importInitialVaultId, setImportInitialVaultId] = useState<string | null>(null);
  const [secretValueProvider, setSecretValueProvider] = useState<SecretValueProvider>("company");
  const [createMode, setCreateMode] = useState<CreateMode>("managed");
  const [editingDefinition, setEditingDefinition] = useState<UserSecretDefinition | null>(null);
  const [createNamePrefix, setCreateNamePrefix] = useState<string | null>(null);
  const [createKeyDirty, setCreateKeyDirty] = useState(false);
  const [createAgentIds, setCreateAgentIds] = useState<Set<string>>(() => new Set());
  const [createValueVisible, setCreateValueVisible] = useState(false);
  const [createMoreOpen, setCreateMoreOpen] = useState(false);
  const [createAttempted, setCreateAttempted] = useState(false);
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
  const [createError, setCreateError] = useState<unknown>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateMode, setRotateMode] = useState<RotateMode>("value");
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
  const [vaultAttempted, setVaultAttempted] = useState(false);
  const [vaultAdvancedOpen, setVaultAdvancedOpen] = useState(false);
  const [vaultDiscovery, setVaultDiscovery] =
    useState<SecretProviderConfigDiscoveryPreviewResult | null>(null);
  const [vaultDiscoveryError, setVaultDiscoveryError] = useState<unknown | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);

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
  });

  const providerConfigsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.providerConfigs(selectedCompanyId)
      : ["secret-provider-configs", "__disabled__"],
    queryFn: () => secretsApi.providerConfigs(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const proposalsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.proposals(selectedCompanyId, "pending")
      : ["secret-proposals", "__disabled__"],
    queryFn: () => secretsApi.listProposals(selectedCompanyId!, "pending"),
    enabled: Boolean(selectedCompanyId) && !hideProposalsTab,
  });

  // One agents read answers "who uses this?" for every row and for the
  // details panel; the per-secret usage endpoint is only hit when one is open.
  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "__disabled__"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    staleTime: 30_000,
  });
  const agentUsage = useMemo(() => buildSecretAgentUsage(agentsQuery.data ?? EMPTY_AGENTS), [agentsQuery.data]);

  const secretsView = useQueryView(secretsQuery);
  const userDefinitionsView = useQueryView(userDefinitionsQuery);
  const providerConfigsView = useQueryView(providerConfigsQuery);
  const secretsListLoading =
    secretsQuery.isPending ||
    userDefinitionsQuery.isPending ||
    secretsView.kind === "reconnecting" ||
    userDefinitionsView.kind === "reconnecting";

  const secrets = secretsQuery.data ?? EMPTY_SECRETS;
  const userDefinitions = userDefinitionsQuery.data ?? EMPTY_USER_SECRET_DEFINITIONS;
  const pendingProposalCount = proposalsQuery.data?.length ?? 0;
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
  const selectedSecretAccessReference = useMemo<AgentAccessReference | null>(
    () => selectedSecret ? { kind: "company", secret: selectedSecret } : null,
    [selectedSecret],
  );
  const selectedDefinitionAccessReference = useMemo<AgentAccessReference | null>(
    () => selectedDefinition ? { kind: "user", definition: selectedDefinition } : null,
    [selectedDefinition],
  );
  const selectedDefinitionMyEntry = useMemo(() => {
    if (!selectedDefinition) return null;
    return myUserSecrets.find((entry) => entry.definition.id === selectedDefinition.id) ?? {
      definition: selectedDefinition,
      secret: null,
    };
  }, [myUserSecrets, selectedDefinition]);
  const selectedCreateProvider = useMemo(
    () => providers.find((provider) => provider.id === createForm.provider) ?? null,
    [providers, createForm.provider],
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
  const awsManagedPathPreview = getAwsManagedPathPreview({
    provider: selectedCreateProvider,
    health: providerHealthQuery.data ?? null,
    companyId: selectedCompanyId ?? "{companyId}",
    secretKeySource: createForm.key.trim() || createForm.name,
  });

  const createVaultOptions = useMemo(
    () =>
      buildCreateVaultOptions({
        providers,
        providerConfigs,
        mode: createMode,
        health: providerHealthQuery.data ?? null,
      }),
    [createMode, providerConfigs, providerHealthQuery.data, providers],
  );
  const createVaultValue = createVaultOptionValue(createForm.provider, createForm.providerConfigId);
  const createVaultLabel =
    createVaultOptions.find((option) => option.value === createVaultValue)?.label.replace(" (default)", "") ??
    vaultKindLabel(providers, createForm.provider);
  const createCanLink =
    createForm.provider !== "local_encrypted" &&
    selectedCreateProvider?.supportsExternalReferences !== false &&
    !createProviderBlockReason;
  const createLeafName = createNamePrefix ? createForm.name.slice(createNamePrefix.length) : createForm.name;
  // What an agent given access now will read: the user secret's own key, or
  // the company secret's name as an environment variable.
  const createEnvKey =
    secretValueProvider === "user" ? createForm.key.trim() : envKeyFromSecretName(secretLeafName(createForm.name));
  const createNameError = !createLeafName.trim() ? "Give the secret a name." : null;
  const createValueError =
    secretValueProvider !== "company"
      ? null
      : createMode === "managed"
        ? createForm.value
          ? null
          : "Paste the value to store."
        : createForm.externalRef.trim()
          ? null
          : "Paste the secret's ARN or path.";
  const createKeyError =
    secretValueProvider === "user" && !editingDefinition && !createForm.key.trim()
      ? "Add the environment variable name agents will read."
      : null;
  const createAccessError =
    createAgentIds.size > 0 && !ENV_KEY_PATTERN.test(createEnvKey)
      ? "Agents can only read names made of letters, digits and underscores that don't start with a digit. Rename the secret, or remove the agents and give access later."
      : null;
  const createBlocked = Boolean(
    createNameError ||
      createValueError ||
      createKeyError ||
      createAccessError ||
      (secretValueProvider === "company" && createProviderBlockReason),
  );
  function submitCreate() {
    setCreateAttempted(true);
    if (createKeyError) setCreateMoreOpen(true);
    if (createBlocked || createMutation.isPending) return;
    setCreateError(null);
    createMutation.mutate();
  }
  function setCreateName(name: string) {
    setCreateForm((current) => ({
      ...current,
      name,
      key: createKeyDirty
        ? current.key
        : secretValueProvider === "user"
          ? normalizeUserSecretKeyForPreview(name)
          : normalizeSecretKeyForPreview(name),
    }));
  }
  // Only the Name field splits a pasted NAME=value. A value can itself contain
  // "=" (base64 padding, connection strings), so a paste into Value is kept as is.
  function splitPastedAssignment(event: React.ClipboardEvent<HTMLInputElement>) {
    if (secretValueProvider !== "company" || createMode !== "managed" || editingDefinition) return;
    const pair = parseEnvAssignment(event.clipboardData.getData("text"));
    if (!pair) return;
    event.preventDefault();
    const name = `${createNamePrefix ?? ""}${pair.name}`;
    setCreateForm((current) => ({
      ...current,
      name,
      value: pair.value,
      key: createKeyDirty ? current.key : normalizeSecretKeyForPreview(name),
    }));
  }

  const vaultNameError = vaultForm.displayName.trim() ? null : "Give the vault a name your team will recognize.";
  const vaultRegionError =
    vaultForm.provider === "aws_secrets_manager" && !vaultForm.region.trim()
      ? "Enter the AWS region, such as us-east-1."
      : null;

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
      if (statusFilter === "current" ? status !== "active" && status !== "disabled" : status !== statusFilter) return false;
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
    (statusFilter === "current" ? 0 : 1) +
    (providerFilter === "all" ? 0 : 1) +
    (providedByFilter === "all" ? 0 : 1);

  // --- Folder view (PAP-14698) --------------------------------------------
  // Folders are derived purely from slash-delimited secret names; there is no
  // server-side folder record. `?path=` holds the normalized current folder
  // and is only meaningful on the main Secrets tab (inert on the others).
  const pathParam = normalizeSecretPath(searchParams.get("path") ?? "");
  const folderPath = activeTab === "secrets" ? pathParam : "";
  const searching = search.trim().length > 0;

  // Folders are always on; a search renders one flat result set across them.
  const showFolderView = !searching;

  const goToFolder = useCallback(
    (path: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const normalized = normalizeSecretPath(path);
          if (normalized) next.set("path", normalized);
          else next.delete("path");
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );

  function closeNewFolder() {
    setNewFolderOpen(false);
    setNewFolderName("");
    setNewFolderError(null);
  }

  function stageNewFolder() {
    const segment = newFolderName.trim();
    const error = validateSecretFolderSegment(segment);
    if (error) {
      setNewFolderError(error);
      return;
    }
    goToFolder(folderPath ? `${folderPath}/${segment}` : segment);
    closeNewFolder();
  }

  // Secrets Paperclip saved on someone's behalf (connections, sign-ins, …)
  // sit apart from the ones the team named, so the list a person manages is
  // not buried under tokens they never typed.
  const { teamRows, managedGroups, managedCount } = useMemo(() => {
    const team: UnifiedSecretRow[] = [];
    const byOrigin = new Map<SecretOrigin, UnifiedSecretRow[]>();
    for (const row of filteredRows) {
      const origin = classifySecretOrigin(row.kind === "company" ? row.secret : row.definition);
      if (origin === "team") {
        team.push(row);
        continue;
      }
      const group = byOrigin.get(origin);
      if (group) group.push(row);
      else byOrigin.set(origin, [row]);
    }
    const groups = SECRET_ORIGIN_GROUPS.flatMap((group) => {
      const rows = byOrigin.get(group.id);
      return rows ? [{ group, rows }] : [];
    });
    return { teamRows: team, managedGroups: groups, managedCount: filteredRows.length - team.length };
  }, [filteredRows]);

  const folderListing = useMemo(
    () => buildSecretPathListing(teamRows, folderPath),
    [teamRows, folderPath],
  );
  const breadcrumbs = useMemo(() => buildSecretPathBreadcrumbs(folderPath), [folderPath]);
  const parentFolderPath = useMemo(() => {
    const segments = folderPath ? folderPath.split("/") : [];
    return segments.slice(0, -1).join("/");
  }, [folderPath]);
  const currentFolderSecretCount =
    folderListing.secrets.length +
    folderListing.folders.reduce((total, folder) => total + folder.secretCount, 0);
  const folderRows = showFolderView ? folderListing.folders : [];
  const secretRows = showFolderView ? folderListing.secrets : teamRows;
  const showManagedSection = managedCount > 0 && (searching || !folderPath);
  const managedExpanded = managedOpen || searching;
  const showUpRow = showFolderView && folderPath.length > 0;

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

  // Agents are listed with their environment variable above; this is everything else.
  const otherSecretUses = useMemo(
    () => (usageQuery.data?.bindings ?? []).filter((binding) => binding.target.type !== "agent"),
    [usageQuery.data],
  );
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

  function resetCreateExtras() {
    setCreateAgentIds(new Set());
    setCreateValueVisible(false);
    setCreateMoreOpen(false);
    setCreateAttempted(false);
  }
  function openCreateSecret() {
    const prefix = folderPath ? `${folderPath}/` : null;
    setEditingDefinition(null);
    setCreateNamePrefix(prefix);
    setSecretValueProvider("company");
    setCreateMode("managed");
    setCreateKeyDirty(false);
    setCreateError(null);
    resetCreateExtras();
    setCreateForm({
      name: prefix ?? "",
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
    setCreateNamePrefix(null);
    setSecretValueProvider("user");
    setCreateMode("managed");
    setCreateKeyDirty(true);
    setCreateError(null);
    resetCreateExtras();
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
        return { kind: "user" as const, item: definition, action: "updated" as const, accessFailures: [] as string[] };
      }
      // Access is a second step on each chosen agent's own config. The secret
      // is already saved if one of them fails, so failures are reported, not thrown.
      const grantAccess = async (reference: AgentAccessReference, envKey: string) => {
        const results = await Promise.allSettled(
          [...createAgentIds].map((agentId) =>
            grantAgentSecretAccess({ companyId: selectedCompanyId!, agentId, envKey, reference }),
          ),
        );
        return results.flatMap((result) => (result.status === "rejected" ? [readableErrorMessage(result.reason)] : []));
      };
      if (secretValueProvider === "user") {
        const definition = await secretsApi.createUserSecretDefinition(selectedCompanyId!, {
          ...sharedDefinitionPayload,
          key: createForm.key.trim(),
          status: "active",
        });
        return {
          kind: "user" as const,
          item: definition,
          action: "created" as const,
          accessFailures: await grantAccess({ kind: "user", definition }, definition.key),
        };
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
      return {
        kind: "company" as const,
        item: secret,
        action: "created" as const,
        accessFailures: await grantAccess({ kind: "company", secret }, createEnvKey),
      };
    },
    onSuccess: (result) => {
      // A new secret opens in its details panel, which is the confirmation.
      if (result.action === "updated") {
        pushToast({ title: "Secret updated", body: result.item.name, tone: "success" });
      }
      if (result.accessFailures.length > 0) {
        pushToast({
          title: "Some agents were not given access",
          body: `${result.accessFailures.join(" ")} Add them from the secret's details.`,
          tone: "error",
        });
      }
      if (createAgentIds.size > 0 && selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
      }
      resetCreateExtras();
      setCreateOpen(false);
      setEditingDefinition(null);
      setCreateNamePrefix(null);
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
        setDetailSelection(result.item.id);
        invalidateAll([result.item.id]);
      } else {
        setDetailSelection(null, result.item.id);
        invalidateAll([result.item.id]);
      }
    },
    onError: (error) => {
      setCreateError(error);
    },
  });

  const rotateMutation = useMutation({
    mutationFn: () => {
      if (!selectedSecret) throw new Error("Select a secret first");
      if (selectedSecret.managedMode === "external_reference" && rotateMode === "reference") {
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
      pushToast({ title: "Value replaced", body: `${updated.name} is now on version ${updated.latestVersion}`, tone: "success" });
      setRotateOpen(false);
      setRotateValue("");
      setRotateExternalRef("");
      setRotateProviderConfigId("");
      setRotateError(null);
      invalidateAll([updated.id]);
    },
    onError: (error) => {
      setRotateError(describeError(error).body);
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
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  const definitionStatusMutation = useMutation({
    mutationFn: ({ definition, status }: { definition: UserSecretDefinition; status: SecretStatus }) =>
      secretsApi.updateUserSecretDefinition(selectedCompanyId!, definition.id, { status }),
    onSuccess: (updated) => {
      pushToast({ title: `Secret ${updated.status}`, body: updated.name, tone: "info" });
      invalidateAll([updated.id]);
    },
    onError: (error) => {
      pushToast({
        title: "Status update failed",
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => secretsApi.remove(id),
    onSuccess: (_response, id) => {
      pushToast({ title: "Secret deleted", tone: "info" });
      setDeleteConfirm(null);
      if (selectedSecretId === id) setDetailSelection(null);
      invalidateAll([id]);
    },
    onError: (error) => {
      pushToast({
        title: "Delete failed",
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  const deleteDefinitionMutation = useMutation({
    mutationFn: (definition: UserSecretDefinition) =>
      secretsApi.removeUserSecretDefinition(selectedCompanyId!, definition.id),
    onSuccess: (_response, definition) => {
      pushToast({ title: "Secret deleted", body: definition.name, tone: "info" });
      setDefinitionDeleteConfirm(null);
      if (selectedDefinitionId === definition.id) setDetailSelection(null);
      invalidateAll([definition.id]);
    },
    onError: (error) => {
      pushToast({
        title: "Delete failed",
        body: describeError(error).body,
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
      pushToast({ title: editingVault ? "Vault updated" : "Vault connected", body: saved.displayName, tone: "success" });
      // A new connection is only useful if it works: check it straight away so
      // the list shows a real result instead of "Not checked yet".
      if (!editingVault && saved.status !== "coming_soon") {
        void secretsApi
          .checkProviderConfigHealth(saved.id)
          .then((health) => {
            if (health.status === "error") {
              pushToast({ title: `${saved.displayName} can't be reached`, body: health.message, tone: "error" });
            }
          })
          .catch((error) => {
            pushToast({
              title: `Couldn't check ${saved.displayName}`,
              body: `${describeError(error).body} The vault is saved. Use Check connection in its menu to try again.`,
              tone: "error",
            });
          })
          .finally(() => invalidateAll());
      }
      setVaultDialogOpen(false);
      setEditingVault(null);
      setVaultForm(emptyProviderVaultForm());
      setVaultError(null);
      invalidateAll();
    },
    onError: (error) => {
      setVaultError(describeError(error).body);
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
      pushToast({ title: "Vault disabled", body: updated.displayName, tone: "info" });
      invalidateAll();
    },
    onError: (error) => {
      pushToast({
        title: "Disable failed",
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  const enableVaultMutation = useMutation({
    // Providers Paperclip can't use yet only accept their draft status back.
    mutationFn: (id: string) => {
      const provider = providerConfigs.find((config) => config.id === id)?.provider;
      return secretsApi.updateProviderConfig(id, {
        status: provider ? defaultProviderVaultStatus(provider) : "ready",
      });
    },
    onSuccess: (updated) => {
      pushToast({ title: "Vault enabled", body: updated.displayName, tone: "success" });
      invalidateAll();
    },
    onError: (error) => {
      pushToast({ title: "Enable failed", body: describeError(error).body, tone: "error" });
    },
  });
  const removeVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.removeProviderConfig(id),
    onSuccess: (removed) => {
      pushToast({
        title: "Vault removed",
        body: `${removed.displayName} was removed from Paperclip only.`,
        tone: "info",
      });
      setRemoveVaultConfirm(null);
      invalidateAll();
    },
    onError: (error) => {
      pushToast({
        title: "Remove failed",
        body: describeError(error).body,
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
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  const healthVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.checkProviderConfigHealth(id),
    onSuccess: (health) => {
      pushToast({
        title: health.status === "error" ? "The vault can't be reached" : "The vault is working",
        body: health.message,
        tone: health.status === "error" ? "error" : "info",
      });
      invalidateAll();
    },
    onError: (error) => {
      pushToast({
        title: "Health check failed",
        body: describeError(error).body,
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
    setVaultAttempted(false);
    setVaultAdvancedOpen(false);
    setVaultError(null);
    setVaultDiscovery(null);
    setVaultDiscoveryError(null);
    setVaultDialogOpen(true);
  }

  function openEditVault(config: CompanySecretProviderConfig) {
    setEditingVault(config);
    setVaultForm(providerVaultFormFromConfig(config));
    setVaultAttempted(false);
    setVaultAdvancedOpen(false);
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
    setDetailSelection(secret.id);
  }

  function openUserDefinition(definition: UserSecretDefinition) {
    setDetailSelection(null, definition.id);
  }

  function secretSupportsExternalValueWrite(secret: CompanySecret) {
    return (
      secret.managedMode === "external_reference" &&
      Boolean(secret.externalRef) &&
      Boolean(providers.find((provider) => provider.id === secret.provider)?.supportsExternalValueWrites)
    );
  }

  function rotateActionLabel(secret: CompanySecret) {
    return secret.managedMode === "external_reference" && !secretSupportsExternalValueWrite(secret)
      ? "Change reference"
      : "Replace value";
  }

  function openRotateSecret(secret: CompanySecret) {
    openCompanySecret(secret);
    setRotateOpen(true);
    setRotateMode(
      secret.managedMode === "external_reference" && !secretSupportsExternalValueWrite(secret)
        ? "reference"
        : "value",
    );
    setRotateValue("");
    setRotateExternalRef("");
    setRotateProviderConfigId(
      secret.providerConfigId ?? getDefaultProviderConfigId(providerConfigs, secret.provider),
    );
    setRotateError(null);
  }

  function copyDetailLink() {
    void copyTextToClipboard(window.location.href)
      .then(() => pushToast({ title: "Link copied", body: "Deep link to this secret", tone: "success" }))
      .catch((error) =>
        pushToast({
          title: "Copy failed",
          body: describeError(error).body,
          tone: "error",
        }),
      );
  }

  function copySecretKey(key: string) {
    void copyTextToClipboard(key)
      .then(() => pushToast({ title: "Secret key copied", body: key, tone: "success" }))
      .catch((error) =>
        pushToast({
          title: "Copy failed",
          body: describeError(error).body,
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
            <KeyRound className="h-4 w-4" /> Details and agent access
          </DropdownMenuItem>
          {row.kind === "company" ? (
            <>
              <DropdownMenuItem onSelect={() => openRotateSecret(row.secret)}>
                <RefreshCw className="h-4 w-4" />
                {rotateActionLabel(row.secret)}
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
                {row.secret.status === "active" ? "Disable" : "Enable"}
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
                {row.secret.status === "archived" ? "Restore" : "Archive"}
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
                <Pencil className="h-4 w-4" /> Edit
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
                {row.definition.status === "active" ? "Disable" : "Enable"}
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
                {row.definition.status === "archived" ? "Restore" : "Archive"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDefinitionDeleteConfirm(row.definition)}>
                <Trash2 className="h-4 w-4" /> Delete secret
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  function folderLinkTo(path: string) {
    const params = new URLSearchParams(searchParams);
    const normalized = normalizeSecretPath(path);
    if (normalized) params.set("path", normalized);
    else params.delete("path");
    const qs = params.toString();
    return { search: qs ? `?${qs}` : "" };
  }

  /** Secret-name treatment: raw in flat view, muted-path/bold-leaf otherwise. */
  function renderSecretName(name: string) {
    if (searching) return <SecretPathName name={name} className="text-sm" />;
    if (showFolderView) return <SecretPathName name={name} basePath={folderPath} className="text-sm" />;
    return <span className="truncate font-medium text-foreground">{name}</span>;
  }

  function renderFolderTableRow(folder: SecretPathFolder) {
    return (
      <Link
        key={`folder:${folder.path}`}
        to={folderLinkTo(folder.path)}
        role="row"
        className="grid grid-cols-(--gtc-54) items-center gap-3 border-b border-border/60 px-3 py-3 hover:bg-accent/40"
      >
        <div role="cell" className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium text-foreground">{folder.name}</span>
          </div>
          <div className="mt-0.5 pl-6 text-xs text-muted-foreground">
            {formatSecretPathCounts(folder.secretCount, folder.folderCount)}
          </div>
        </div>
        <div role="cell" aria-hidden="true" />
        <div role="cell" aria-hidden="true" />
        <div role="cell" aria-hidden="true" />
        <div role="cell" className="flex justify-end">
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>
      </Link>
    );
  }

  function renderFolderCard(folder: SecretPathFolder) {
    return (
      <Link
        key={`folder:${folder.path}`}
        to={folderLinkTo(folder.path)}
        className="flex items-center justify-between gap-2 border-b border-border/60 px-1 py-3 hover:bg-accent/30"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{folder.name}</div>
            <div className="text-xs text-muted-foreground">
              {formatSecretPathCounts(folder.secretCount, folder.folderCount)}
            </div>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </Link>
    );
  }

  function renderUpRow(variant: "table" | "card") {
    const parentLabel = parentFolderPath ? parentFolderPath.split("/").pop()! : "All secrets";
    return (
      <Link
        to={folderLinkTo(parentFolderPath)}
        role={variant === "table" ? "row" : undefined}
        className={cn(
          "flex items-center gap-2 text-xs text-muted-foreground hover:bg-accent/40",
          variant === "table"
            ? "border-b border-border/60 px-3 py-2.5"
            : "border-b border-border/60 px-1 py-2.5",
        )}
      >
        <CornerLeftUp className="h-4 w-4 shrink-0" />
        <span className="truncate">Up to {parentLabel}</span>
      </Link>
    );
  }

  function renderSecretsBreadcrumb() {
    const currentName = breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].name : "All secrets";
    const parentLabel = parentFolderPath ? parentFolderPath.split("/").pop()! : "All secrets";
    const fullTrail: { name: string; path: string }[] = [
      { name: "All secrets", path: "" },
      ...breadcrumbs,
    ];
    // Middle-truncate deep paths: root · … · last two.
    const collapsed =
      fullTrail.length > 4
        ? [fullTrail[0], { name: "…", path: "" }, ...fullTrail.slice(-2)]
        : fullTrail;

    return (
      <nav aria-label="Breadcrumb" className="min-w-0">
        {/* Wide: full trail */}
        <ol className="hidden min-w-0 items-center gap-1 text-sm @min-[40rem]:flex">
          {collapsed.map((crumb, index) => {
            const isLast = index === collapsed.length - 1;
            const isEllipsis = crumb.name === "…" && crumb.path === "" && index > 0 && !isLast;
            return (
              <li key={`${crumb.path}:${index}`} className="flex min-w-0 items-center gap-1">
                {index > 0 ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" /> : null}
                {isEllipsis ? (
                  <span className="px-0.5 text-muted-foreground">…</span>
                ) : isLast ? (
                  <span aria-current="page" className="truncate font-medium text-foreground">
                    {crumb.name}
                  </span>
                ) : (
                  <Link
                    to={folderLinkTo(crumb.path)}
                    className="max-w-40 truncate text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {crumb.name}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
        {/* Narrow: back-chevron + parent/current */}
        <div className="flex min-w-0 items-center gap-1.5 text-sm @min-[40rem]:hidden">
          {folderPath ? (
            <>
              <Link
                to={folderLinkTo(parentFolderPath)}
                aria-label="Up one folder"
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <ChevronLeft className="h-4 w-4" />
              </Link>
              {parentLabel !== "All secrets" ? (
                <span className="shrink-0 text-muted-foreground">{parentLabel} /</span>
              ) : null}
              <span aria-current="page" className="truncate font-medium text-foreground">
                {currentName}
              </span>
            </>
          ) : (
            <span aria-current="page" className="truncate font-medium text-foreground">
              All secrets
            </span>
          )}
        </div>
      </nav>
    );
  }

  // Only an action still in flight locks a vault's menu. A mutation keeps its
  // last variables after it settles, so those alone would lock it for good.
  const pendingVaultActionId =
    [disableVaultMutation, enableVaultMutation, removeVaultMutation, defaultVaultMutation, healthVaultMutation].find(
      (mutation) => mutation.isPending,
    )?.variables ?? null;

  function rowAgents(row: UnifiedSecretRow): readonly Agent[] {
    return (
      (row.kind === "company"
        ? agentUsage.bySecretId.get(row.secret.id)
        : agentUsage.byUserSecretKey.get(row.definition.key)) ?? EMPTY_AGENTS
    );
  }
  /** Named only when the value lives somewhere other than Paperclip's own storage. */
  function secretVaultLine(secret: CompanySecret) {
    const config = secret.providerConfigId
      ? providerConfigs.find((candidate) => candidate.id === secret.providerConfigId) ?? null
      : null;
    const linked = secret.managedMode === "external_reference";
    if (!config && !linked && secret.provider === "local_encrypted") return null;
    const provider = vaultKindLabel(providers, secret.provider);
    return {
      linked,
      text: `${linked ? "Linked from" : "Stored in"} ${config ? `${config.displayName} · ${provider}` : provider}`,
      unavailable: Boolean(getProviderConfigBlockReason(config)),
    };
  }
  function openRow(row: UnifiedSecretRow) {
    if (row.kind === "company") openCompanySecret(row.secret);
    else openUserDefinition(row.definition);
  }
  function isRowSelected(row: UnifiedSecretRow) {
    return row.kind === "company" ? selectedSecretId === row.secret.id : selectedDefinitionId === row.definition.id;
  }
  function renderRowTitle(row: UnifiedSecretRow, label?: string) {
    const status = row.kind === "company" ? row.secret.status : row.definition.status;
    const vaultLine = row.kind === "company" ? secretVaultLine(row.secret) : null;
    const VaultIcon = vaultLine?.linked ? Link2 : Cloud;
    return (
      <>
        <div className="flex min-w-0 items-center gap-2">
          {label ? (
            <span className="truncate font-medium text-foreground">{label}</span>
          ) : (
            renderSecretName(row.kind === "company" ? row.secret.name : row.definition.name)
          )}
          {status !== "active" ? <StatusBadge status={status} /> : null}
        </div>
        {vaultLine ? (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <VaultIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{vaultLine.text}</span>
            {vaultLine.unavailable ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                Vault unavailable
              </span>
            ) : null}
          </div>
        ) : null}
      </>
    );
  }
  function renderRowProvidedBy(row: UnifiedSecretRow) {
    return (
      <SecretProvidedBy
        perUser={row.kind === "user"}
        coverage={
          row.kind === "user" ? (
            <CoverageInline companyId={selectedCompanyId!} definitionId={row.definition.id} compact />
          ) : undefined
        }
      />
    );
  }
  function renderRowUsedBy(row: UnifiedSecretRow) {
    const agents = rowAgents(row);
    return (
      <SecretUsedBy
        agents={agents}
        otherUseCount={row.kind === "company" ? Math.max(0, (row.secret.referenceCount ?? 0) - agents.length) : 0}
      />
    );
  }
  function renderSecretTableRow(row: UnifiedSecretRow, label?: string) {
    const updatedAt = row.kind === "company" ? row.secret.updatedAt : row.definition.updatedAt;
    const updatedTooltip =
      row.kind === "company"
        ? [
            `Updated: ${formatRelative(row.secret.updatedAt)}`,
            `Value replaced: ${formatRelative(row.secret.lastRotatedAt)}`,
            `Last used: ${formatRelative(row.secret.lastResolvedAt)}`,
          ].join("\n")
        : `Updated: ${formatRelative(row.definition.updatedAt)}`;
    return (
      <div
        key={row.id}
        role="row"
        className={cn(
          "grid cursor-pointer grid-cols-(--gtc-54) items-center gap-3 border-b border-border/60 px-3 py-2.5 hover:bg-accent/40",
          isRowSelected(row) && "bg-accent/60",
        )}
        onClick={() => openRow(row)}
      >
        <div role="cell" className="min-w-0">{renderRowTitle(row, label)}</div>
        <div role="cell" className="min-w-0">{renderRowProvidedBy(row)}</div>
        <div role="cell" className="min-w-0">{renderRowUsedBy(row)}</div>
        <div role="cell">
          <UpdatedWithTooltip updatedAt={updatedAt} tooltip={updatedTooltip} />
        </div>
        <div role="cell" className="text-right" onClick={(event) => event.stopPropagation()}>
          {renderRowActions(row)}
        </div>
      </div>
    );
  }
  function renderSecretCard(row: UnifiedSecretRow, label?: string) {
    return (
      <div
        key={row.id}
        className={cn(
          "flex cursor-pointer items-start justify-between gap-2 border-b border-border/60 px-1 py-3 hover:bg-accent/30",
          isRowSelected(row) && "bg-accent/60",
        )}
        onClick={() => openRow(row)}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <div className="min-w-0">{renderRowTitle(row, label)}</div>
          {renderRowProvidedBy(row)}
          {renderRowUsedBy(row)}
        </div>
        <div onClick={(event) => event.stopPropagation()}>{renderRowActions(row)}</div>
      </div>
    );
  }
  const filterChips = [
    providedByFilter !== "all"
      ? { label: providedByFilter === "user" ? "Each user" : "Organization", clear: () => setProvidedByFilter("all") }
      : null,
    providerFilter !== "all"
      ? {
          label: providerFilter === "local_encrypted" ? "Paperclip" : providerLabel(providers, providerFilter),
          clear: () => setProviderFilter("all"),
        }
      : null,
    statusFilter !== "current"
      ? { label: statusFilter === "archived" ? "Archived" : "Disabled", clear: () => setStatusFilter("current") }
      : null,
  ].filter((chip): chip is { label: string; clear: () => void } => chip !== null);
  const noTeamRows = folderRows.length === 0 && secretRows.length === 0;

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Select an organization to manage secrets.</div>
    );
  }

  return (
    <TooltipProvider>
    <div className="flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Secrets</h1>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More secret actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem
                  onSelect={() => {
                    setActiveTab("secrets");
                    setSearch("");
                    setNewFolderOpen(true);
                    setNewFolderError(null);
                  }}
                >
                  <FolderPlus className="h-4 w-4" /> New folder
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openImportFromVault()} data-testid="import-from-vault-button">
                  <Cloud className="h-4 w-4" /> Import from a vault
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button data-toolbar-primary onClick={openCreateSecret} size="sm">
              <Plus className="mr-1 h-3.5 w-3.5" /> New secret
            </Button>
          </div>
        </div>
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
          API keys and tokens your agents use while they work.
          <HowSecretsWork />
        </p>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as SecretsTab)}
        className="flex flex-col gap-4"
      >
        <PageTabBar
          items={[
            { value: "secrets", label: "Secrets" },
            { value: "my-secrets", label: "My secrets" },
            ...(hideVaultsTab ? [] : [{ value: "vaults", label: "Vaults" }]),
            ...(hideProposalsTab
              ? []
              : [
                  {
                    value: "proposals",
                    label: (
                      <span className="inline-flex items-center gap-1.5">
                        Proposals
                        {pendingProposalCount > 0 ? (
                          <Badge
                            variant="outline"
                            className="h-4 min-w-4 justify-center rounded-full border-amber-500/40 bg-amber-500/10 px-1 text-(length:--text-nano) font-medium text-amber-700 dark:text-amber-300"
                          >
                            {pendingProposalCount}
                          </Badge>
                        ) : null}
                      </span>
                    ),
                  },
                ]),
          ]}
          align="start"
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as SecretsTab)}
        />

        <TabsContent value="secrets" className="flex flex-col gap-3">
          <div data-canonical-toolbar="secrets" role="toolbar" aria-label="Secrets controls" className="flex flex-wrap items-center gap-2">
            <div className="relative w-48 sm:w-64 md:w-80">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search all secrets"
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
              onStatusChange={setStatusFilter}
              onProviderChange={setProviderFilter}
              onProvidedByChange={setProvidedByFilter}
            />
            {filterChips.map((chip) => (
              <span key={chip.label} className="inline-flex h-8 items-center gap-1 rounded-md bg-accent pl-2.5 pr-1 text-sm">
                {chip.label}
                <button
                  type="button"
                  className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label={`Remove filter ${chip.label}`}
                  onClick={chip.clear}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
          {newFolderOpen && showFolderView ? (
            <div className="flex flex-wrap items-start gap-2" role="group" aria-label="Create folder">
              <div className="min-w-48 flex-1 sm:max-w-80">
                <Input
                  value={newFolderName}
                  onChange={(event) => {
                    setNewFolderName(event.target.value);
                    if (newFolderError) setNewFolderError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") stageNewFolder();
                    if (event.key === "Escape") closeNewFolder();
                  }}
                  placeholder="Folder name"
                  aria-label="Folder name"
                  aria-invalid={Boolean(newFolderError)}
                  autoFocus
                />
                {newFolderError ? (
                  <p className="mt-1 text-xs text-destructive" role="alert">
                    {newFolderError}
                  </p>
                ) : null}
              </div>
              <Button type="button" size="sm" onClick={stageNewFolder}>
                Create folder
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={closeNewFolder}>
                Cancel
              </Button>
            </div>
          ) : null}
          <div>
            {secretsView.kind === "error" || userDefinitionsView.kind === "error" ? (
              <div className="py-4">
                <QueryErrorState
                  error={secretsView.kind === "error" ? secretsQuery.error : userDefinitionsQuery.error}
                  action="load secrets"
                  onRetry={() => {
                    secretsView.retry();
                    userDefinitionsView.retry();
                  }}
                  retrying={secretsView.isFetching || userDefinitionsView.isFetching}
                />
              </div>
            ) : unifiedRows.length === 0 &&
              !secretsListLoading &&
              !(showFolderView && folderPath) ? (
              <EmptyState
                icon={KeyRound}
                title="No secrets yet"
                message="Add an API key or token once, then choose which agents can use it."
                action="New secret"
                onAction={openCreateSecret}
              />
            ) : (
              <div className="@container min-w-0 overflow-x-hidden text-sm" data-testid="secrets-list-container">
                {showFolderView && folderPath ? (
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    {renderSecretsBreadcrumb()}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatSecretPathCounts(currentFolderSecretCount, folderListing.folders.length)}
                    </span>
                  </div>
                ) : searching ? (
                  <div className="mb-3 text-xs text-muted-foreground">
                    {filteredRows.length} {filteredRows.length === 1 ? "match" : "matches"} across all folders
                  </div>
                ) : null}
                {noTeamRows ? (
                  secretsListLoading ? (
                    <div className="space-y-2 py-2" aria-hidden="true" data-testid="secrets-loading-skeleton">
                      {[0, 1, 2, 3].map((index) => (
                        <div key={index} className="h-14 animate-pulse rounded-md bg-muted/40" />
                      ))}
                    </div>
                  ) : showFolderView && folderPath && activeSecretFilterCount === 0 ? (
                    <EmptyState
                      icon={FolderOpen}
                      message="No secrets in this folder yet."
                      action="New secret here"
                      onAction={openCreateSecret}
                    />
                  ) : showManagedSection ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground">
                      {searching || activeSecretFilterCount > 0
                        ? "None of the secrets your team added match."
                        : "Your team hasn't added a secret yet."}
                    </p>
                  ) : (
                    <EmptyState
                      icon={Search}
                      message={searching ? "No secrets match your search." : "No secrets match your filters."}
                    />
                  )
                ) : (
                  <>
                    <div
                      role="table"
                      aria-label="Secrets"
                      className="hidden min-w-0 @min-[40rem]:block"
                      data-testid="secrets-table-view"
                    >
                      <div
                        role="row"
                        className="grid grid-cols-(--gtc-54) items-center gap-3 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground"
                      >
                        <div role="columnheader">Name</div>
                        <div role="columnheader">Provided by</div>
                        <div role="columnheader">Used by</div>
                        <div role="columnheader">Updated</div>
                        <div role="columnheader" className="sr-only">Actions</div>
                      </div>
                      <div role="rowgroup">
                        {showUpRow ? renderUpRow("table") : null}
                        {folderRows.map(renderFolderTableRow)}
                        {secretRows.map((row) => renderSecretTableRow(row))}
                      </div>
                    </div>
                    <div className="@min-[40rem]:hidden" data-testid="secrets-card-view">
                      {showUpRow ? renderUpRow("card") : null}
                      {folderRows.map(renderFolderCard)}
                      {secretRows.map((row) => renderSecretCard(row))}
                    </div>
                  </>
                )}
                {showManagedSection && !secretsListLoading ? (
                  <section aria-label="Managed by Paperclip" className="mt-6" data-testid="managed-secrets">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left hover:bg-accent/40"
                      aria-expanded={managedExpanded}
                      onClick={() => setManagedOpen((current) => !current)}
                    >
                      <ChevronRight
                        className={cn(
                          "h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                          managedExpanded && "rotate-90",
                        )}
                        aria-hidden
                      />
                      <span className="shrink-0 text-sm font-medium">Managed by Paperclip</span>
                      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{managedCount}</span>
                      <span className="hidden min-w-0 truncate text-sm text-muted-foreground @min-[40rem]:inline">
                        · Saved by your connections and sign-ins, and kept up to date for you
                      </span>
                    </button>
                    {managedExpanded
                      ? managedGroups.map(({ group, rows }) => (
                          <ManagedSecretGroup
                            key={group.id}
                            group={group}
                            count={rows.length}
                            open={searching || openManagedGroups.has(group.id)}
                            onToggle={() =>
                              setOpenManagedGroups((current) => {
                                const next = new Set(current);
                                if (!next.delete(group.id)) next.add(group.id);
                                return next;
                              })
                            }
                          >
                            <div role="table" aria-label={group.label} className="hidden min-w-0 @min-[40rem]:block">
                              <div role="rowgroup">
                                {rows.map((row) =>
                                  renderSecretTableRow(
                                    row,
                                    managedSecretLabel(row.kind === "company" ? row.secret : row.definition, group.id),
                                  ),
                                )}
                              </div>
                            </div>
                            <div className="@min-[40rem]:hidden">
                              {rows.map((row) =>
                                renderSecretCard(
                                  row,
                                  managedSecretLabel(row.kind === "company" ? row.secret : row.definition, group.id),
                                ),
                              )}
                            </div>
                          </ManagedSecretGroup>
                        ))
                      : null}
                  </section>
                ) : null}
              </div>
            )}
          </div>
        </TabsContent>
        <TabsContent
          value="my-secrets"
          className="flex flex-col gap-3"
        >
          <MyUserSecretsTab companyId={selectedCompanyId} />
        </TabsContent>
        {!hideVaultsTab && (
        <TabsContent value="vaults">
          <ProviderVaultsTab
            providers={providers}
            providerConfigs={providerConfigs}
            loading={providerConfigsQuery.isPending || providerConfigsView.kind === "reconnecting"}
            error={providerConfigsView.kind === "error" ? providerConfigsQuery.error : null}
            onRetry={providerConfigsView.retry}
            retrying={providerConfigsView.isFetching}
            onCreate={openCreateVault}
            onEdit={openEditVault}
            secrets={secrets}
            onDisable={(config) => disableVaultMutation.mutate(config.id)}
            onEnable={(config) => enableVaultMutation.mutate(config.id)}
            onRemove={(config) => setRemoveVaultConfirm(config)}
            onSetDefault={(config) => defaultVaultMutation.mutate(config.id)}
            onHealthCheck={(config) => healthVaultMutation.mutate(config.id)}
            onImportSecrets={openImportFromVault}
            pendingActionId={pendingVaultActionId}
          />
        </TabsContent>
        )}
        {!hideProposalsTab && (
        <TabsContent value="proposals">
          {selectedCompanyId ? (
            <ProposalsTab companyId={selectedCompanyId} providerConfigs={providerConfigs} />
          ) : null}
        </TabsContent>
        )}
      </Tabs>

      <Sheet
        open={Boolean(selectedSecret || selectedDefinition)}
        onOpenChange={(open) => {
          if (!open && (selectedSecret || selectedDefinition)) setDetailSelection(null);
        }}
      >
        <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md" data-testid="secret-details">
          {selectedSecret ? (
            <>
              <SheetHeader className="gap-3">
                <SheetTitle className="flex min-w-0 items-center gap-2 pr-8 text-base">
                  <span className="min-w-0 truncate">{selectedSecret.name}</span>
                  {selectedSecret.status !== "active" ? (
                    <span className="shrink-0">
                      <StatusBadge status={selectedSecret.status} />
                    </span>
                  ) : null}
                </SheetTitle>
                <SheetDescription className="sr-only">
                  {providerLabel(providers, selectedSecret.provider)} secret {selectedSecret.key}
                </SheetDescription>
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="shrink-0">Key</span>
                  <code className="min-w-0 truncate font-mono text-foreground">{selectedSecret.key}</code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0"
                    aria-label="Copy key"
                    onClick={() => copySecretKey(selectedSecret.key)}
                  >
                    <Copy />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => openRotateSecret(selectedSecret)}>
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    {rotateActionLabel(selectedSecret)}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${selectedSecret.name}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-52">
                      <DropdownMenuItem onSelect={copyDetailLink}>
                        <Link2 className="h-4 w-4" /> Copy link
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
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
                        {selectedSecret.status === "active" ? "Disable" : "Enable"}
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
                        {selectedSecret.status === "archived" ? "Restore" : "Archive"}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleteConfirm(selectedSecret)}>
                        <Trash2 className="h-4 w-4" /> Delete secret
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </SheetHeader>
              <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-6">
                {selectedSecret.status !== "active" ? (
                  <p className="text-sm text-muted-foreground">
                    {selectedSecret.status === "disabled"
                      ? "Disabled secrets are not given to agents. A run that needs it will say so."
                      : "Archived secrets are not given to agents and stay out of the list."}
                  </p>
                ) : null}
                <AgentAccessSection
                  companyId={selectedCompanyId}
                  reference={selectedSecretAccessReference!}
                />
                {otherSecretUses.length > 0 ? (
                  <DetailSection title="Also set in">
                    <SecretUsageTab loading={false} bindings={otherSecretUses} />
                  </DetailSection>
                ) : null}
                <DetailSection title="Details">
                  <SecretDetailsTab
                    secret={selectedSecret}
                    providers={providers}
                    providerConfigs={providerConfigs}
                    onManageVaults={
                      hideVaultsTab
                        ? undefined
                        : () => {
                            setDetailSelection(null);
                            setActiveTab("vaults");
                          }
                    }
                  />
                </DetailSection>
                <DetailSection title="Activity">
                  <SecretEventsTab
                    loading={eventsQuery.isPending}
                    events={eventsQuery.data ?? []}
                    companyId={selectedCompanyId}
                    agents={agentsQuery.data}
                  />
                </DetailSection>
              </div>
            </>
          ) : selectedDefinition ? (
            <>
              <SheetHeader className="gap-3">
                <SheetTitle className="flex min-w-0 items-center gap-2 pr-8 text-base">
                  <span className="min-w-0 truncate">{selectedDefinition.name}</span>
                  {selectedDefinition.status !== "active" ? (
                    <span className="shrink-0">
                      <StatusBadge status={selectedDefinition.status} />
                    </span>
                  ) : null}
                </SheetTitle>
                <SheetDescription className="sr-only">
                  Secret each user provides, {selectedDefinition.key}
                </SheetDescription>
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="shrink-0">Key</span>
                  <code className="min-w-0 truncate font-mono text-foreground">{selectedDefinition.key}</code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0"
                    aria-label="Copy key"
                    onClick={() => copySecretKey(selectedDefinition.key)}
                  >
                    <Copy />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setSetMyValueFor(
                        selectedDefinitionMyEntry ?? { definition: selectedDefinition, secret: null },
                      )
                    }
                    disabled={selectedDefinition.status !== "active"}
                  >
                    <KeyRound className="mr-1 h-3.5 w-3.5" />
                    {selectedDefinitionMyEntry?.secret ? "Update my value" : "Set my value"}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${selectedDefinition.name}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-52">
                      <DropdownMenuItem onSelect={() => openEditDefinition(selectedDefinition)}>
                        <Pencil className="h-4 w-4" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={copyDetailLink}>
                        <Link2 className="h-4 w-4" /> Copy link
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
                        {selectedDefinition.status === "active" ? "Disable" : "Enable"}
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
                        {selectedDefinition.status === "archived" ? "Restore" : "Archive"}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setDefinitionDeleteConfirm(selectedDefinition)}>
                        <Trash2 className="h-4 w-4" /> Delete secret
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </SheetHeader>
              <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-6">
                {selectedDefinition.status !== "active" ? (
                  <p className="text-sm text-muted-foreground">
                    {selectedDefinition.status === "disabled"
                      ? "Disabled secrets are not given to agents, and members are not asked for a value."
                      : "Archived secrets are not given to agents and stay out of the list."}
                  </p>
                ) : null}
                <AgentAccessSection
                  companyId={selectedCompanyId}
                  reference={selectedDefinitionAccessReference!}
                />
                <DetailSection title="Members">
                  <UserSecretCoverageTab
                    companyId={selectedCompanyId}
                    definitionId={selectedDefinition.id}
                  />
                </DetailSection>
                <DetailSection title="Details">
                  <UserSecretDetailsTab definition={selectedDefinition} />
                </DetailSection>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

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
          onManageVaults={
            hideVaultsTab
              ? undefined
              : () => {
                  setImportOpen(false);
                  setImportInitialVaultId(null);
                  setActiveTab("vaults");
                }
          }
          onImportComplete={() => {
            void secretsQuery.refetch();
          }}
        />
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (createMutation.isPending) return;
          setCreateOpen(open);
          if (!open) setCreateNamePrefix(null);
        }}
      >
        <DialogContent className="max-h-(--sz-calc-18) overflow-y-auto p-4 sm:max-w-lg sm:p-6">
          <DialogHeader>
            <DialogTitle>{editingDefinition ? `Edit ${editingDefinition.name}` : "New secret"}</DialogTitle>
            <DialogDescription className="sr-only">
              {editingDefinition ? "Change this secret's name, description and instructions." : "Add a secret your agents can use."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submitCreate();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="new-secret-name">Name</label>
              <div className="flex items-center gap-2">
                {createNamePrefix && !editingDefinition ? (
                  <span
                    className="inline-flex h-9 min-w-0 shrink items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 text-sm text-muted-foreground"
                    title={createNamePrefix}
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{createNamePrefix.replace(/\/$/, "")}</span>
                    <button
                      type="button"
                      className="shrink-0 rounded-sm hover:text-foreground"
                      aria-label="Remove folder prefix"
                      onClick={() => setCreateNamePrefix(null)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ) : null}
                <Input
                  id="new-secret-name"
                  value={createLeafName}
                  onChange={(event) => setCreateName(`${createNamePrefix && !editingDefinition ? createNamePrefix : ""}${event.target.value}`)}
                  onPaste={splitPastedAssignment}
                  placeholder={secretValueProvider === "user" ? "Personal GitHub token" : "GITHUB_TOKEN"}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={createAttempted && Boolean(createNameError)}
                  aria-describedby="new-secret-name-hint"
                  autoFocus
                />
              </div>
              <p
                id="new-secret-name-hint"
                className={cn("text-xs", createAttempted && createNameError ? "text-destructive" : "text-muted-foreground")}
                role={createAttempted && createNameError ? "alert" : undefined}
              >
                {createAttempted && createNameError ? (
                  createNameError
                ) : createEnvKey && createEnvKey !== createLeafName.trim() ? (
                  <>
                    Agents read it as <code className="font-mono text-foreground">{createEnvKey}</code>.
                  </>
                ) : editingDefinition || secretValueProvider !== "company" || createMode !== "managed" ? (
                  "Use a slash to put it in a folder, like staging/API_KEY."
                ) : (
                  "Tip: paste NAME=value and both fields fill in."
                )}
              </p>
            </div>

            {!editingDefinition ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-sm font-medium">Who provides the value</p>
                <RadioCardGroup
                  ariaLabel="Who provides the value"
                  className="grid-cols-1 sm:grid-cols-2"
                  disabled={createMutation.isPending}
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
                  options={[
                    {
                      value: "company",
                      title: "Organization",
                      description: "One value, shared by every agent you choose.",
                      icon: <Building2 className="h-4 w-4" />,
                    },
                    {
                      value: "user",
                      title: "Each user",
                      description: "Every member adds their own under My secrets.",
                      icon: <Users className="h-4 w-4" />,
                    },
                  ]}
                />
              </div>
            ) : null}

            {secretValueProvider === "company" && createMode === "managed" ? (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor="new-secret-value">Value</label>
                <div className="relative">
                  <Textarea
                    id="new-secret-value"
                    value={createForm.value}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, value: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submitCreate();
                    }}
                    rows={2}
                    autoComplete="off"
                    spellCheck={false}
                    className={cn("min-w-0 overflow-x-hidden break-all pr-10 font-mono text-sm", !createValueVisible && "secret-value-masked")}
                    aria-invalid={createAttempted && Boolean(createValueError)}
                    aria-describedby="new-secret-value-hint"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="absolute right-2 top-2"
                    aria-label={createValueVisible ? "Hide value" : "Show value"}
                    aria-pressed={createValueVisible}
                    onClick={() => setCreateValueVisible((current) => !current)}
                  >
                    {createValueVisible ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                <p
                  id="new-secret-value-hint"
                  className={cn("text-xs", createAttempted && createValueError ? "text-destructive" : "text-muted-foreground")}
                  role={createAttempted && createValueError ? "alert" : undefined}
                >
                  {createAttempted && createValueError
                    ? createValueError
                    : createVaultOptions.length > 1
                      ? "After saving it can be replaced, never viewed."
                      : "Encrypted and stored in Paperclip. After saving it can be replaced, never viewed."}
                </p>
                {awsManagedPathPreview ? (
                  <p className="text-xs text-muted-foreground">
                    It will be created in AWS at <code className="break-all font-mono">{awsManagedPathPreview}</code>.
                  </p>
                ) : null}
                {createCanLink ? (
                  <button
                    type="button"
                    className="self-start text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                    onClick={() => setCreateMode("external")}
                  >
                    Use a secret that already exists in {createVaultLabel} instead
                  </button>
                ) : null}
              </div>
            ) : null}

            {secretValueProvider === "company" && createMode === "external" ? (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor="new-secret-ref">
                  Existing secret in {createVaultLabel}
                </label>
                <Input
                  id="new-secret-ref"
                  value={createForm.externalRef}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, externalRef: event.target.value }))
                  }
                  placeholder="arn:aws:secretsmanager:us-east-1:…"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  aria-invalid={createAttempted && Boolean(createValueError)}
                  aria-describedby="new-secret-ref-hint"
                />
                <p
                  id="new-secret-ref-hint"
                  className={cn("text-xs", createAttempted && createValueError ? "text-destructive" : "text-muted-foreground")}
                  role={createAttempted && createValueError ? "alert" : undefined}
                >
                  {createAttempted && createValueError
                    ? createValueError
                    : "Paperclip reads the value from your vault when a run starts. Change the value there."}
                </p>
                <button
                  type="button"
                  className="self-start text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  onClick={() => setCreateMode("managed")}
                >
                  Store a new value instead
                </button>
              </div>
            ) : null}

            {secretValueProvider === "user" ? (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor="new-secret-usage-guidance">
                  Instructions for members <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <Textarea
                  id="new-secret-usage-guidance"
                  value={createForm.usageGuidance}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, usageGuidance: event.target.value }))
                  }
                  placeholder="Where to create the key and which permissions it needs"
                  className="min-h-(--sz-70px) text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Members without a value are asked for one. An agent uses the value of the person it is working for.
                </p>
              </div>
            ) : null}

            {secretValueProvider === "company" && createVaultOptions.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor="new-secret-vault">Stored in</label>
                <select
                  id="new-secret-vault"
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none aria-invalid:border-destructive"
                  value={createVaultValue}
                  aria-invalid={Boolean(createProviderBlockReason)}
                  aria-describedby={createProviderBlockReason ? "new-secret-vault-hint" : undefined}
                  onChange={(event) => {
                    const option = createVaultOptions.find((candidate) => candidate.value === event.target.value);
                    if (!option) return;
                    setCreateForm((current) => ({
                      ...current,
                      provider: option.provider,
                      providerConfigId: option.providerConfigId,
                    }));
                  }}
                >
                  {createVaultOptions.some((option) => option.value === createVaultValue) ? null : (
                    <option value={createVaultValue}>{createVaultLabel}</option>
                  )}
                  {createVaultOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                      {option.blockReason ? " — unavailable" : ""}
                    </option>
                  ))}
                </select>
                {createProviderBlockReason ? (
                  <p id="new-secret-vault-hint" className="text-xs text-destructive" role="alert">
                    {createProviderBlockReason} Choose another vault
                    {hideVaultsTab ? null : (
                      <>
                        , or{" "}
                        <button
                          type="button"
                          className="underline underline-offset-4"
                          onClick={() => {
                            setCreateOpen(false);
                            setCreateNamePrefix(null);
                            setActiveTab("vaults");
                          }}
                        >
                          fix it in Vaults
                        </button>
                      </>
                    )}
                    .
                  </p>
                ) : selectedCreateProviderConfig &&
                  (selectedCreateProviderConfig.status === "warning" ||
                    selectedCreateProviderConfig.healthStatus === "warning") ? (
                  <ProviderVaultInlineWarning config={selectedCreateProviderConfig} />
                ) : null}
              </div>
            ) : secretValueProvider === "company" && createProviderBlockReason ? (
              <p className="text-xs text-destructive" role="alert">
                {createProviderBlockReason}
              </p>
            ) : null}

            {!editingDefinition ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-sm font-medium">
                  Agents that can use it <span className="font-normal text-muted-foreground">(optional)</span>
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {(agentsQuery.data ?? EMPTY_AGENTS)
                    .filter((agent) => createAgentIds.has(agent.id))
                    .map((agent) => (
                      <span key={agent.id} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border pl-1.5 pr-1 text-sm">
                        <AgentAvatar agent={agent} size={20} />
                        {agent.name}
                        <button
                          type="button"
                          className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                          aria-label={`Remove ${agent.name}`}
                          onClick={() =>
                            setCreateAgentIds((current) => {
                              const next = new Set(current);
                              next.delete(agent.id);
                              return next;
                            })
                          }
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    ))}
                  <AgentMultiSelect
                    agents={(agentsQuery.data ?? EMPTY_AGENTS).filter((agent) => agent.status !== "terminated")}
                    selectedAgentIds={createAgentIds}
                    onChange={setCreateAgentIds}
                    loading={agentsQuery.isPending}
                    disabled={createMutation.isPending}
                    triggerLabel="Add agent"
                    triggerIcon={<Plus className="h-3.5 w-3.5" />}
                    triggerVariant="outline"
                    triggerSize="sm"
                    contentAlign="start"
                    emptyMessage="No agents yet."
                    showSelectionPreview={false}
                  />
                </div>
                {createAttempted && createAccessError ? (
                  <p className="text-xs text-destructive" role="alert">{createAccessError}</p>
                ) : createAgentIds.size === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    You can also give access later from the secret or from an agent&apos;s settings.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-col gap-4">
              <button
                type="button"
                className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
                aria-expanded={createMoreOpen}
                aria-controls="new-secret-more"
                onClick={() => setCreateMoreOpen((current) => !current)}
              >
                <ChevronRight
                  className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", createMoreOpen && "rotate-90")}
                  aria-hidden
                />
                More options
              </button>
              {createMoreOpen ? (
                <div id="new-secret-more" className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="new-secret-description">Description</label>
                    <Input
                      id="new-secret-description"
                      value={createForm.description}
                      onChange={(event) =>
                        setCreateForm((current) => ({ ...current, description: event.target.value }))
                      }
                      placeholder="What it is for"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="new-secret-key">
                      {secretValueProvider === "user" ? "Environment variable" : "Key"}
                    </label>
                    <Input
                      id="new-secret-key"
                      value={createForm.key}
                      onChange={(event) => {
                        if (editingDefinition) return;
                        setCreateKeyDirty(true);
                        setCreateForm((current) => ({ ...current, key: event.target.value }));
                      }}
                      placeholder={secretValueProvider === "user" ? "PERSONAL_GH_TOKEN" : "github-token"}
                      disabled={Boolean(editingDefinition)}
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono"
                      aria-invalid={createAttempted && Boolean(createKeyError)}
                    />
                    <p
                      className={cn("text-xs", createAttempted && createKeyError ? "text-destructive" : "text-muted-foreground")}
                      role={createAttempted && createKeyError ? "alert" : undefined}
                    >
                      {createAttempted && createKeyError
                        ? createKeyError
                        : editingDefinition
                          ? "The name agents read. It can't change after creation."
                          : secretValueProvider === "user"
                            ? "The name agents read. It follows the secret's name unless you change it, and stays fixed after creation."
                            : "A stable ID for the CLI and API. It follows the name unless you change it, and stays fixed after creation."}
                    </p>
                  </div>
                </div>
              ) : null}
            </div>

            {createError ? (
              <SecretCreateError
                error={createError}
                provider={createForm.provider}
                providerConfigId={createForm.providerConfigId || null}
              />
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)} disabled={createMutation.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                {createMutation.isPending
                  ? "Saving…"
                  : editingDefinition
                    ? "Save changes"
                    : secretValueProvider === "company" && createMode === "external"
                      ? "Link secret"
                      : "Create secret"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={vaultDialogOpen} onOpenChange={setVaultDialogOpen}>
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingVault
                ? `Edit ${editingVault.displayName}`
                : vaultForm.provider === "aws_secrets_manager"
                  ? "Connect AWS Secrets Manager"
                  : vaultForm.provider === "local_encrypted"
                    ? "Add a Paperclip-encrypted vault"
                    : `Add a ${providerLabel(providers, vaultForm.provider)} vault`}
            </DialogTitle>
            <DialogDescription>
              {vaultForm.provider === "aws_secrets_manager"
                ? "Paperclip connects with the AWS role its server runs as. No access keys are stored."
                : "Only settings are saved here. Credentials stay with Paperclip's server."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              setVaultAttempted(true);
              if (saveVaultMutation.isPending || vaultNameError || vaultRegionError) return;
              setVaultError(null);
              saveVaultMutation.mutate();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor="vault-name">Name</label>
                <Input
                  id="vault-name"
                  value={vaultForm.displayName}
                  onChange={(event) =>
                    setVaultForm((current) => ({ ...current, displayName: event.target.value }))
                  }
                  placeholder={vaultForm.provider === "aws_secrets_manager" ? "prod-us-east" : "Production vault"}
                  autoComplete="off"
                  aria-invalid={vaultAttempted && Boolean(vaultNameError)}
                  autoFocus
                />
                {vaultAttempted && vaultNameError ? (
                  <p className="text-xs text-destructive" role="alert">{vaultNameError}</p>
                ) : null}
              </div>
              {vaultForm.provider === "aws_secrets_manager" ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium" htmlFor="provider-vault-aws-region">AWS region</label>
                  <Input
                    id="provider-vault-aws-region"
                    value={vaultForm.region}
                    onChange={(event) => setVaultForm((current) => ({ ...current, region: event.target.value }))}
                    placeholder="us-east-1"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    aria-invalid={vaultAttempted && Boolean(vaultRegionError)}
                  />
                  {vaultAttempted && vaultRegionError ? (
                    <p className="text-xs text-destructive" role="alert">{vaultRegionError}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
            {vaultForm.status === "coming_soon" || vaultForm.status === "disabled" ? (
              <p className="text-sm text-muted-foreground">
                {vaultForm.status === "disabled"
                  ? "This vault is disabled. Enable it from the vault's menu to use it for secrets."
                  : `${providerLabel(providers, vaultForm.provider)} vaults can be saved, but Paperclip can't store or read secrets in them yet.`}
              </p>
            ) : (
              <label className="flex items-start gap-2.5 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={vaultForm.isDefault}
                  onCheckedChange={(checked) =>
                    setVaultForm((current) => ({ ...current, isDefault: checked === true }))
                  }
                />
                <span className="flex flex-col gap-0.5">
                  <span>
                    {vaultForm.provider === "local_encrypted"
                      ? "Use for new secrets by default"
                      : `Use for new ${providerLabel(providers, vaultForm.provider)} secrets by default`}
                  </span>
                  <span className="text-xs text-muted-foreground">Existing secrets stay where they are.</span>
                </span>
              </label>
            )}
            {vaultForm.provider === "aws_secrets_manager" ? (
              <div className="flex flex-col gap-4">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
                  aria-expanded={vaultAdvancedOpen}
                  onClick={() => setVaultAdvancedOpen((current) => !current)}
                >
                  <ChevronRight
                    className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", vaultAdvancedOpen && "rotate-90")}
                    aria-hidden
                  />
                  Naming and tags
                </button>
                {vaultAdvancedOpen ? <ProviderVaultFields form={vaultForm} onChange={setVaultForm} /> : null}
              </div>
            ) : (
              <ProviderVaultFields form={vaultForm} onChange={setVaultForm} />
            )}
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
                onApply={(candidate) => {
                  applyVaultDiscoveryCandidate(candidate);
                  setVaultAdvancedOpen(true);
                }}
              />
            ) : null}
            {vaultError ? <p className="text-sm text-destructive" role="alert">{vaultError}</p> : null}
            <div className="flex items-center justify-between gap-3">
              <Button type="button" variant="ghost" onClick={() => setVaultDialogOpen(false)} disabled={saveVaultMutation.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={saveVaultMutation.isPending}>
                {saveVaultMutation.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                {saveVaultMutation.isPending
                  ? "Saving…"
                  : editingVault
                    ? "Save changes"
                    : vaultForm.provider === "aws_secrets_manager"
                      ? "Connect vault"
                      : "Add vault"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {selectedSecret?.managedMode === "external_reference" && rotateMode === "reference"
                ? "Change reference"
                : "Replace value"}
            </DialogTitle>
            <DialogDescription>
              {selectedSecret?.managedMode !== "external_reference"
                ? "Agents get the new value from their next run. The old one is kept as an earlier version."
                : rotateMode === "reference"
                  ? "Points Paperclip at a different secret in your vault. The value in the vault is not changed."
                  : "Writes the new value to the secret in your vault. Everything that reads that secret gets it, inside and outside Paperclip."}
            </DialogDescription>
          </DialogHeader>
          {selectedSecret && secretSupportsExternalValueWrite(selectedSecret) ? (
            <Tabs value={rotateMode} onValueChange={(value) => setRotateMode(value as RotateMode)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="value">Replace value</TabsTrigger>
                <TabsTrigger value="reference">Change reference</TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}
          <div>
            <label className="text-sm font-medium" htmlFor="rotate-secret-vault">Stored in</label>
            <select
              id="rotate-secret-vault"
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
              value={rotateProviderConfigId}
              onChange={(event) => setRotateProviderConfigId(event.target.value)}
            >
              <option value="">Paperclip&apos;s default</option>
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
              <p className="mt-1 text-(length:--text-micro) text-muted-foreground">
                Keeps using the storage this secret already has.
              </p>
            )}
          </div>
          {selectedSecret?.managedMode === "external_reference" && rotateMode === "reference" ? (
            <div>
              <label className="text-sm font-medium" htmlFor="rotate-ref">New ARN or path</label>
              <Input
                id="rotate-ref"
                value={rotateExternalRef}
                onChange={(event) => setRotateExternalRef(event.target.value)}
                placeholder={selectedSecret.externalRef ?? "Updated reference"}
                className="font-mono text-xs"
              />
              <p className="mt-1 text-(length:--text-micro) text-muted-foreground">
                Change the value in your vault first, then point Paperclip at it here.
              </p>
            </div>
          ) : (
            <div>
              <label className="text-sm font-medium" htmlFor="rotate-value">New value</label>
              <Textarea
                id="rotate-value"
                value={rotateValue}
                onChange={(event) => setRotateValue(event.target.value)}
                rows={3}
                className="font-mono text-xs"
                placeholder="Paste the new value"
              />
              {selectedSecret?.managedMode === "external_reference" ? (
                <p className="mt-1 text-(length:--text-micro) text-muted-foreground">
                  Written to <code className="font-mono">{selectedSecret.externalRef}</code> in the provider.
                </p>
              ) : null}
            </div>
          )}
          {rotateError ? <p className="text-xs text-destructive">{rotateError}</p> : null}
          <DialogFooter>
            <Button variant="ghost" className="sm:mr-auto" onClick={() => setRotateOpen(false)}>
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
                (selectedSecret?.managedMode === "external_reference" && rotateMode === "reference"
                  ? !rotateExternalRef.trim() && !selectedSecret?.externalRef
                  : !rotateValue)
              }
            >
              {rotateMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              {selectedSecret?.managedMode === "external_reference" && rotateMode === "reference"
                ? "Save reference"
                : "Save new value"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteConfirm)} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete secret</DialogTitle>
            <DialogDescription>
              Permanently removes <strong>{deleteConfirm?.name}</strong>. Agents and projects that use it will fail until you give them another secret.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" className="sm:mr-auto" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Delete secret
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
            <DialogTitle>Delete secret</DialogTitle>
            <DialogDescription>
              Permanently removes <strong>{definitionDeleteConfirm?.name}</strong> for the whole organization.
              Members' saved values stop being used, and agents that rely on it will fail until you give them another secret.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" className="sm:mr-auto" onClick={() => setDefinitionDeleteConfirm(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() =>
                definitionDeleteConfirm && deleteDefinitionMutation.mutate(definitionDeleteConfirm)
              }
              disabled={deleteDefinitionMutation.isPending}
            >
              {deleteDefinitionMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Delete secret
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
            <DialogTitle>Remove {removeVaultConfirm?.displayName}</DialogTitle>
            <DialogDescription>
              This removes the vault from Paperclip only.{" "}
              {removeVaultConfirm?.provider === "aws_secrets_manager"
                ? "Nothing is deleted in AWS."
                : "Nothing is deleted in the vault itself."}{" "}
              Secrets stored in it stop working until you move them to another vault.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" className="sm:mr-auto" onClick={() => setRemoveVaultConfirm(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => removeVaultConfirm && removeVaultMutation.mutate(removeVaultConfirm.id)}
              disabled={removeVaultMutation.isPending}
            >
              {removeVaultMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Remove vault
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}

function FilterChoices<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-0.5">
      <legend className="pb-1 text-xs font-medium text-muted-foreground">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-accent/50">
          <input
            type="radio"
            className="accent-primary"
            name={label}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

function SecretsFiltersPopover({
  statusFilter,
  providerFilter,
  providedByFilter,
  providers,
  onStatusChange,
  onProviderChange,
  onProvidedByChange,
}: {
  statusFilter: SecretStatusFilter;
  providerFilter: SecretProvider | "all";
  providedByFilter: ProvidedByFilter;
  providers: SecretProviderDescriptor[];
  onStatusChange: (value: SecretStatusFilter) => void;
  onProviderChange: (value: SecretProvider | "all") => void;
  onProvidedByChange: (value: ProvidedByFilter) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Filter className="mr-1 h-3.5 w-3.5" /> Filter
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-64 flex-col gap-4 p-3">
        <FilterChoices
          label="Provided by"
          value={providedByFilter}
          onChange={onProvidedByChange}
          options={[
            { value: "all", label: "Anyone" },
            { value: "company", label: "Organization" },
            { value: "user", label: "Each user" },
          ]}
        />
        {providers.length > 1 ? (
          <FilterChoices
            label="Stored in"
            value={providerFilter}
            onChange={onProviderChange}
            options={[
              { value: "all", label: "Any vault" },
              ...providers.map((provider) => ({
                value: provider.id,
                label: provider.id === "local_encrypted" ? "Paperclip" : provider.label,
              })),
            ]}
          />
        ) : null}
        <FilterChoices
          label="Status"
          value={statusFilter}
          onChange={onStatusChange}
          options={[
            { value: "current", label: "Active and disabled" },
            { value: "disabled", label: "Disabled only" },
            { value: "archived", label: "Archived" },
          ]}
        />
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
      <p className="mt-1 text-(length:--text-micro) text-muted-foreground">
        {config.isDefault ? "Default vault" : "Vault"} · {config.status.replace("_", " ")}
      </p>
    );
  }
  const warning = config.status === "warning" || config.healthStatus === "warning";
  return (
    <p className={cn("mt-1 flex items-center gap-1 text-(length:--text-micro)", warning ? "text-amber-600 dark:text-amber-400" : "text-destructive")}>
      {warning ? <AlertTriangle className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
      {message}
    </p>
  );
}

export function ProviderVaultsTab({
  providers,
  providerConfigs,
  secrets,
  loading,
  error,
  onRetry,
  onCreate,
  onEdit,
  onDisable,
  onEnable,
  onRemove,
  onSetDefault,
  onHealthCheck,
  onImportSecrets,
  pendingActionId,
  retrying = false,
}: {
  providers: SecretProviderDescriptor[];
  providerConfigs: CompanySecretProviderConfig[];
  /** When given, each vault shows how many secrets it holds. */
  secrets?: CompanySecret[];
  loading: boolean;
  /** The query error when the vault list could not load; null while data (even stale) is available. */
  error: unknown;
  onRetry: () => void;
  retrying?: boolean;
  onCreate: (provider: SecretProvider) => void;
  onEdit: (config: CompanySecretProviderConfig) => void;
  onDisable: (config: CompanySecretProviderConfig) => void;
  onEnable?: (config: CompanySecretProviderConfig) => void;
  onRemove: (config: CompanySecretProviderConfig) => void;
  onSetDefault: (config: CompanySecretProviderConfig) => void;
  onHealthCheck: (config: CompanySecretProviderConfig) => void;
  onImportSecrets: (config: CompanySecretProviderConfig) => void;
  pendingActionId: string | null;
}) {
  const secretCounts = useMemo(() => {
    if (!secrets) return null;
    const counts = new Map<string, number>();
    for (const secret of secrets) {
      const key = secret.providerConfigId ?? `built-in:${secret.provider}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [secrets]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading vaults
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-4">
        <QueryErrorState error={error} action="load vaults" onRetry={onRetry} retrying={retrying} />
      </div>
    );
  }

  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const orderedConfigs = PROVIDER_ORDER.flatMap((providerId) =>
    providerConfigs.filter((config) => config.provider === providerId),
  );
  // New secrets start in Paperclip's own storage unless the organization has a
  // usable Paperclip-encrypted vault, which then takes over as the default.
  const effectiveLocalDefaultId = getSelectableProviderConfig(providerConfigs, "local_encrypted")?.id ?? null;
  const builtInCount = secretCounts?.get("built-in:local_encrypted") ?? 0;

  return (
    <section aria-label="Vaults" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          Where secret values are kept. Paperclip encrypts them itself unless you connect a vault of your own.
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Plus className="mr-1 h-3.5 w-3.5" /> Add vault
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {PROVIDER_ORDER.map((providerId) => {
              const comingSoon = providerId === "gcp_secret_manager" || providerId === "vault";
              return (
                <DropdownMenuItem key={providerId} disabled={comingSoon} onSelect={() => onCreate(providerId)}>
                  {providerId === "local_encrypted"
                    ? "Paperclip-encrypted vault"
                    : providerMap.get(providerId)?.label ?? providerId.replaceAll("_", " ")}
                  {comingSoon ? <span className="ml-auto pl-4 text-xs text-muted-foreground">Coming soon</span> : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ul className="divide-y divide-border border-y border-border">
        <li className="flex items-start gap-3 px-3 py-3" data-testid="provider-vault-built-in">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Paperclip</span>
              {effectiveLocalDefaultId ? null : <Badge variant="secondary">Default</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">Encrypted and stored by Paperclip. Always available.</p>
          </div>
          {secretCounts ? (
            <span className="shrink-0 pt-0.5 text-sm tabular-nums text-muted-foreground">
              {builtInCount} {builtInCount === 1 ? "secret" : "secrets"}
            </span>
          ) : null}
          <span className="h-9 w-9 shrink-0" aria-hidden />
        </li>
        {orderedConfigs.map((config) => (
          <ProviderVaultCard
            key={config.id}
            config={config}
            providerName={vaultKindLabel(providers, config.provider)}
            isOverallDefault={config.id === effectiveLocalDefaultId}
            secretCount={secretCounts ? secretCounts.get(config.id) ?? 0 : null}
            pending={pendingActionId === config.id}
            onEdit={() => onEdit(config)}
            onDisable={() => onDisable(config)}
            onEnable={onEnable ? () => onEnable(config) : undefined}
            onRemove={() => onRemove(config)}
            onSetDefault={() => onSetDefault(config)}
            onHealthCheck={() => onHealthCheck(config)}
            onImportSecrets={() => onImportSecrets(config)}
          />
        ))}
      </ul>
    </section>
  );
}

function ProviderVaultCard({
  config,
  providerName,
  isOverallDefault,
  secretCount,
  pending,
  onEdit,
  onDisable,
  onEnable,
  onRemove,
  onSetDefault,
  onHealthCheck,
  onImportSecrets,
}: {
  config: CompanySecretProviderConfig;
  providerName: string;
  /** True for the vault a new secret lands in when nobody picks one. */
  isOverallDefault: boolean;
  secretCount: number | null;
  pending: boolean;
  onEdit: () => void;
  onDisable: () => void;
  onEnable?: () => void;
  onRemove: () => void;
  onSetDefault: () => void;
  onHealthCheck: () => void;
  onImportSecrets: () => void;
}) {
  const blockReason = getProviderConfigBlockReason(config);
  const details = config.healthDetails;
  const Icon = providerFamilyIcon(config.provider);
  const unavailable = config.status === "disabled" || config.status === "coming_soon";
  return (
    <li className="flex items-start gap-3 px-3 py-3" data-testid={`provider-vault-${config.id}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">{config.displayName}</h3>
          <span className="text-sm text-muted-foreground">{providerName}</span>
          {isOverallDefault ? (
            <Badge variant="secondary">Default</Badge>
          ) : config.isDefault && config.provider !== "local_encrypted" ? (
            <Badge variant="outline" className="text-muted-foreground">Default for {providerName}</Badge>
          ) : null}
          {config.status === "disabled" ? (
            <Badge variant="outline" className="text-muted-foreground">Disabled</Badge>
          ) : config.status === "coming_soon" ? (
            <Badge variant="outline" className="text-muted-foreground">Not available yet</Badge>
          ) : null}
        </div>
        {unavailable ? (
          <p className="text-xs text-muted-foreground">
            {config.status === "disabled"
              ? "Secrets can't be stored in or read from this vault while it is disabled."
              : "Paperclip can't store or read secrets here yet."}
          </p>
        ) : blockReason ? (
          <div className="flex flex-col gap-1 text-sm text-destructive" role="alert">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {blockReason}
              <Button variant="outline" size="xs" className="text-foreground" onClick={onHealthCheck} disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : null}
                Check again
              </Button>
            </p>
            {details?.guidance?.length ? (
              <ul className="list-disc pl-9 text-xs">
                {details.guidance.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : config.healthStatus ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {config.healthStatus === "warning" ? (
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            )}
            {config.healthStatus === "warning" ? config.healthMessage ?? "Working, with a warning" : "Working"} · checked{" "}
            {formatRelative(config.healthCheckedAt)}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Not checked yet</p>
        )}
      </div>
      {secretCount !== null ? (
        <span className="shrink-0 pt-0.5 text-sm tabular-nums text-muted-foreground">
          {secretCount} {secretCount === 1 ? "secret" : "secrets"}
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="-mt-1.5 shrink-0 text-muted-foreground"
            aria-label={`Actions for ${config.displayName}`}
            disabled={pending}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={onEdit}>
            <Edit3 className="h-4 w-4" /> Edit connection
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onHealthCheck}>
            <RefreshCw className="h-4 w-4" /> Check connection
          </DropdownMenuItem>
          {config.provider === "aws_secrets_manager" ? (
            <DropdownMenuItem
              onSelect={onImportSecrets}
              disabled={Boolean(blockReason)}
              data-testid={`provider-vault-refresh-secrets-${config.id}`}
            >
              <Cloud className="h-4 w-4" /> Import secrets from it
            </DropdownMenuItem>
          ) : null}
          {config.isDefault || blockReason ? null : (
            <DropdownMenuItem onSelect={onSetDefault}>
              <Star className="h-4 w-4" /> Make default
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {config.status === "disabled" ? (
            onEnable ? (
              <DropdownMenuItem onSelect={onEnable}>
                <CheckCircle2 className="h-4 w-4" /> Enable
              </DropdownMenuItem>
            ) : null
          ) : (
            <DropdownMenuItem onSelect={onDisable}>
              <Ban className="h-4 w-4" /> Disable
            </DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>
            <Trash2 className="h-4 w-4" /> Remove vault
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
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
      <label className="flex items-start gap-2.5 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={form.backupReminderAcknowledged}
          onCheckedChange={(checked) => setField("backupReminderAcknowledged", checked === true)}
        />
        <span>
          I understand that restoring a backup needs both the database and Paperclip&apos;s encryption key file.
        </span>
      </label>
    );
  }

  if (form.provider === "aws_secrets_manager") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
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
          <p className="text-sm font-medium">Check access</p>
          <p className="text-xs text-muted-foreground">
            Looks at secret names and tags in this region to confirm Paperclip can reach it and to suggest naming
            settings. Values are not read.
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
          Check AWS
        </Button>
      </div>

      {!canDiscover ? (
        <p className="text-xs text-muted-foreground">Enter an AWS region first.</p>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking AWS
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
        <p className="text-xs text-muted-foreground">
          Paperclip reached AWS. There was nothing to suggest, so fill in naming settings yourself if you need them.
        </p>
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

/**
 * Copy the safe error payload out of a failure panel. People copy this to paste
 * into a bug report, so the button has to confirm the clipboard took it.
 */
function CopyDetailsButton({ text }: { text: string }) {
  const { copied, failed, copy } = useCopyAction();
  return (
    <Button type="button" variant="ghost" size="sm" onClick={() => void copy(text)}>
      {copied ? "Copied" : failed ? "Copy failed" : "Copy"}
    </Button>
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
              <CopyDetailsButton text={detailsText} />
            </div>
            <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-(length:--text-micro) leading-relaxed">
              {detailsText}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function SecretCreateError({
  error,
  provider,
  providerConfigId,
}: {
  error: unknown;
  provider: SecretProvider;
  providerConfigId: string | null;
}) {
  const details = apiErrorDetails(error);
  const message = readableErrorMessage(error);
  const isAwsCreateError =
    details?.provider === "aws_secrets_manager" && details.operation === "secret.create";
  const isAccessDenied = isAwsCreateError && details.code === "access_denied";
  const safeDetails = {
    message,
    status: error instanceof ApiError ? error.status : undefined,
    provider: details?.provider ?? provider,
    operation: details?.operation ?? "secret.create",
    providerConfigId: details?.providerConfigId ?? providerConfigId ?? "deployment-default",
    region: details?.region,
    code: details?.code,
    requiredCapability: details?.requiredCapability,
    credentialPath: details?.credentialPath,
    safeAlternative: details?.safeAlternative,
  };
  const detailsText = JSON.stringify(safeDetails, null, 2);

  if (!isAwsCreateError) {
    return (
      <p className="text-xs text-destructive" role="alert" data-testid="secret-create-error">
        {message}
      </p>
    );
  }

  return (
    <div
      className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
      role="alert"
      data-testid="secret-create-error"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="font-medium">
              {isAccessDenied ? "AWS secret creation needs CreateSecret permission" : "AWS secret creation failed"}
            </p>
            <p className="mt-1 leading-relaxed text-destructive/85">
              {details?.actionableMessage ?? message}
            </p>
          </div>
          {details?.safeAlternative ? (
            <p className="leading-relaxed text-destructive/85">{details.safeAlternative}</p>
          ) : null}
          <dl className="grid gap-1 text-destructive/80 sm:grid-cols-2">
            {details?.requiredCapability ? (
              <div>
                <dt className="font-medium">Required IAM capability</dt>
                <dd className="font-mono">{details.requiredCapability}</dd>
              </div>
            ) : null}
            {details?.region ? (
              <div>
                <dt className="font-medium">Region</dt>
                <dd>{details.region}</dd>
              </div>
            ) : null}
            <div>
              <dt className="font-medium">Provider vault</dt>
              <dd className="break-all">{details?.providerConfigId ?? providerConfigId ?? "Deployment default"}</dd>
            </div>
            <div>
              <dt className="font-medium">Operation</dt>
              <dd>{details?.operation ?? "secret.create"}</dd>
            </div>
          </dl>
          <div className="rounded-md border border-destructive/20 bg-background/70 p-2 text-foreground">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-medium text-muted-foreground">Safe request/error details</span>
              <CopyDetailsButton text={detailsText} />
            </div>
            <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-(length:--text-micro) leading-relaxed">
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
            <p className="mt-1 truncate font-mono text-(length:--text-micro) text-muted-foreground">
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
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
        {required ? null : <span className="font-normal text-muted-foreground"> (optional)</span>}
      </label>
      <Input id={id} className="mt-1.5" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
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
  const coverageView = useQueryView(coverageQuery);
  const summary = coverageQuery.data;
  if (coverageQuery.isPending || coverageView.kind === "reconnecting") {
    return compact ? null : <span className="text-muted-foreground">Loading…</span>;
  }
  if (coverageView.kind === "error") return compact ? null : <span className="text-destructive">Coverage unavailable</span>;
  if (compact) {
    if (!summary) return null;
    const total = summary.configuredCount + summary.missingCount + summary.inactiveCount;
    return (
      <>
        {summary.configuredCount} of {total} added
      </>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
      <Users className="h-3 w-3" />
      <span className="truncate">{coverageSummaryLabel(summary)}</span>
      {summary && summary.missingCount > 0 ? (
        <span className="shrink-0">· {summary.missingCount} missing</span>
      ) : null}
    </span>
  );
}

const detailSectionTitle = "text-xs font-medium text-muted-foreground";

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className={detailSectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

function UserSecretDetailsTab({ definition }: { definition: UserSecretDefinition }) {
  return (
    <dl className="flex flex-col text-sm">
      <DetailRow label="Provided by">Each user</DetailRow>
      <DetailRow label="Description">
        {definition.description ?? <span className="text-muted-foreground">—</span>}
      </DetailRow>
      <DetailRow label="Instructions">
        {definition.usageGuidance ?? <span className="text-muted-foreground">—</span>}
      </DetailRow>
      <DetailRow label="Created">{formatRelative(definition.createdAt)}</DetailRow>
      <DetailRow label="Updated">{formatRelative(definition.updatedAt)}</DetailRow>
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
  const coverageView = useQueryView(coverageQuery);
  if (coverageQuery.isPending || coverageView.kind === "reconnecting") {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (coverageView.kind === "error" || !coverageQuery.data) {
    return <p className="text-sm text-muted-foreground">Member counts are unavailable right now.</p>;
  }
  const summary: UserSecretCoverageSummary = coverageQuery.data;
  const total = summary.configuredCount + summary.missingCount + summary.inactiveCount;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>
        {summary.configuredCount} of {total} {total === 1 ? "member has" : "members have"} added their value.
      </p>
      {summary.inactiveCount > 0 ? (
        <p className="text-muted-foreground">
          {summary.inactiveCount} {summary.inactiveCount === 1 ? "value is" : "values are"} turned off.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Members without a value are asked for one when an agent working for them needs it. Each person adds theirs
        under My secrets.
      </p>
    </div>
  );
}

function AgentAccessSection({
  companyId,
  reference,
}: {
  companyId: string;
  reference: AgentAccessReference;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [addOpen, setAddOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [envKey, setEnvKey] = useState("");
  const [envKeyDirty, setEnvKeyDirty] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const referenceId = reference.kind === "company" ? reference.secret.id : reference.definition.id;
  const referenceName = reference.kind === "company" ? reference.secret.name : reference.definition.name;

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    staleTime: 30_000,
  });
  const agentsView = useQueryView(agentsQuery);
  const agents = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => agent.status !== "terminated"),
    [agentsQuery.data],
  );
  const agentAccess = useMemo(
    () =>
      agents
        .map((agent) => {
          const adapterConfig = (agent.adapterConfig as Record<string, unknown> | null) ?? null;
          return {
            agent,
            envKeys: envKeysReferencingSecret(adapterConfig?.env, reference),
            apiAliases: apiAliasesReferencingSecret(adapterConfig, reference),
          };
        })
        .filter((entry) => entry.envKeys.length > 0 || entry.apiAliases.length > 0),
    [agents, reference],
  );
  const grantableAgents = useMemo(
    () => agents.filter((agent) => !agentAccess.some((entry) => entry.agent.id === agent.id)),
    [agents, agentAccess],
  );

  const effectiveEnvKey = envKeyDirty
    ? envKey
    : reference.kind === "user"
      ? reference.definition.key
      : envKeyFromSecretName(secretLeafName(referenceName));

  useEffect(() => {
    setAddOpen(false);
    setSelectedAgentId("");
    setEnvKey("");
    setEnvKeyDirty(false);
    setAccessError(null);
  }, [referenceId]);

  function invalidateAfterChange(agentId: string) {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
    if (reference.kind === "company") {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.usage(reference.secret.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
    }
  }

  const grantMutation = useMutation({
    mutationFn: ({ agentId, key }: { agentId: string; key: string }) =>
      grantAgentSecretAccess({ companyId, agentId, envKey: key, reference }),
    onSuccess: (agent, variables) => {
      setAddOpen(false);
      setSelectedAgentId("");
      setEnvKey("");
      setEnvKeyDirty(false);
      setAccessError(null);
      invalidateAfterChange(variables.agentId);
      pushToast({ title: "Access granted", body: `${agent.name} now receives ${variables.key}`, tone: "success" });
    },
    onError: (error) => setAccessError(readableErrorMessage(error)),
  });

  const revokeMutation = useMutation({
    mutationFn: ({ agentId }: { agentId: string }) => revokeAgentSecretAccess({ companyId, agentId, reference }),
    onSuccess: (agent, variables) => {
      setAccessError(null);
      invalidateAfterChange(variables.agentId);
      pushToast({ title: "Access removed", body: agent.name, tone: "info" });
    },
    onError: (error) => setAccessError(readableErrorMessage(error)),
  });

  const envKeyValid = ENV_KEY_PATTERN.test(effectiveEnvKey);
  const canGrant = Boolean(selectedAgentId) && envKeyValid && !grantMutation.isPending;
  const loading = agentsQuery.isPending || agentsView.kind === "reconnecting";
  const unavailable = agentsView.kind === "error";

  return (
    <section className="flex flex-col gap-2" aria-label="Agents that can use it">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className={detailSectionTitle}>Agents that can use it</h3>
        {!loading && !unavailable ? (
          <Popover open={addOpen} onOpenChange={setAddOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="xs">
                <Plus /> Add agent
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="flex w-72 flex-col gap-3 p-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" htmlFor="agent-access-agent">
                  Agent
                </label>
                <AgentSelect
                  id="agent-access-agent"
                  agents={grantableAgents}
                  value={selectedAgentId}
                  onChange={setSelectedAgentId}
                  emptyMessage="Every agent already has access."
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" htmlFor="agent-access-env-key">
                  Environment variable
                </label>
                <Input
                  id="agent-access-env-key"
                  value={effectiveEnvKey}
                  onChange={(event) => {
                    setEnvKeyDirty(true);
                    setEnvKey(event.target.value.toUpperCase());
                  }}
                  className="font-mono"
                  placeholder="MY_SECRET"
                />
                {effectiveEnvKey && !envKeyValid ? (
                  <p className="text-xs text-destructive">
                    Use letters, digits and underscores, and don&apos;t start with a digit.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">The name the agent reads it under.</p>
                )}
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  disabled={!canGrant}
                  onClick={() => grantMutation.mutate({ agentId: selectedAgentId, key: effectiveEnvKey })}
                >
                  {grantMutation.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  Give access
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading agents…</p>
      ) : unavailable ? (
        <p className="text-sm text-muted-foreground">
          The agent list is unavailable. Manage access from each agent&apos;s settings instead.
        </p>
      ) : agentAccess.length > 0 ? (
        <ul className="flex flex-col">
          {agentAccess.map(({ agent, envKeys, apiAliases }) => (
            <li key={agent.id} className="flex items-center gap-2.5 py-1.5">
              <AgentAvatar agent={agent} size={24} />
              <span className="min-w-0 flex-1 truncate text-sm">{agent.name}</span>
              <span className="min-w-0 shrink truncate font-mono text-xs text-muted-foreground">
                {[...envKeys, ...apiAliases.map((alias) => `API · ${alias}`)].join(", ")}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0 text-muted-foreground"
                aria-label={`Remove access for ${agent.name}`}
                disabled={revokeMutation.isPending}
                onClick={() => revokeMutation.mutate({ agentId: agent.id })}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No agent can use this secret yet.</p>
      )}
      {accessError ? (
        <p className="text-xs text-destructive" role="alert">
          {accessError}
        </p>
      ) : null}
      {!loading && !unavailable ? (
        <p className="text-xs text-muted-foreground">
          {reference.kind === "company"
            ? "An agent gets it as an environment variable when its run starts."
            : "An agent gets the value of the person it is working for when its run starts."}
        </p>
      ) : null}
    </section>
  );
}

function SecretDetailsTab({
  secret,
  providers,
  providerConfigs,
  onManageVaults,
}: {
  secret: CompanySecret;
  providers: SecretProviderDescriptor[];
  providerConfigs: CompanySecretProviderConfig[];
  onManageVaults?: () => void;
}) {
  const linked = secret.managedMode === "external_reference";
  const config = providerConfigs.find((candidate) => candidate.id === secret.providerConfigId) ?? null;
  const blockReason = getProviderConfigBlockReason(config);
  const provider = vaultKindLabel(providers, secret.provider);
  const vault = config
    ? `${config.displayName} · ${provider}`
    : secret.provider === "local_encrypted"
      ? "Paperclip"
      : provider;
  const canWriteExternalValue = Boolean(
    secret.externalRef && providers.find((candidate) => candidate.id === secret.provider)?.supportsExternalValueWrites,
  );
  return (
    <dl className="flex flex-col text-sm">
      <DetailRow label="Provided by">Organization</DetailRow>
      <DetailRow label={linked ? "Linked from" : "Stored in"}>
        {onManageVaults ? (
          <button type="button" className="text-left hover:underline" onClick={onManageVaults}>
            {vault}
          </button>
        ) : (
          vault
        )}
        {blockReason ? (
          <span className="mt-1 flex items-start gap-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {blockReason} Agents can&apos;t read this secret until the vault is fixed.
          </span>
        ) : null}
      </DetailRow>
      {secret.externalRef ? (
        <DetailRow label="Reference">
          <span className="break-all font-mono text-xs">{secret.externalRef}</span>
          {linked ? (
            <span className="mt-1 block text-xs text-muted-foreground">
              {modeDescription(secret.managedMode, canWriteExternalValue)}
            </span>
          ) : null}
        </DetailRow>
      ) : null}
      <DetailRow label="Description">
        {secret.description ?? <span className="text-muted-foreground">—</span>}
      </DetailRow>
      <DetailRow label={linked && !canWriteExternalValue ? "Reference changed" : "Value replaced"}>
        {formatRelative(secret.lastRotatedAt)}
        <span className="text-muted-foreground"> · version {secret.latestVersion}</span>
      </DetailRow>
      <DetailRow label="Last used">{formatRelative(secret.lastResolvedAt)}</DetailRow>
      <DetailRow label="Created">{formatRelative(secret.createdAt)}</DetailRow>
    </dl>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-(--gtc-55) gap-3 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

/** Every place the secret is set, including projects, environments and plugins. */
export function SecretUsageTab({ loading, bindings }: { loading: boolean; bindings: CompanySecretUsageBinding[] }) {
  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (bindings.length === 0) {
    return <p className="text-sm text-muted-foreground">Not set anywhere yet.</p>;
  }
  return (
    <ul className="flex flex-col">
      {bindings.map((binding) => {
        const deliveryMode = deliveryModeForConfigPath(binding.configPath);
        return (
          <li key={binding.id} className="flex flex-col gap-0.5 py-1.5 text-sm">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 capitalize text-muted-foreground">{binding.target.type.replaceAll("_", " ")}</span>
              {binding.target.href ? (
                <Link to={binding.target.href} className="truncate font-medium hover:underline">
                  {binding.target.label}
                </Link>
              ) : (
                <span className="truncate font-medium">{binding.target.label}</span>
              )}
              {binding.target.status ? (
                <span className="shrink-0 text-xs text-muted-foreground">· {binding.target.status.replaceAll("_", " ")}</span>
              ) : null}
            </span>
            <span className="break-all text-xs text-muted-foreground">
              {deliveryModeLabel(deliveryMode)}{" "}
              <span className="font-mono">
                {deliveryMode === "api" ? aliasFromConfigPath(binding.configPath) : binding.configPath}
              </span>
              {binding.required ? "" : " · optional"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const ACCESS_OUTCOME_TEXT: Record<SecretAccessEvent["outcome"], string> = {
  success: "used it",
  failure: "could not read it",
  missing: "asked for it, but no value was set",
  inactive: "asked for it while it was turned off",
  not_allowed: "was refused: no access",
  optional_omitted: "ran without it",
  provider_error: "could not read it: the vault did not answer",
};

const ACTIVITY_PREVIEW_COUNT = 5;

/** Recent reads of the secret, newest first. Values are never part of an entry. */
export function SecretEventsTab({
  loading,
  events,
  companyId,
  agents,
}: {
  loading: boolean;
  events: SecretAccessEvent[];
  companyId: string;
  agents?: readonly Agent[];
}) {
  const [showAll, setShowAll] = useState(false);
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
  const agentNames = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent.name])), [agents]);
  const userLabel = (userId: string | null): string => {
    if (!userId) return "someone";
    const entry: CompanyUserDirectoryEntry | undefined = directory?.users.find(
      (u) => u.principalId === userId,
    );
    return entry?.user?.name?.trim() || entry?.user?.email?.trim() || "a member";
  };
  const actorLabel = (event: SecretAccessEvent): string =>
    agentNames.get(event.consumerId) ??
    (event.actorId ? agentNames.get(event.actorId) : undefined) ??
    consumerTypeLabel(event.consumerType);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity yet. Each time an agent reads it, that shows here.</p>;
  }
  const visible = showAll ? events : events.slice(0, ACTIVITY_PREVIEW_COUNT);
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col">
        {visible.map((event) => (
          <li key={event.id} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
            <span className={cn("min-w-0", event.outcome !== "success" && event.outcome !== "optional_omitted" && "text-destructive")}>
              {actorLabel(event)} {ACCESS_OUTCOME_TEXT[event.outcome] ?? event.outcome}
              {event.responsibleUserId ? (
                <span className="text-muted-foreground"> · for {userLabel(event.responsibleUserId)}</span>
              ) : null}
              {event.credentialOwnerUserId && event.credentialOwnerUserId !== event.responsibleUserId ? (
                <span className="text-muted-foreground"> · value from {userLabel(event.credentialOwnerUserId)}</span>
              ) : null}
              {event.errorCode ? <span className="block font-mono text-xs">{event.errorCode}</span> : null}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatRelative(event.createdAt)}</span>
          </li>
        ))}
      </ul>
      {!showAll && events.length > ACTIVITY_PREVIEW_COUNT ? (
        <button
          type="button"
          className="self-start text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          onClick={() => setShowAll(true)}
        >
          Show all activity
        </button>
      ) : null}
    </div>
  );
}
