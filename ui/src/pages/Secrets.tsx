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
  Database,
  Edit3,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  X,
  Filter,
  Info,
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
import { useTranslation } from "@/i18n";
import { cn } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { ImportFromVaultDialog } from "./secrets/ImportFromVaultDialog";

type CreateMode = "managed" | "external";
type SecretsTab = "secrets" | "vaults";

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


function modeLabel(managedMode: SecretManagedMode, t: (key: string, opts?: Record<string, unknown>) => string) {
  return managedMode === "paperclip_managed"
    ? t("secrets.modeLabel.managed", { defaultValue: "Paperclip-managed" })
    : t("secrets.modeLabel.external", { defaultValue: "Linked external" });
}

function modeDescription(managedMode: SecretManagedMode, t: (key: string, opts?: Record<string, unknown>) => string) {
  return managedMode === "paperclip_managed"
    ? t("secrets.modeDescription.managed", {
        defaultValue: "Paperclip owns create and rotation writes for this provider secret.",
      })
    : t("secrets.modeDescription.external", {
        defaultValue: "Paperclip resolves this provider reference but does not rotate the provider value.",
      });
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
  t?: (key: string, opts?: Record<string, unknown>) => string,
) {
  const tr = t ?? ((_k: string, opts?: Record<string, unknown>) => String((opts as { defaultValue?: string } | undefined)?.defaultValue ?? ""));
  if (!provider) return tr("secrets.blockReason.selectProvider", { defaultValue: "Select a provider." });
  if (mode === "managed" && provider.supportsManagedValues === false) {
    return tr("secrets.blockReason.noManagedSupport", {
      defaultValue: "{{label}} does not support Paperclip-managed secret values.",
      label: provider.label,
    });
  }
  if (mode === "external" && provider.supportsExternalReferences === false) {
    return tr("secrets.blockReason.noExternalSupport", {
      defaultValue: "{{label}} does not support linked external references.",
      label: provider.label,
    });
  }
  if (provider.configured === false) {
    const healthEntry = healthEntryForProvider(health, provider.id);
    return healthEntry?.message
      ? tr("secrets.blockReason.notConfiguredWithMessage", {
          defaultValue: "{{label}} is not configured in this deployment. {{message}}",
          label: provider.label,
          message: healthEntry.message,
        })
      : tr("secrets.blockReason.notConfigured", {
          defaultValue: "{{label}} is not configured in this deployment.",
          label: provider.label,
        });
  }
  const healthEntry = healthEntryForProvider(health, provider.id);
  if (healthEntry?.status === "error") {
    return tr("secrets.blockReason.healthCheckFailed", {
      defaultValue: "{{label}} health check failed: {{message}}",
      label: provider.label,
      message: healthEntry.message,
    });
  }
  return null;
}

function providerHealthText(
  provider: SecretProviderDescriptor | null | undefined,
  health: SecretProviderHealthResponse | null,
) {
  if (!provider) return null;
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
  t?: (key: string, opts?: Record<string, unknown>) => string,
) {
  const tr = t ?? ((_k: string, opts?: Record<string, unknown>) => String((opts as { defaultValue?: string } | undefined)?.defaultValue ?? ""));
  if (!config) return null;
  if (config.status === "disabled") return tr("secrets.vaultBlock.disabled", { defaultValue: "This provider vault is disabled." });
  if (config.status === "coming_soon") return tr("secrets.vaultBlock.comingSoon", { defaultValue: "This provider vault is saved as draft metadata only." });
  if (config.healthStatus === "error") {
    return config.healthMessage ?? tr("secrets.vaultBlock.healthFailed", { defaultValue: "This provider vault health check failed." });
  }
  return null;
}

export function getDefaultProviderConfigId(
  configs: CompanySecretProviderConfig[],
  provider: SecretProvider,
) {
  const providerConfigs = configs.filter((config) => config.provider === provider);
  const selectable = providerConfigs.filter((config) => !getProviderConfigBlockReason(config));
  return (
    selectable.find((config) => config.isDefault)?.id ??
    selectable[0]?.id ??
    providerConfigs.find((config) => config.isDefault)?.id ??
    ""
  );
}

function providerVaultLabel(
  configs: CompanySecretProviderConfig[],
  id: string | null | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
) {
  if (!id) return t("secrets.deploymentDefault", { defaultValue: "Deployment default" });
  return (
    configs.find((config) => config.id === id)?.displayName ??
    t("secrets.unknownVault", { defaultValue: "Unknown vault" })
  );
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
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const [activeTab, setActiveTab] = useState<SecretsTab>("secrets");
  const [secretDetailTab, setSecretDetailTab] = useState("details");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SecretStatus | "all">("active");
  const [providerFilter, setProviderFilter] = useState<SecretProvider | "all">("all");
  const [selectedSecretId, setSelectedSecretId] = useState<string | null>(null);
  const [usageDialogSecretId, setUsageDialogSecretId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>("managed");
  const [createForm, setCreateForm] = useState({
    name: "",
    key: "",
    value: "",
    description: "",
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
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const [editingVault, setEditingVault] = useState<CompanySecretProviderConfig | null>(null);
  const [removeVaultConfirm, setRemoveVaultConfirm] = useState<CompanySecretProviderConfig | null>(null);
  const [vaultForm, setVaultForm] = useState<ProviderVaultForm>(() => emptyProviderVaultForm());
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [vaultDiscovery, setVaultDiscovery] =
    useState<SecretProviderConfigDiscoveryPreviewResult | null>(null);
  const [vaultDiscoveryError, setVaultDiscoveryError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: t("secrets.title", { defaultValue: "Secrets" }) }]);
  }, [setBreadcrumbs, t]);

  const secretsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.list(selectedCompanyId)
      : ["secrets", "__disabled__"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
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

  const secrets = secretsQuery.data ?? [];
  const providers = providersQuery.data ?? [];
  const providerConfigs = providerConfigsQuery.data ?? [];
  const selectedSecret = useMemo(
    () => secrets.find((secret) => secret.id === selectedSecretId) ?? null,
    [secrets, selectedSecretId],
  );
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
    t,
  ) ?? getProviderConfigBlockReason(selectedCreateProviderConfig, t);
  const rotateProviderBlockReason = getProviderConfigBlockReason(selectedRotateProviderConfig, t);
  const createProviderHealthText = providerHealthText(
    selectedCreateProvider,
    providerHealthQuery.data ?? null,
  );
  const awsManagedPathPreview = getAwsManagedPathPreview({
    provider: selectedCreateProvider,
    health: providerHealthQuery.data ?? null,
    companyId: selectedCompanyId ?? "{companyId}",
    secretKeySource: createForm.key.trim() || createForm.name,
  });

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return secrets.filter((secret) => {
      if (statusFilter !== "all" && secret.status !== statusFilter) return false;
      if (providerFilter !== "all" && secret.provider !== providerFilter) return false;
      if (!needle) return true;
      return (
        secret.name.toLowerCase().includes(needle) ||
        secret.key.toLowerCase().includes(needle) ||
        (secret.description?.toLowerCase().includes(needle) ?? false) ||
        (secret.externalRef?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [secrets, search, statusFilter, providerFilter]);
  const activeSecretFilterCount = (statusFilter === "active" ? 0 : 1) + (providerFilter === "all" ? 0 : 1);

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
    queryClient.invalidateQueries({ queryKey: queryKeys.secrets.providerConfigs(selectedCompanyId) });
    for (const id of extraIds) {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.usage(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.accessEvents(id) });
    }
  }

  const createMutation = useMutation({
    mutationFn: () => {
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
      return secretsApi.create(selectedCompanyId!, input);
    },
    onSuccess: (created) => {
      pushToast({
        title: t("secrets.toast.secretCreated", { defaultValue: "Secret created" }),
        body: created.name,
        tone: "success",
      });
      setCreateOpen(false);
      setCreateForm({
        name: "",
        key: "",
        value: "",
        description: "",
        externalRef: "",
        provider: createForm.provider,
        providerConfigId: getDefaultProviderConfigId(providerConfigs, createForm.provider),
      });
      setCreateError(null);
      setSelectedSecretId(created.id);
      invalidateAll([created.id]);
    },
    onError: (error) => {
      setCreateError(error instanceof ApiError ? error.message : (error as Error).message);
    },
  });

  const rotateMutation = useMutation({
    mutationFn: () => {
      if (!selectedSecret) throw new Error(t("secrets.error.selectFirst", { defaultValue: "Select a secret first" }));
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
      pushToast({
        title: t("secrets.toast.rotated", { defaultValue: "Rotated" }),
        body: `${updated.name} → v${updated.latestVersion}`,
        tone: "success",
      });
      setRotateOpen(false);
      setRotateValue("");
      setRotateExternalRef("");
      setRotateProviderConfigId("");
      setRotateError(null);
      invalidateAll([updated.id]);
    },
    onError: (error) => {
      setRotateError(error instanceof Error ? error.message : t("secrets.error.rotateFailed", { defaultValue: "Rotate failed" }));
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
      pushToast({
        title: t("secrets.toast.statusChanged", { defaultValue: "Secret {{status}}", status: updated.status }),
        body: updated.name,
        tone: "info",
      });
      invalidateAll([updated.id]);
    },
    onError: (error) => {
      pushToast({
        title: t("secrets.toast.statusUpdateFailed", { defaultValue: "Status update failed" }),
        body: error instanceof Error ? error.message : t("secrets.tryAgain", { defaultValue: "Try again" }),
        tone: "error",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => secretsApi.remove(id),
    onSuccess: (_response, id) => {
      pushToast({ title: t("secrets.toast.secretDeleted", { defaultValue: "Secret deleted" }), tone: "info" });
      setDeleteConfirm(null);
      if (selectedSecretId === id) setSelectedSecretId(null);
      invalidateAll([id]);
    },
    onError: (error) => {
      pushToast({
        title: t("secrets.toast.deleteFailed", { defaultValue: "Delete failed" }),
        body: error instanceof Error ? error.message : t("secrets.tryAgain", { defaultValue: "Try again" }),
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
      pushToast({
        title: editingVault
          ? t("secrets.toast.vaultUpdated", { defaultValue: "Provider vault updated" })
          : t("secrets.toast.vaultCreated", { defaultValue: "Provider vault created" }),
        body: saved.displayName,
        tone: "success",
      });
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
      setVaultDiscoveryError(error instanceof ApiError ? error.message : (error as Error).message);
    },
  });

  const disableVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.disableProviderConfig(id),
    onSuccess: (updated) => {
      pushToast({
        title: t("secrets.toast.vaultDisabled", { defaultValue: "Provider vault disabled" }),
        body: updated.displayName,
        tone: "info",
      });
      invalidateAll();
    },
    onError: (error) => {
      pushToast({
        title: t("secrets.toast.disableFailed", { defaultValue: "Disable failed" }),
        body: error instanceof Error ? error.message : t("secrets.tryAgain", { defaultValue: "Try again" }),
        tone: "error",
      });
    },
  });

  const removeVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.removeProviderConfig(id),
    onSuccess: (removed) => {
      pushToast({
        title: t("secrets.toast.vaultRemoved", { defaultValue: "Provider vault removed" }),
        body: t("secrets.toast.vaultRemovedBody", {
          defaultValue: "{{name}} was removed from Paperclip only.",
          name: removed.displayName,
        }),
        tone: "info",
      });
      setRemoveVaultConfirm(null);
      invalidateAll();
    },
    onError: (error) => {
      pushToast({
        title: t("secrets.toast.removeFailed", { defaultValue: "Remove failed" }),
        body: error instanceof Error ? error.message : t("secrets.tryAgain", { defaultValue: "Try again" }),
        tone: "error",
      });
    },
  });

  const defaultVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.setDefaultProviderConfig(id),
    onSuccess: (updated) => {
      pushToast({
        title: t("secrets.toast.defaultVaultSet", { defaultValue: "Default vault set" }),
        body: updated.displayName,
        tone: "success",
      });
      invalidateAll();
    },
    onError: (error) => {
      pushToast({
        title: t("secrets.toast.defaultUpdateFailed", { defaultValue: "Default update failed" }),
        body: error instanceof Error ? error.message : t("secrets.tryAgain", { defaultValue: "Try again" }),
        tone: "error",
      });
    },
  });

  const healthVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.checkProviderConfigHealth(id),
    onSuccess: (health) => {
      pushToast({
        title: t("secrets.toast.healthChecked", { defaultValue: "Health checked" }),
        body: health.message,
        tone: health.status === "error" ? "error" : "info",
      });
      invalidateAll();
    },
    onError: (error) => {
      pushToast({
        title: t("secrets.toast.healthCheckFailed", { defaultValue: "Health check failed" }),
        body: error instanceof Error ? error.message : t("secrets.tryAgain", { defaultValue: "Try again" }),
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
      t,
    );
    if (!currentBlockReason) return;
    const replacement = providers.find(
      (provider) =>
        !getCreateProviderBlockReason(provider, createMode, providerHealthQuery.data ?? null, t),
    );
    if (replacement && replacement.id !== createForm.provider) {
      setCreateForm((current) => ({
        ...current,
        provider: replacement.id,
        providerConfigId: getDefaultProviderConfigId(providerConfigs, replacement.id),
      }));
    }
  }, [createForm.provider, createMode, createOpen, providerConfigs, providerHealthQuery.data, providers, t]);

  useEffect(() => {
    if (!createOpen) return;
    const current = providerConfigs.find((config) => config.id === createForm.providerConfigId);
    if (current?.provider === createForm.provider) return;
    setCreateForm((form) => ({
      ...form,
      providerConfigId: getDefaultProviderConfigId(providerConfigs, form.provider),
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

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t("secrets.selectCompany", { defaultValue: "Select a company to manage secrets." })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t("secrets.title", { defaultValue: "Secrets" })}</h1>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as SecretsTab)}
        className="flex min-h-0 flex-1 flex-col gap-4"
      >
        <PageTabBar
          items={[
            { value: "secrets", label: t("secrets.tabs.secrets", { defaultValue: "Secrets" }) },
            { value: "vaults", label: t("secrets.tabs.vaults", { defaultValue: "Provider vaults" }) },
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
                placeholder={t("secrets.searchPlaceholder", { defaultValue: "Search by name, key, ref" })}
                className="pl-7 text-xs sm:text-sm"
                aria-label={t("secrets.searchAria", { defaultValue: "Search secrets" })}
                data-page-search-target="true"
              />
            </div>
            <SecretsFiltersPopover
              statusFilter={statusFilter}
              providerFilter={providerFilter}
              providers={providers}
              activeFilterCount={activeSecretFilterCount}
              onStatusChange={setStatusFilter}
              onProviderChange={setProviderFilter}
            />
            <ImportFromVaultButton
              providerConfigs={providerConfigs}
              onClick={() => setImportOpen(true)}
              onManageVaults={() => setActiveTab("vaults")}
              className="ml-auto"
            />
            <Button onClick={() => setCreateOpen(true)} size="sm">
              <Plus className="h-3.5 w-3.5 mr-1" /> {t("secrets.newSecret", { defaultValue: "New secret" })}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {secretsQuery.isError ? (
              <div className="text-sm text-destructive flex items-center gap-2 py-4">
                <AlertCircle className="h-4 w-4" /> {t("secrets.error.loadFailed", { defaultValue: "Failed to load secrets:" })}{" "}
                {(secretsQuery.error as Error).message}
                <Button variant="ghost" size="sm" onClick={() => secretsQuery.refetch()}>
                  {t("secrets.retry", { defaultValue: "Retry" })}
                </Button>
              </div>
            ) : secrets.length === 0 && !secretsQuery.isPending ? (
              <EmptyState
                icon={KeyRound}
                message={t("secrets.emptyState", {
                  defaultValue: "No secrets yet. Create your first managed secret or link an external reference.",
                })}
                action={t("secrets.newSecret", { defaultValue: "New secret" })}
                onAction={() => setCreateOpen(true)}
              />
            ) : filtered.length === 0 ? (
              <EmptyState icon={Search} message={t("secrets.noMatchFilters", { defaultValue: "No secrets match your filters." })} />
            ) : (
              <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{t("secrets.table.name", { defaultValue: "Name" })}</th>
                  <th className="px-2 py-2 text-left font-medium">{t("secrets.table.mode", { defaultValue: "Mode" })}</th>
                  <th className="px-2 py-2 text-left font-medium">{t("secrets.table.provider", { defaultValue: "Provider" })}</th>
                  <th className="px-2 py-2 text-left font-medium">{t("secrets.table.status", { defaultValue: "Status" })}</th>
                  <th className="px-2 py-2 text-left font-medium">{t("secrets.table.version", { defaultValue: "Version" })}</th>
                  <th className="px-2 py-2 text-left font-medium">{t("secrets.table.lastRotated", { defaultValue: "Last rotated" })}</th>
                  <th className="px-2 py-2 text-left font-medium">{t("secrets.table.lastResolved", { defaultValue: "Last resolved" })}</th>
                  <th className="px-2 py-2 text-left font-medium">{t("secrets.table.references", { defaultValue: "References" })}</th>
                  <th className="px-2 py-2 text-left font-medium">{t("secrets.table.reference", { defaultValue: "Reference" })}</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((secret) => (
                  <tr
                    key={secret.id}
                    className={cn(
                      "border-b border-border/60 hover:bg-accent/40 cursor-pointer",
                      selectedSecretId === secret.id && "bg-accent/60",
                    )}
                    onClick={() => setSelectedSecretId(secret.id)}
                  >
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-foreground">{secret.name}</div>
                    </td>
                    <td className="px-2 py-2.5 text-xs text-muted-foreground">
                      {modeLabel(secret.managedMode, t)}
                    </td>
                    <td className="px-2 py-2.5 text-xs">
                      <div>{providerLabel(providers, secret.provider)}</div>
                    </td>
                    <td className="px-2 py-2.5">
                      <span className={cn("text-xs font-medium", statusTextTone(secret.status))}>
                        {t(`secrets.status.${secret.status}`, { defaultValue: secret.status })}
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-xs font-mono">v{secret.latestVersion}</td>
                    <td className="px-2 py-2.5 text-xs text-muted-foreground">
                      {formatRelative(secret.lastRotatedAt)}
                    </td>
                    <td className="px-2 py-2.5 text-xs text-muted-foreground">
                      {formatRelative(secret.lastResolvedAt)}
                    </td>
                    <td className="px-2 py-2.5 text-xs">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        aria-label={t("secrets.viewReferencesFor", {
                          defaultValue: "View references for {{name}}",
                          name: secret.name,
                        })}
                        onClick={(event) => {
                          event.stopPropagation();
                          setUsageDialogSecretId(secret.id);
                        }}
                      >
                        {secret.referenceCount ?? 0}
                      </Button>
                    </td>
                    <td className="px-2 py-2.5 text-xs">
                      {secret.managedMode === "external_reference" ? (
                        <span className="inline-flex items-center gap-1 font-mono text-muted-foreground">
                          <Link2 className="h-3 w-3" />
                          {secret.externalRef ?? "—"}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t("secrets.owned", { defaultValue: "Owned" })}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedSecretId(secret.id);
                        }}
                      >
                        {t("secrets.open", { defaultValue: "Open" })}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            )}
          </div>
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

      <Sheet open={Boolean(selectedSecret)} onOpenChange={(open) => !open && setSelectedSecretId(null)}>
        <SheetContent className="w-full sm:max-w-xl flex flex-col gap-0">
          {selectedSecret ? (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="h-4 w-4" />
                  {selectedSecret.name}
                  <span className={cn("ml-2 text-sm font-normal", statusTextTone(selectedSecret.status))}>
                    {t(`secrets.status.${selectedSecret.status}`, { defaultValue: selectedSecret.status })}
                  </span>
                </SheetTitle>
                <SheetDescription>
                  {providerLabel(providers, selectedSecret.provider)} · v{selectedSecret.latestVersion} · {modeLabel(selectedSecret.managedMode, t)}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-wrap gap-2 px-4 pb-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setRotateOpen(true);
                    setRotateValue("");
                    setRotateExternalRef("");
                    setRotateProviderConfigId(
                      selectedSecret.providerConfigId ??
                        getDefaultProviderConfigId(providerConfigs, selectedSecret.provider),
                    );
                    setRotateError(null);
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  {selectedSecret.managedMode === "external_reference"
                    ? t("secrets.updateReference", { defaultValue: "Update reference" })
                    : t("secrets.updateValue", { defaultValue: "Update value" })}
                </Button>
                {selectedSecret.status === "active" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => statusMutation.mutate({ id: selectedSecret.id, status: "disabled" })}
                    disabled={statusMutation.isPending}
                  >
                    <Ban className="h-3.5 w-3.5 mr-1" /> {t("secrets.disable", { defaultValue: "Disable" })}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => statusMutation.mutate({ id: selectedSecret.id, status: "active" })}
                    disabled={statusMutation.isPending}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> {t("secrets.activate", { defaultValue: "Activate" })}
                  </Button>
                )}
                {selectedSecret.status === "archived" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => statusMutation.mutate({ id: selectedSecret.id, status: "active" })}
                    disabled={statusMutation.isPending}
                  >
                    <ArchiveRestore className="h-3.5 w-3.5 mr-1" /> {t("secrets.unarchive", { defaultValue: "Unarchive" })}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => statusMutation.mutate({ id: selectedSecret.id, status: "archived" })}
                    disabled={statusMutation.isPending}
                  >
                    <Archive className="h-3.5 w-3.5 mr-1" /> {t("secrets.archive", { defaultValue: "Archive" })}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteConfirm(selectedSecret)}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" /> {t("companies.delete", { defaultValue: "Delete" })}
                </Button>
              </div>
              <Tabs value={secretDetailTab} onValueChange={setSecretDetailTab} className="flex-1 min-h-0 flex flex-col">
                <div className="border-b border-border px-4">
                  <PageTabBar
                    items={[
                      { value: "details", label: t("secrets.tabs.details", { defaultValue: "Details" }) },
                      {
                        value: "usage",
                        label: usageQuery.data
                          ? t("secrets.tabs.usageWithCount", {
                              defaultValue: "Usage ({{count}})",
                              count: usageQuery.data.bindings.length,
                            })
                          : t("secrets.tabs.usage", { defaultValue: "Usage" }),
                      },
                      { value: "events", label: t("secrets.tabs.accessEvents", { defaultValue: "Access events" }) },
                    ]}
                    align="start"
                    value={secretDetailTab}
                    onValueChange={setSecretDetailTab}
                  />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
                  <TabsContent value="details">
                    <SecretDetailsTab secret={selectedSecret} providerConfigs={providerConfigs} />
                  </TabsContent>
                  <TabsContent value="usage">
                    <SecretUsageTab loading={usageQuery.isPending} bindings={usageQuery.data?.bindings ?? []} />
                  </TabsContent>
                  <TabsContent value="events">
                    <SecretEventsTab loading={eventsQuery.isPending} events={eventsQuery.data ?? []} />
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
            <DialogTitle>{t("secrets.references.title", { defaultValue: "Secret references" })}</DialogTitle>
            <DialogDescription>
              {usageDialogSecret
                ? t("secrets.references.body", {
                    defaultValue: "{{name}} is referenced by {{count}} {{place}}.",
                    name: usageDialogSecret.name,
                    count: usageDialogSecret.referenceCount ?? 0,
                    place:
                      (usageDialogSecret.referenceCount ?? 0) === 1
                        ? t("secrets.references.place", { defaultValue: "place" })
                        : t("secrets.references.places", { defaultValue: "places" }),
                  })
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
          onOpenChange={setImportOpen}
          companyId={selectedCompanyId}
          providerConfigs={providerConfigs}
          existingSecrets={secrets}
          onManageVaults={() => {
            setImportOpen(false);
            setActiveTab("vaults");
          }}
          onImportComplete={() => {
            void secretsQuery.refetch();
          }}
        />
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("secrets.create.title", { defaultValue: "Create secret" })}</DialogTitle>
            <DialogDescription>
              {t("secrets.create.description", {
                defaultValue:
                  "Choose whether Paperclip should own future provider writes, or only resolve an existing provider reference at runtime.",
              })}
            </DialogDescription>
          </DialogHeader>
          <Tabs value={createMode} onValueChange={(value) => setCreateMode(value as CreateMode)}>
            <TabsList className="w-full grid grid-cols-2">
              <TabsTrigger value="managed">{t("secrets.create.managedTab", { defaultValue: "Managed value" })}</TabsTrigger>
              <TabsTrigger value="external">{t("secrets.create.externalTab", { defaultValue: "External reference" })}</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium" htmlFor="new-secret-name">{t("secrets.field.name", { defaultValue: "Name" })}</label>
                <Input
                  id="new-secret-name"
                  value={createForm.name}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="OPENAI_API_KEY"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-medium" htmlFor="new-secret-key">
                  {t("secrets.field.key", { defaultValue: "Key" })} <span className="text-muted-foreground/70">{t("secrets.optional", { defaultValue: "(optional)" })}</span>
                </label>
                <Input
                  id="new-secret-key"
                  value={createForm.key}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, key: event.target.value }))
                  }
                  placeholder={t("secrets.field.keyPlaceholder", { defaultValue: "auto from name" })}
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium" htmlFor="new-secret-provider">{t("secrets.field.provider", { defaultValue: "Provider" })}</label>
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
                      getCreateProviderBlockReason(provider, createMode, providerHealthQuery.data ?? null, t),
                    )}
                  >
                    {provider.label}
                    {provider.configured === false
                      ? ` ${t("secrets.providerSuffix.notConfigured", { defaultValue: "(not configured)" })}`
                      : provider.requiresExternalRef
                        ? ` ${t("secrets.providerSuffix.externalOnly", { defaultValue: "(external only)" })}`
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
              <label className="text-xs font-medium" htmlFor="new-secret-vault">{t("secrets.field.providerVault", { defaultValue: "Provider vault" })}</label>
              <select
                id="new-secret-vault"
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
                value={createForm.providerConfigId}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, providerConfigId: event.target.value }))
                }
              >
                <option value="">{t("secrets.deploymentDefault", { defaultValue: "Deployment default" })}</option>
                {createProviderConfigs.map((config) => {
                  const blockReason = getProviderConfigBlockReason(config, t);
                  return (
                    <option key={config.id} value={config.id} disabled={Boolean(blockReason)}>
                      {config.displayName}
                      {config.isDefault ? ` ${t("secrets.defaultSuffix", { defaultValue: "(default)" })}` : ""}
                      {blockReason ? ` (${blockReason})` : ""}
                    </option>
                  );
                })}
              </select>
              {selectedCreateProviderConfig ? (
                <ProviderVaultInlineWarning config={selectedCreateProviderConfig} />
              ) : (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("secrets.deploymentDefaultHint", {
                    defaultValue: "Existing deployment-level provider settings stay available for backwards compatibility.",
                  })}
                </p>
              )}
            </div>
            {createMode === "managed" ? (
              <>
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                  {t("secrets.create.managedHint", {
                    defaultValue:
                      "Paperclip-managed secrets are created in the selected provider and future rotations write a new provider version through Paperclip.",
                  })}
                  {awsManagedPathPreview ? (
                    <div className="mt-1">
                      {t("secrets.awsManagedPath", { defaultValue: "AWS managed path:" })}{" "}
                      <code className="break-all rounded bg-background/70 px-1 py-0.5">
                        {awsManagedPathPreview}
                      </code>
                    </div>
                  ) : null}
                </div>
                <div>
                  <label className="text-xs font-medium" htmlFor="new-secret-value">{t("secrets.field.value", { defaultValue: "Value" })}</label>
                  <Textarea
                    id="new-secret-value"
                    value={createForm.value}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, value: event.target.value }))
                    }
                    rows={3}
                    className="min-w-0 overflow-x-hidden break-all font-mono text-xs"
                    placeholder={t("secrets.field.valuePlaceholder", { defaultValue: "Stored once, never re-displayed" })}
                  />
                </div>
              </>
            ) : (
              <div>
                <label className="text-xs font-medium" htmlFor="new-secret-ref">{t("secrets.field.externalRef", { defaultValue: "External reference" })}</label>
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
                  {t("secrets.create.externalHint", {
                    defaultValue:
                      "Existing provider secrets are resolve-only in Paperclip. Rotate the value in the provider, then update this reference only if the path, ARN, or version changes.",
                  })}
                </p>
              </div>
            )}
            <div>
              <label className="text-xs font-medium" htmlFor="new-secret-description">
                {t("secrets.field.description", { defaultValue: "Description" })} <span className="text-muted-foreground/70">{t("secrets.optional", { defaultValue: "(optional)" })}</span>
              </label>
              <Input
                id="new-secret-description"
                value={createForm.description}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, description: event.target.value }))
                }
                placeholder={t("secrets.field.descriptionPlaceholder", { defaultValue: "What is this secret used for? (no values)" })}
              />
            </div>
            {createError ? <p className="text-xs text-destructive">{createError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("companies.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              onClick={() => {
                setCreateError(null);
                createMutation.mutate();
              }}
              disabled={
                createMutation.isPending ||
                Boolean(createProviderBlockReason) ||
                !createForm.name.trim() ||
                (createMode === "managed" ? !createForm.value : !createForm.externalRef.trim())
              }
            >
              {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              {createMode === "managed"
                ? t("secrets.create.submitManaged", { defaultValue: "Create secret" })
                : t("secrets.create.submitExternal", { defaultValue: "Link reference" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={vaultDialogOpen} onOpenChange={setVaultDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingVault
                ? t("secrets.vault.editTitle", { defaultValue: "Edit provider vault" })
                : t("secrets.vault.createTitle", { defaultValue: "Create provider vault" })}
            </DialogTitle>
            <DialogDescription>
              {t("secrets.vault.description", {
                defaultValue:
                  "Save only non-sensitive routing metadata. Credentials stay in the runtime environment or provider identity.",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium" htmlFor="vault-provider">{t("secrets.field.provider", { defaultValue: "Provider" })}</label>
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
                <label className="text-xs font-medium" htmlFor="vault-name">{t("secrets.vault.displayName", { defaultValue: "Display name" })}</label>
                <Input
                  id="vault-name"
                  value={vaultForm.displayName}
                  onChange={(event) =>
                    setVaultForm((current) => ({ ...current, displayName: event.target.value }))
                  }
                  placeholder={t("secrets.vault.displayNamePlaceholder", { defaultValue: "Production local vault" })}
                />
              </div>
              <div>
                <label className="text-xs font-medium" htmlFor="vault-status">{t("secrets.vault.status", { defaultValue: "Status" })}</label>
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
                    {t("secrets.vault.statusOption.ready", { defaultValue: "Ready" })}
                  </option>
                  <option value="warning" disabled={vaultForm.provider === "gcp_secret_manager" || vaultForm.provider === "vault"}>
                    {t("secrets.vault.statusOption.warning", { defaultValue: "Warning" })}
                  </option>
                  <option value="coming_soon">{t("secrets.vault.statusOption.comingSoon", { defaultValue: "Coming soon" })}</option>
                  <option value="disabled">{t("secrets.vault.statusOption.disabled", { defaultValue: "Disabled" })}</option>
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
                {t("secrets.vault.defaultFor", {
                  defaultValue: "Default for {{provider}}",
                  provider: providerLabel(providers, vaultForm.provider),
                })}
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
                {t("secrets.vault.draftOnlyHint", {
                  defaultValue:
                    "This provider can save draft routing metadata, but runtime writes and resolution stay disabled until the provider module is implemented and reviewed.",
                })}
              </div>
            ) : null}
            {vaultError ? <p className="text-xs text-destructive">{vaultError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVaultDialogOpen(false)}>
              {t("companies.cancel", { defaultValue: "Cancel" })}
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
              {editingVault
                ? t("secrets.vault.save", { defaultValue: "Save vault" })
                : t("secrets.vault.create", { defaultValue: "Create vault" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {selectedSecret?.managedMode === "external_reference"
                ? t("secrets.rotate.titleExternal", { defaultValue: "Update external reference" })
                : t("secrets.rotate.titleManaged", { defaultValue: "Update secret value" })}
            </DialogTitle>
            <DialogDescription>
              {selectedSecret?.managedMode === "external_reference"
                ? t("secrets.rotate.descriptionExternal", {
                    defaultValue:
                      "Creates a new Paperclip metadata version that points at an existing provider secret. Paperclip does not write a new provider value.",
                  })
                : t("secrets.rotate.descriptionManaged", {
                    defaultValue:
                      "Creates a new provider-backed version. Consumers pinned to latest pick up the new value on the next run.",
                  })}
            </DialogDescription>
          </DialogHeader>
          <div>
            <label className="text-xs font-medium" htmlFor="rotate-secret-vault">{t("secrets.field.providerVault", { defaultValue: "Provider vault" })}</label>
            <select
              id="rotate-secret-vault"
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
              value={rotateProviderConfigId}
              onChange={(event) => setRotateProviderConfigId(event.target.value)}
            >
              <option value="">{t("secrets.deploymentDefault", { defaultValue: "Deployment default" })}</option>
              {selectedRotateProviderConfigs.map((config) => {
                const blockReason = getProviderConfigBlockReason(config, t);
                return (
                  <option key={config.id} value={config.id} disabled={Boolean(blockReason)}>
                    {config.displayName}
                    {config.isDefault ? ` ${t("secrets.defaultSuffix", { defaultValue: "(default)" })}` : ""}
                    {blockReason ? ` (${blockReason})` : ""}
                  </option>
                );
              })}
            </select>
            {selectedRotateProviderConfig ? (
              <ProviderVaultInlineWarning config={selectedRotateProviderConfig} />
            ) : (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("secrets.rotate.defaultFallbackHint", {
                  defaultValue: "Rotating with the deployment default preserves current fallback behavior.",
                })}
              </p>
            )}
          </div>
          {selectedSecret?.managedMode === "external_reference" ? (
            <div>
              <label className="text-xs font-medium" htmlFor="rotate-ref">{t("secrets.field.externalRef", { defaultValue: "External reference" })}</label>
              <Input
                id="rotate-ref"
                value={rotateExternalRef}
                onChange={(event) => setRotateExternalRef(event.target.value)}
                placeholder={selectedSecret.externalRef ?? t("secrets.rotate.updatedReferencePlaceholder", { defaultValue: "Updated reference" })}
                className="font-mono text-xs"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("secrets.rotate.externalHint", {
                  defaultValue: "Rotate the actual value in the provider before changing this Paperclip reference.",
                })}
              </p>
            </div>
          ) : (
            <div>
              <label className="text-xs font-medium" htmlFor="rotate-value">{t("secrets.rotate.newValue", { defaultValue: "New value" })}</label>
              <Textarea
                id="rotate-value"
                value={rotateValue}
                onChange={(event) => setRotateValue(event.target.value)}
                rows={3}
                className="font-mono text-xs"
                placeholder={t("secrets.rotate.newValuePlaceholder", { defaultValue: "Paste the new value" })}
              />
            </div>
          )}
          {rotateError ? <p className="text-xs text-destructive">{rotateError}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateOpen(false)}>
              {t("companies.cancel", { defaultValue: "Cancel" })}
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
              {selectedSecret?.managedMode === "external_reference"
                ? t("secrets.updateReference", { defaultValue: "Update reference" })
                : t("secrets.updateValue", { defaultValue: "Update value" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteConfirm)} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("secrets.deleteDialog.title", { defaultValue: "Delete secret" })}</DialogTitle>
            <DialogDescription>
              {t("secrets.deleteDialog.bodyLead", { defaultValue: "Permanently removes " })}
              <strong>{deleteConfirm?.name}</strong>
              {t("secrets.deleteDialog.bodyTail", {
                defaultValue: ". Active bindings will fail until you remap them.",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>{t("companies.cancel", { defaultValue: "Cancel" })}</Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              {t("companies.delete", { defaultValue: "Delete" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(removeVaultConfirm)} onOpenChange={(open) => !open && setRemoveVaultConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("secrets.removeVault.title", { defaultValue: "Remove provider vault" })}</DialogTitle>
            <DialogDescription>
              {t("secrets.removeVault.bodyLead", { defaultValue: "Removes " })}
              <strong>{removeVaultConfirm?.displayName}</strong>
              {t("secrets.removeVault.bodyMid", { defaultValue: " from Paperclip only." })}{" "}
              {removeVaultConfirm?.provider === "aws_secrets_manager"
                ? t("secrets.removeVault.awsNotice", {
                    defaultValue: "This does not delete the remote AWS Secrets Manager vault, secrets, or any AWS data.",
                  })
                : t("secrets.removeVault.genericNotice", {
                    defaultValue: "This does not delete any remote provider data.",
                  })}{" "}
              {t("secrets.removeVault.tail", {
                defaultValue: "Secrets using this vault will lose the vault association until you assign another one.",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveVaultConfirm(null)}>{t("companies.cancel", { defaultValue: "Cancel" })}</Button>
            <Button
              variant="destructive"
              onClick={() => removeVaultConfirm && removeVaultMutation.mutate(removeVaultConfirm.id)}
              disabled={removeVaultMutation.isPending}
            >
              {removeVaultMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              {t("secrets.removeVault.confirm", { defaultValue: "Remove from Paperclip" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SecretsHowToUse() {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium text-foreground">
          {t("secrets.howTo.title", { defaultValue: "Use secrets by binding them to runtime environment variables." })}
        </p>
        <p>
          {t("secrets.howTo.line1Lead", {
            defaultValue: "Create or link a secret here, then open an agent's Environment variables or a project's Env field. Add the env key the process expects, for example ",
          })}
          <code className="font-mono">GH_TOKEN</code>
          {t("secrets.howTo.line1Mid", { defaultValue: ", choose " })}
          <span className="font-medium text-foreground">{t("secrets.howTo.secretLabel", { defaultValue: "Secret" })}</span>
          {t("secrets.howTo.line1Tail", { defaultValue: ", and select the stored secret version." })}
        </p>
        <p>
          {t("secrets.howTo.line2", {
            defaultValue:
              "Paperclip resolves the value server-side when the run starts and injects it as that env var. Project env applies to every issue in the project and overrides agent env on matching keys.",
          })}
        </p>
      </div>
    </div>
  );
}

function SecretsFiltersPopover({
  statusFilter,
  providerFilter,
  providers,
  activeFilterCount,
  onStatusChange,
  onProviderChange,
}: {
  statusFilter: SecretStatus | "all";
  providerFilter: SecretProvider | "all";
  providers: SecretProviderDescriptor[];
  activeFilterCount: number;
  onStatusChange: (value: SecretStatus | "all") => void;
  onProviderChange: (value: SecretProvider | "all") => void;
}) {
  const { t } = useTranslation();
  const resetFilters = () => {
    onStatusChange("active");
    onProviderChange("all");
  };

  const statusOptions: Array<{ value: SecretStatus | "all"; label: string }> = [
    { value: "active", label: t("secrets.filter.status.active", { defaultValue: "Active" }) },
    { value: "all", label: t("secrets.filter.status.all", { defaultValue: "All statuses" }) },
    { value: "disabled", label: t("secrets.filter.status.disabled", { defaultValue: "Disabled" }) },
    { value: "archived", label: t("secrets.filter.status.archived", { defaultValue: "Archived" }) },
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className={cn("relative h-8 w-8 shrink-0", activeFilterCount > 0 && "text-blue-600 dark:text-blue-400")}
          title={
            activeFilterCount > 0
              ? t("secrets.filter.titleActive", { defaultValue: "Filters: {{count}}", count: activeFilterCount })
              : t("secrets.filter.title", { defaultValue: "Filter" })
          }
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
            <span className="text-sm font-medium">{t("secrets.filter.heading", { defaultValue: "Filters" })}</span>
            {activeFilterCount > 0 ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={resetFilters}
              >
                <X className="h-3 w-3" />
                {t("secrets.filter.clear", { defaultValue: "Clear" })}
              </button>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">{t("secrets.filter.statusLabel", { defaultValue: "Status" })}</span>
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
              <span className="text-xs text-muted-foreground">{t("secrets.filter.providerLabel", { defaultValue: "Provider" })}</span>
              <div className="max-h-48 space-y-0.5 overflow-y-auto pr-1">
                <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                  <Checkbox
                    checked={providerFilter === "all"}
                    onCheckedChange={() => onProviderChange("all")}
                  />
                  <span className="text-sm">{t("secrets.filter.allProviders", { defaultValue: "All providers" })}</span>
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
  const { t } = useTranslation();
  const blockReason = getProviderConfigBlockReason(config, t);
  const message = blockReason ?? config.healthMessage;
  if (!message) {
    return (
      <p className="mt-1 text-[11px] text-muted-foreground">
        {config.isDefault
          ? t("secrets.vault.defaultVault", { defaultValue: "Default vault" })
          : t("secrets.vault.vault", { defaultValue: "Vault" })}{" "}
        · {config.status.replace("_", " ")}
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
  const { t } = useTranslation();
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
        title={t("secrets.import.awsConfigureTitle", {
          defaultValue: "Configure an AWS provider vault to enable remote import",
        })}
      >
        <Cloud className="h-3.5 w-3.5 mr-1" />{" "}
        {t("secrets.import.awsDisabled", { defaultValue: "AWS vault disabled — manage" })}
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
      <Cloud className="h-3.5 w-3.5 mr-1" />{" "}
      {t("secrets.import.fromVault", { defaultValue: "Import from vault" })}
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
  pendingActionId: string | null;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("secrets.vaults.loading", { defaultValue: "Loading provider vaults" })}
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-4 text-sm text-destructive flex items-center gap-2">
        <AlertCircle className="h-4 w-4" /> {t("secrets.vaults.loadFailed", { defaultValue: "Failed to load provider vaults:" })} {(error as Error).message}
        <Button variant="ghost" size="sm" onClick={onRetry}>
          {t("secrets.retry", { defaultValue: "Retry" })}
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
                <span className="ml-auto text-xs text-muted-foreground">{t("secrets.comingSoon", { defaultValue: "Coming soon" })}</span>
              ) : (
                <Button variant="outline" size="sm" className="ml-auto" onClick={() => onCreate(id)}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  {t("secrets.vaults.addVault", { defaultValue: "Add vault" })}
                </Button>
              )}
            </div>
            {configs.length === 0 ? (
              <div className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
                {isComingSoonFamily
                  ? t("secrets.vaults.notSupported", { defaultValue: "Not yet supported." })
                  : t("secrets.vaults.noneYet", {
                      defaultValue:
                        "No company-specific vaults yet. Secrets can still use the deployment default provider settings.",
                    })}
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
}: {
  config: CompanySecretProviderConfig;
  pending: boolean;
  onEdit: () => void;
  onDisable: () => void;
  onRemove: () => void;
  onSetDefault: () => void;
  onHealthCheck: () => void;
}) {
  const { t } = useTranslation();
  const blockReason = getProviderConfigBlockReason(config, t);
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
                {t("secrets.vault.default", { defaultValue: "Default" })}
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn("font-medium", providerConfigStatusTone(config.status))}>
              {config.status.replace("_", " ")}
            </Badge>
            {config.healthStatus ? (
              <span className="text-xs text-muted-foreground">
                {t("secrets.vault.healthStatus", {
                  defaultValue: "Health {{status}} · {{when}}",
                  status: config.healthStatus.replace("_", " "),
                  when: formatRelative(config.healthCheckedAt),
                })}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">{t("secrets.vault.healthNotChecked", { defaultValue: "Health not checked" })}</span>
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
          {t("secrets.vault.checkHealth", { defaultValue: "Check health" })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onSetDefault}
          disabled={pending || Boolean(blockReason) || config.isDefault}
        >
          <Star className="h-3.5 w-3.5 mr-1" />
          {t("secrets.vault.makeDefault", { defaultValue: "Make default" })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onDisable}
          disabled={pending || config.status === "disabled"}
        >
          <Ban className="h-3.5 w-3.5 mr-1" />
          {t("secrets.disable", { defaultValue: "Disable" })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onRemove}
          disabled={pending}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1" />
          {t("secrets.remove", { defaultValue: "Remove" })}
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
  const { t } = useTranslation();
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
          {t("secrets.vault.localBackupAck", {
            defaultValue:
              "I understand backup and restore require both the database metadata and the local encrypted master key file.",
          })}
        </span>
      </label>
    );
  }

  if (form.provider === "aws_secrets_manager") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t("secrets.vault.field.awsRegion", { defaultValue: "AWS region" })} value={form.region} onChange={(value) => setField("region", value)} placeholder="us-east-1" required />
        <TextField label={t("secrets.vault.field.namespace", { defaultValue: "Namespace" })} value={form.namespace} onChange={(value) => setField("namespace", value)} placeholder="production" />
        <TextField label={t("secrets.vault.field.secretNamePrefix", { defaultValue: "Secret name prefix" })} value={form.secretNamePrefix} onChange={(value) => setField("secretNamePrefix", value)} placeholder="paperclip" />
        <TextField label={t("secrets.vault.field.kmsKeyId", { defaultValue: "KMS key id" })} value={form.kmsKeyId} onChange={(value) => setField("kmsKeyId", value)} placeholder="alias/paperclip-secrets" />
        <TextField label={t("secrets.vault.field.ownerTag", { defaultValue: "Owner tag" })} value={form.ownerTag} onChange={(value) => setField("ownerTag", value)} placeholder="platform" />
        <TextField label={t("secrets.vault.field.environmentTag", { defaultValue: "Environment tag" })} value={form.environmentTag} onChange={(value) => setField("environmentTag", value)} placeholder="prod" />
      </div>
    );
  }

  if (form.provider === "gcp_secret_manager") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t("secrets.vault.field.projectId", { defaultValue: "Project id" })} value={form.projectId} onChange={(value) => setField("projectId", value)} placeholder="paperclip-prod" />
        <TextField label={t("secrets.vault.field.location", { defaultValue: "Location" })} value={form.location} onChange={(value) => setField("location", value)} placeholder="global" />
        <TextField label={t("secrets.vault.field.namespace", { defaultValue: "Namespace" })} value={form.namespace} onChange={(value) => setField("namespace", value)} placeholder="production" />
        <TextField label={t("secrets.vault.field.secretNamePrefix", { defaultValue: "Secret name prefix" })} value={form.secretNamePrefix} onChange={(value) => setField("secretNamePrefix", value)} placeholder="paperclip" />
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField label={t("secrets.vault.field.address", { defaultValue: "Address" })} value={form.address} onChange={(value) => setField("address", value)} placeholder="https://vault.example.com" />
      <TextField label={t("secrets.vault.field.namespace", { defaultValue: "Namespace" })} value={form.namespace} onChange={(value) => setField("namespace", value)} placeholder="admin" />
      <TextField label={t("secrets.vault.field.mountPath", { defaultValue: "Mount path" })} value={form.mountPath} onChange={(value) => setField("mountPath", value)} placeholder="secret" />
      <TextField label={t("secrets.vault.field.secretPathPrefix", { defaultValue: "Secret path prefix" })} value={form.secretPathPrefix} onChange={(value) => setField("secretPathPrefix", value)} placeholder="paperclip/prod" />
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
  error: string | null;
  loading: boolean;
  onDiscover: () => void;
  onApply: (candidate: SecretProviderConfigDiscoveryCandidate) => void;
}) {
  const { t } = useTranslation();
  const canDiscover = Boolean(form.region.trim());
  const warnings = preview?.warnings ?? [];

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("secrets.discovery.title", { defaultValue: "AWS discovery" })}</p>
          <p className="text-xs text-muted-foreground">
            {t("secrets.discovery.description", {
              defaultValue:
                "Uses the current draft routing fields to inspect AWS Secrets Manager metadata. Values are not read.",
            })}
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
          {t("secrets.discovery.findExisting", { defaultValue: "Find existing AWS values" })}
        </Button>
      </div>

      {!canDiscover ? (
        <p className="text-xs text-muted-foreground">
          {t("secrets.discovery.enterRegion", { defaultValue: "Enter an AWS region before discovery." })}
        </p>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("secrets.discovery.searching", { defaultValue: "Searching AWS Secrets Manager metadata" })}
        </div>
      ) : null}

      {error ? (
        <div
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
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
          {t("secrets.discovery.noCandidates", {
            defaultValue: "No AWS vault metadata candidates found. Manual entry is still available.",
          })}
        </div>
      ) : null}

      {preview && preview.candidates.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Database className="h-3.5 w-3.5" />
            <span>
              {t("secrets.discovery.candidateSummary", {
                defaultValue:
                  "{{candidateCount}} {{candidateNoun}} from {{sampleCount}} sampled {{sampleNoun}}",
                candidateCount: preview.candidates.length,
                candidateNoun:
                  preview.candidates.length === 1
                    ? t("secrets.discovery.candidate", { defaultValue: "candidate" })
                    : t("secrets.discovery.candidates", { defaultValue: "candidates" }),
                sampleCount: preview.sampledSecretCount,
                sampleNoun:
                  preview.sampledSecretCount === 1
                    ? t("secrets.discovery.secret", { defaultValue: "secret" })
                    : t("secrets.discovery.secrets", { defaultValue: "secrets" }),
              })}
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

function AwsProviderVaultDiscoveryCandidateRow({
  candidate,
  onApply,
}: {
  candidate: SecretProviderConfigDiscoveryCandidate;
  onApply: () => void;
}) {
  const { t } = useTranslation();
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
              {t("secrets.discovery.sampleCount", {
                defaultValue: "{{count}} {{noun}}",
                count: candidate.sampleCount,
                noun:
                  candidate.sampleCount === 1
                    ? t("secrets.discovery.sample", { defaultValue: "sample" })
                    : t("secrets.discovery.samples", { defaultValue: "samples" }),
              })}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {fieldSummary.length > 0
              ? fieldSummary.join(" / ")
              : t("secrets.discovery.noStableNamespace", { defaultValue: "No stable namespace or prefix detected" })}
          </p>
          {candidate.samples[0] ? (
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {candidate.samples[0].name}
            </p>
          ) : null}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onApply}>
          {t("secrets.discovery.useValues", { defaultValue: "Use values" })}
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
  const { t } = useTranslation();
  const id = `provider-vault-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div>
      <label className="text-xs font-medium" htmlFor={id}>
        {label}
        {required ? null : (
          <span className="text-muted-foreground/70"> {t("secrets.optional", { defaultValue: "(optional)" })}</span>
        )}
      </label>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </div>
  );
}

function SecretDetailsTab({
  secret,
  providerConfigs,
}: {
  secret: CompanySecret;
  providerConfigs: CompanySecretProviderConfig[];
}) {
  const { t } = useTranslation();
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
      <DetailRow label={t("secrets.detail.description", { defaultValue: "Description" })}>
        <span>{secret.description ?? <span className="text-muted-foreground">—</span>}</span>
      </DetailRow>
      <DetailRow label={t("secrets.detail.custody", { defaultValue: "Custody" })}>{modeLabel(secret.managedMode, t)}</DetailRow>
      <DetailRow label={t("secrets.detail.provider", { defaultValue: "Provider" })}>{secret.provider.replaceAll("_", " ")}</DetailRow>
      <DetailRow label={t("secrets.detail.providerVault", { defaultValue: "Provider vault" })}>{providerVaultLabel(providerConfigs, secret.providerConfigId, t)}</DetailRow>
      <DetailRow label={t("secrets.detail.latestVersion", { defaultValue: "Latest version" })}>v{secret.latestVersion}</DetailRow>
      <DetailRow label={t("secrets.detail.created", { defaultValue: "Created" })}>{formatRelative(secret.createdAt)}</DetailRow>
      <DetailRow label={t("secrets.detail.updated", { defaultValue: "Updated" })}>{formatRelative(secret.updatedAt)}</DetailRow>
      <DetailRow label={t("secrets.detail.lastRotated", { defaultValue: "Last rotated" })}>{formatRelative(secret.lastRotatedAt)}</DetailRow>
      <DetailRow label={t("secrets.detail.lastResolved", { defaultValue: "Last resolved" })}>{formatRelative(secret.lastResolvedAt)}</DetailRow>
      {secret.externalRef ? (
        <div className="col-span-2">
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
            {secret.managedMode === "external_reference"
              ? t("secrets.detail.linkedProviderRef", { defaultValue: "Linked provider reference" })
              : t("secrets.detail.providerManagedPath", { defaultValue: "Provider-managed path" })}
          </dt>
          <dd className="font-mono text-xs break-all flex items-center gap-1">
            <ExternalLink className="h-3 w-3" /> {secret.externalRef}
          </dd>
        </div>
      ) : null}
      <div className="col-span-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-700 dark:text-amber-300">
        {modeDescription(secret.managedMode, t)} {t("secrets.detail.neverDisplays", { defaultValue: "Paperclip never re-displays stored values." })}
      </div>
    </dl>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

function SecretUsageTab({ loading, bindings }: { loading: boolean; bindings: CompanySecretUsageBinding[] }) {
  const { t } = useTranslation();
  if (loading) {
    return <div className="py-6 text-center text-xs text-muted-foreground">{t("secrets.loading", { defaultValue: "Loading…" })}</div>;
  }
  if (bindings.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        {t("secrets.usage.empty", {
          defaultValue:
            "No active bindings. Add this secret in agent, project, environment, or plugin config to start using it.",
        })}
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
            {binding.configPath}{" "}
            {binding.required
              ? t("secrets.usage.requiredSuffix", { defaultValue: "· required" })
              : t("secrets.usage.optionalSuffix", { defaultValue: "· optional" })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SecretEventsTab({ loading, events }: { loading: boolean; events: SecretAccessEvent[] }) {
  const { t } = useTranslation();
  if (loading) {
    return <div className="py-6 text-center text-xs text-muted-foreground">{t("secrets.loading", { defaultValue: "Loading…" })}</div>;
  }
  if (events.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        {t("secrets.events.empty", {
          defaultValue: "No access events recorded yet. Each runtime resolution writes a redacted entry here.",
        })}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {events.map((event) => (
        <div key={event.id} className="rounded border border-border px-2 py-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="capitalize">
              {event.consumerType} · {event.outcome}
            </span>
            <span className="text-[11px] text-muted-foreground">{formatRelative(event.createdAt)}</span>
          </div>
          <div className="font-mono text-[11px] text-muted-foreground break-all">
            {event.consumerId}
          </div>
          {event.errorCode ? (
            <div className="text-[11px] text-destructive">{event.errorCode}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
