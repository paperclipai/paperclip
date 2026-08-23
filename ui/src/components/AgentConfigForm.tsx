import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  AdapterAuthSessionPrompt,
  AdapterAuthSessionStatus,
  AdapterEnvironmentTestResult,
  CompanySecret,
  EnvBinding,
  EnvSecretRefBinding,
  Environment,
} from "@paperclipai/shared";
import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS, supportedEnvironmentDriversForAdapter, isValidBrowserCode, ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import type { AdapterModel } from "../api/agents";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import { secretsApi } from "../api/secrets";
import { assetsApi } from "../api/assets";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX } from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_KIMI_LOCAL_MODEL } from "@paperclipai/adapter-kimi-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL } from "@paperclipai/adapter-opencode-local";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { FolderOpen, Heart, ChevronDown, X, Copy, Check, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { asBoolean, asFiniteNumber, asObject, cn } from "../lib/utils";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  resolveAdapterTestEnvironmentId,
  resolveLocalDefaultEnvironmentId,
  resolveManagedSandboxEnvironmentId,
} from "../lib/adapter-test-environment";
import { environmentDisplayLabel } from "../lib/managed-sandbox-environment";
import { extractModelName, extractProviderId } from "../lib/model-utils";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import {
  Field,
  ToggleField,
  ToggleWithNumber,
  CollapsibleSection,
  DraftInput,
  DraftNumberInput,
  help,
  adapterLabels,
} from "./agent-config-primitives";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { defaultCreateValues } from "./agent-config-defaults";
import { getUIAdapter } from "../adapters";
import { ClaudeLocalAdvancedFields } from "../adapters/claude-local/config-fields";
import { MarkdownEditor } from "./MarkdownEditor";
import { ChoosePathButton } from "./PathInstructionsModal";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";
import { ReportsToPicker } from "./ReportsToPicker";
import {
  EnvironmentVariablesEditor,
  type EnvironmentVariablesEditorHandle,
} from "./environment-variables-editor";
import { buildFixedClaudeOAuthBinding, CLAUDE_OAUTH_TOKEN_ENV_KEY } from "./environment-variables-editor/model";
import { AgentSecretAccessEditor } from "./AgentSecretAccessEditor";
import { useProposalReview } from "../pages/secrets/proposal-review";
import { AGENT_ACCESS_CONFIG_PATH_PREFIX } from "../lib/secret-delivery";
import { shouldShowLegacyWorkingDirectoryField } from "../lib/legacy-agent-config";
import { listAdapterOptions, listVisibleAdapterTypes } from "../adapters/metadata";
import { getAdapterDisplay, getAdapterLabel } from "../adapters/adapter-display-registry";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { buildAgentUpdatePatch, omitUndefinedEntries, type AgentConfigOverlay } from "../lib/agent-config-patch";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import { resolveForcedKubernetesEnvironment } from "../lib/forced-kubernetes-environment";

/* ---- Create mode values ---- */

// Canonical type lives in @paperclipai/adapter-utils; re-exported here
// so existing imports from this file keep working.
export type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { Badge } from "@/components/ui/badge";

/* ---- Props ---- */

type AgentConfigFormProps = {
  adapterModels?: AdapterModel[];
  onDirtyChange?: (dirty: boolean) => void;
  onSaveActionChange?: (save: (() => void) | null) => void;
  onCancelActionChange?: (cancel: (() => void) | null) => void;
  onTestActionChange?: (test: (() => void) | null) => void;
  onTestActionStateChange?: (state: { disabled: boolean; pending: boolean }) => void;
  onTestFeedbackChange?: (feedback: {
    errorMessage: string | null;
    result: AdapterEnvironmentTestResult | null;
    // The login panel descriptor when the current target is a sandbox with no
    // ready authentication, otherwise null. A parent that lifts the test
    // feedback must render `AdapterLoginPanel` from this descriptor. The inline
    // feedback branch renders the panel itself, so this descriptor is the only
    // way the panel reaches a parent that hides the inline branch.
    login: AdapterLoginDescriptor | null;
  }) => void;
  hideInlineSave?: boolean;
  showAdapterTypeField?: boolean;
  showAdapterTestEnvironmentButton?: boolean;
  showCreateRunPolicySection?: boolean;
  hideInstructionsFile?: boolean;
  /** Hide the prompt template field from the Identity section (used when it's shown in a separate Prompts tab). */
  hidePromptTemplate?: boolean;
  /** Render the main configuration sections or the dedicated edit-only Secrets surface. */
  content?: "configuration" | "secrets";
  /** "cards" renders each section as heading + bordered card (for settings pages). Default: "inline" (border-b dividers). */
  sectionLayout?: "inline" | "cards";
} & (
  | {
      mode: "create";
      values: CreateConfigValues;
      onChange: (patch: Partial<CreateConfigValues>) => void;
    }
  | {
      mode: "edit";
      agent: Agent;
      onSave: (patch: Record<string, unknown>) => void | Promise<unknown>;
      isSaving?: boolean;
    }
);

/* ---- Edit mode overlay (dirty tracking) ---- */

const emptyOverlay: AgentConfigOverlay = {
  identity: {},
  adapterConfig: {},
  heartbeat: {},
  runtime: {},
};

/** Stable empty object used as fallback for missing env config to avoid new-object-per-render. */
const EMPTY_ENV: Record<string, EnvBinding> = {};

export function supportsAdapterModelRefresh(adapterType: string): boolean {
  return adapterType === "claude_local" || adapterType === "codex_local";
}

function isOverlayDirty(o: AgentConfigOverlay): boolean {
  return (
    Object.keys(o.identity).length > 0 ||
    o.adapterType !== undefined ||
    Object.keys(o.adapterConfig).length > 0 ||
    Object.keys(o.heartbeat).length > 0 ||
    Object.keys(o.runtime).length > 0 ||
    o.modelProfiles?.cheap !== undefined
  );
}

/* ---- Shared input class ---- */
const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatArgList(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .join(", ");
  }
  return typeof value === "string" ? value : "";
}

const codexThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X-High" },
] as const;

const openCodeThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X-High" },
  { id: "max", label: "Max" },
] as const;

const cursorModeOptions = [
  { id: "", label: "Auto" },
  { id: "plan", label: "Plan" },
  { id: "ask", label: "Ask" },
] as const;

const claudeThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
] as const;

// Kimi exposes low/high/max (no "medium") via each model's support_efforts;
// the kimi_local adapter maps a legacy "medium" onto "high" at runtime.
const kimiThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
] as const;

const MAX_TURN_CONTINUATION_DEFAULT_MAX_ATTEMPTS = 2;
const MAX_TURN_CONTINUATION_MAX_ATTEMPTS_CAP = 10;
const MAX_TURN_CONTINUATION_DEFAULT_DELAY_SEC = 1;
const MAX_TURN_CONTINUATION_MAX_DELAY_SEC = 300;

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampDelayMsFromSeconds(value: number) {
  return clampInteger(value, 0, MAX_TURN_CONTINUATION_MAX_DELAY_SEC) * 1000;
}

/* ---- Form ---- */

export function AgentConfigForm(props: AgentConfigFormProps) {
  const { mode, adapterModels: externalModels } = props;
  const isCreate = mode === "create";
  const cards = props.sectionLayout === "cards";
  const showAdapterTypeField = props.showAdapterTypeField ?? true;
  const showAdapterTestEnvironmentButton = props.showAdapterTestEnvironmentButton ?? true;
  const showInlineAdapterTestEnvironmentButton =
    showAdapterTestEnvironmentButton && !props.onTestActionChange;
  const showInlineAdapterTestEnvironmentFeedback = !props.onTestFeedbackChange;
  const showCreateRunPolicySection = props.showCreateRunPolicySection ?? true;
  const hideInstructionsFile = props.hideInstructionsFile ?? false;
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const environmentVariablesEditorRef = useRef<EnvironmentVariablesEditorHandle | null>(null);

  // Sync disabled adapter types from server so dropdown filters them out
  const disabledTypes = useDisabledAdaptersSync();

  const { data: availableSecrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  // User-secret definitions power the "User secret" env binding source. Requires
  // secret-admin; non-admins simply get the free-text key fallback in the editor.
  const { data: userSecretDefinitions = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.userDefinitions(selectedCompanyId)
      : ["user-secret-definitions", "none"],
    queryFn: () => secretsApi.listUserSecretDefinitions(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });
  // Pending binding proposals targeting this agent (PAP-14731). Board-only route;
  // non-permitted viewers simply get an empty list.
  const editAgentId = !isCreate ? props.agent.id : null;
  const { data: pendingProposals = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.proposals(selectedCompanyId, "pending")
      : ["secret-proposals", "none"],
    queryFn: () => secretsApi.listProposals(selectedCompanyId!, "pending"),
    enabled: Boolean(selectedCompanyId) && !isCreate,
    retry: false,
  });
  const agentBindingProposals = useMemo(
    () =>
      pendingProposals.filter(
        (proposal) => proposal.kind === "binding" && proposal.target?.id === editAgentId,
      ),
    [pendingProposals, editAgentId],
  );
  const proposalReview = useProposalReview(selectedCompanyId, []);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const environmentsEnabled = experimentalSettings?.enableEnvironments === true;

  // Instance execution policy (general settings). When `executionMode` is
  // "kubernetes" the instance FORCES all execution onto the managed Kubernetes
  // sandbox; "any"/absent leaves the full environment/adapter choice intact.
  // Reuses the same general-settings query the rest of the UI uses.
  const { data: generalSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    retry: false,
  });
  const { data: instanceSettings } = useQuery({
    queryKey: queryKeys.instance.settings,
    queryFn: () => instanceSettingsApi.get(),
    retry: false,
  });

  const { data: environments = [] } = useQuery<Environment[]>({
    queryKey: selectedCompanyId ? queryKeys.environments.list(selectedCompanyId) : ["environments", "none"],
    queryFn: () => environmentsApi.list(selectedCompanyId!),
    // Load environments when the picker is enabled OR when execution is forced
    // onto Kubernetes (so we can resolve and default to the managed K8s env even
    // when the experimental environments picker is otherwise hidden).
    enabled:
      Boolean(selectedCompanyId) &&
      (environmentsEnabled || generalSettings?.executionMode === "kubernetes"),
  });

  // Setting-driven: resolve whether the instance forces Kubernetes execution and
  // which loaded environment is the managed Kubernetes sandbox.
  const { forced: forcedKubernetes, kubernetesEnvironment } = useMemo(
    () => resolveForcedKubernetesEnvironment(generalSettings?.executionMode, environments),
    [generalSettings?.executionMode, environments],
  );
  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!selectedCompanyId) throw new Error("Select a company to create secrets");
      return secretsApi.create(selectedCompanyId, input);
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    },
  });

  const uploadMarkdownImage = useMutation({
    mutationFn: async ({ file, namespace }: { file: File; namespace: string }) => {
      if (!selectedCompanyId) throw new Error("Select a company to upload images");
      return assetsApi.uploadImage(selectedCompanyId, file, namespace);
    },
  });

  // ---- Edit mode: overlay for dirty tracking ----
  const [overlay, setOverlay] = useState<AgentConfigOverlay>(emptyOverlay);
  const agentRef = useRef<Agent | null>(null);

  // Clear overlay when agent data refreshes (after save)
  useEffect(() => {
    if (!isCreate) {
      if (agentRef.current !== null && props.agent !== agentRef.current) {
        setOverlay({ ...emptyOverlay });
      }
      agentRef.current = props.agent;
    }
  }, [isCreate, !isCreate ? props.agent : undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDirty = !isCreate && isOverlayDirty(overlay);

  type RecordOverlayGroup = "identity" | "adapterConfig" | "heartbeat" | "runtime";

  /** Read effective value: overlay if dirty, else original */
  function eff<T>(group: RecordOverlayGroup, field: string, original: T): T {
    const o = overlay[group];
    if (field in o) return o[field] as T;
    return original;
  }

  /** Mark field dirty in overlay */
  function mark(group: RecordOverlayGroup, field: string, value: unknown) {
    setOverlay((prev) => ({
      ...prev,
      [group]: { ...prev[group], [field]: value },
    }));
  }

  function flushEnvironmentDraft() {
    return environmentVariablesEditorRef.current?.flushPendingDraft() ?? null;
  }

  /**
   * Replace the agent's API-access grants (top-level `access.<ALIAS>` keys) with
   * the complete set emitted by the Secret access editor. Added/changed aliases
   * are marked into the overlay; aliases dropped from the set are marked
   * `undefined` so `buildAgentUpdatePatch` strips them.
   */
  const applyAccessGrants = useCallback((next: Record<string, EnvSecretRefBinding>) => {
    if (isCreate) return;
    setOverlay((prev) => {
      const effective = { ...(props.agent.adapterConfig ?? {}), ...prev.adapterConfig } as Record<string, unknown>;
      const nextAdapterConfig: Record<string, unknown> = { ...prev.adapterConfig };
      for (const [alias, binding] of Object.entries(next)) {
        nextAdapterConfig[`${AGENT_ACCESS_CONFIG_PATH_PREFIX}${alias}`] = binding;
      }
      for (const key of Object.keys(effective)) {
        if (!key.startsWith(AGENT_ACCESS_CONFIG_PATH_PREFIX)) continue;
        const alias = key.slice(AGENT_ACCESS_CONFIG_PATH_PREFIX.length);
        if (!(alias in next)) nextAdapterConfig[key] = undefined;
      }
      return { ...prev, adapterConfig: nextAdapterConfig };
    });
  }, [isCreate, !isCreate ? props.agent : undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Build accumulated patch and send to parent */
  const handleCancel = useCallback(() => {
    setOverlay({ ...emptyOverlay });
  }, []);

  const handleSave = useCallback(async () => {
    if (isCreate) return;
    const flushedEnv = flushEnvironmentDraft();
    const nextOverlay = flushedEnv
      ? {
          ...overlay,
          adapterConfig: {
            ...overlay.adapterConfig,
            env: flushedEnv,
          },
        }
      : overlay;
    if (!isOverlayDirty(nextOverlay)) return;
    await props.onSave(buildAgentUpdatePatch(props.agent, nextOverlay));
  }, [isCreate, isDirty, overlay, props]);

  useEffect(() => {
    if (!isCreate) {
      props.onDirtyChange?.(isDirty);
      props.onSaveActionChange?.(handleSave);
      props.onCancelActionChange?.(handleCancel);
    }
  }, [isCreate, isDirty, props.onDirtyChange, props.onSaveActionChange, props.onCancelActionChange, handleSave, handleCancel]);

  useEffect(() => {
    if (isCreate) return;
    return () => {
      props.onSaveActionChange?.(null);
      props.onCancelActionChange?.(null);
      props.onDirtyChange?.(false);
    };
  }, [isCreate, props.onDirtyChange, props.onSaveActionChange, props.onCancelActionChange]);

  // ---- Resolve values ----
  const config = !isCreate ? ((props.agent.adapterConfig ?? {}) as Record<string, unknown>) : {};
  const runtimeConfig = !isCreate ? ((props.agent.runtimeConfig ?? {}) as Record<string, unknown>) : {};
  const heartbeat = !isCreate ? ((runtimeConfig.heartbeat ?? {}) as Record<string, unknown>) : {};

  const adapterType = isCreate
    ? props.values.adapterType
    : overlay.adapterType ?? props.agent.adapterType;
  const getCapabilities = useAdapterCapabilities();
  const adapterCaps = getCapabilities(adapterType);
  const isLocal = adapterCaps.supportsInstructionsBundle || adapterCaps.supportsSkills || adapterCaps.supportsLocalAgentJwt;
  
  const showLegacyWorkingDirectoryField =
    isLocal && shouldShowLegacyWorkingDirectoryField({ isCreate, adapterConfig: config });
  const uiAdapter = useMemo(() => getUIAdapter(adapterType), [adapterType]);
  const supportedEnvironmentDrivers = useMemo(
    () => new Set(supportedEnvironmentDriversForAdapter(adapterType)),
    [adapterType],
  );
  const val = isCreate ? props.values : null;
  const set = isCreate
    ? (patch: Partial<CreateConfigValues>) => props.onChange(patch)
    : null;

  // Create mode holds the non-secret stored-session claim after a Claude
  // subscription login reaches the server `stored` state. The claim marks the
  // fixed `CLAUDE_CODE_OAUTH_TOKEN` binding as present. The form sends the claim
  // in the create request; the server binds and enforces the token
  // independently. The claim never carries a token value.
  const claudeStoredSessionId = isCreate ? val!.claudeStoredSessionId ?? null : null;

  // After a login binds CLAUDE_CODE_OAUTH_TOKEN, the user-secret-definitions list
  // in the cache is stale. The form reads that list once at page load, so it does
  // not contain the definition the login just bound. The bound row then compares
  // its key against the stale list and shows a false "no longer exists" health
  // error. Invalidate the list so the row reads the fresh definitions and clears
  // the error.
  const invalidateUserSecretDefinitions = () => {
    if (!selectedCompanyId) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.secrets.userDefinitions(selectedCompanyId),
    });
  };

  // Add the fixed binding to the create-mode form state after the login stores.
  // Keep every unrelated binding. Hold the claim so the create request sends it.
  const handleClaudeLoginStored = (storedSessionId: string) => {
    if (!isCreate || !set) return;
    const existingBindings = (val!.envBindings ?? {}) as Record<string, EnvBinding>;
    set({
      envBindings: { ...existingBindings, ...buildFixedClaudeOAuthBinding() },
      claudeStoredSessionId: storedSessionId,
    });
    invalidateUserSecretDefinitions();
  };

  // Edit mode: after a login stores the token, add the fixed binding to the
  // existing agent and persist it at once. The server already stored the token;
  // this step binds `CLAUDE_CODE_OAUTH_TOKEN` to the agent's environment through
  // the normal agent-update patch path, so no manual bind step remains. Flush any
  // pending editor draft first, keep every unrelated binding, and mark the merged
  // set into the overlay so the editor and the saved patch agree.
  //
  // An update can never consume a fresh login's stored-session claim -- only the
  // create and hire paths can, per `enforceClaudeOAuthBindingClaim`. So this save
  // must set `applyStoredClaudeLogin`, the same way `handleApplyStoredClaudeLoginEdit`
  // does, or the server rejects the patch with the fixed claim error even though
  // the login already stored the token. Without the flag every fresh login on an
  // existing agent's own page fails to save the binding.
  const handleClaudeLoginStoredEdit = async () => {
    if (isCreate) return;
    const flushedEnv = flushEnvironmentDraft();
    const baseEnv =
      flushedEnv ??
      (eff("adapterConfig", "env", (config.env ?? EMPTY_ENV) as Record<string, EnvBinding>));
    const nextEnv = { ...baseEnv, ...buildFixedClaudeOAuthBinding() };
    const nextOverlay: AgentConfigOverlay = {
      ...overlay,
      adapterConfig: { ...overlay.adapterConfig, env: nextEnv },
    };
    setOverlay(nextOverlay);
    await props.onSave({
      ...buildAgentUpdatePatch(props.agent, nextOverlay),
      applyStoredClaudeLogin: true,
    });
    invalidateUserSecretDefinitions();
  };

  // Create mode: bind the fixed reference to an existing stored login with no new
  // login round trip. Add the fixed binding and set the apply-existing flag. The
  // create request sends the flag; the server binds the token only for a user
  // actor and only when a stored value exists. Keep every unrelated binding.
  const handleApplyStoredClaudeLogin = () => {
    if (!isCreate || !set) return;
    const existingBindings = (val!.envBindings ?? {}) as Record<string, EnvBinding>;
    set({
      envBindings: { ...existingBindings, ...buildFixedClaudeOAuthBinding() },
      claudeApplyStoredLogin: true,
    });
    invalidateUserSecretDefinitions();
  };

  // Edit mode: bind the fixed reference to an existing stored login with no new
  // login round trip, then persist it at once. Add the fixed binding to the
  // existing agent and save the patch with the apply-existing flag. Flush any
  // pending editor draft first and keep every unrelated binding.
  const handleApplyStoredClaudeLoginEdit = async () => {
    if (isCreate) return;
    const flushedEnv = flushEnvironmentDraft();
    const baseEnv =
      flushedEnv ??
      (eff("adapterConfig", "env", (config.env ?? EMPTY_ENV) as Record<string, EnvBinding>));
    const nextEnv = { ...baseEnv, ...buildFixedClaudeOAuthBinding() };
    const nextOverlay: AgentConfigOverlay = {
      ...overlay,
      adapterConfig: { ...overlay.adapterConfig, env: nextEnv },
    };
    setOverlay(nextOverlay);
    await props.onSave({
      ...buildAgentUpdatePatch(props.agent, nextOverlay),
      applyStoredClaudeLogin: true,
    });
    invalidateUserSecretDefinitions();
  };

  const rawCurrentDefaultEnvironmentId = isCreate
    ? val!.defaultEnvironmentId ?? ""
    : eff("identity", "defaultEnvironmentId", props.agent.defaultEnvironmentId ?? "");
  const currentDefaultEnvironmentId = useMemo(() => {
    if (!rawCurrentDefaultEnvironmentId) return "";
    const selected = environments.find((environment) => environment.id === rawCurrentDefaultEnvironmentId) ?? null;
    return selected?.driver === "local" ? "" : rawCurrentDefaultEnvironmentId;
  }, [environments, rawCurrentDefaultEnvironmentId]);
  const currentDefaultEnvironment = useMemo(
    () => environments.find((environment) => environment.id === currentDefaultEnvironmentId) ?? null,
    [currentDefaultEnvironmentId, environments],
  );
  const instanceDefaultEnvironmentId = useMemo(() => {
    const environmentId = instanceSettings?.defaultEnvironmentId ?? null;
    if (!environmentId) return "";
    const selected = environments.find((environment) => environment.id === environmentId) ?? null;
    return selected?.driver === "local" ? "" : environmentId;
  }, [environments, instanceSettings?.defaultEnvironmentId]);
  const instanceDefaultEnvironment = useMemo(
    () => environments.find((environment) => environment.id === instanceDefaultEnvironmentId) ?? null,
    [environments, instanceDefaultEnvironmentId],
  );

  // The environment a login session runs in. It mirrors the Test resolution: the
  // agent's own environment wins, otherwise the instance default, otherwise the
  // local default. The login affordance shows only when this environment is a
  // sandbox, because the canonical auth-missing check comes only from a sandbox
  // target.
  //
  // The resolution passes the same managed-sandbox-only policy inputs as the
  // adapter Test target, so both resolve to the same environment. Under the
  // policy a resolution that lands on the local environment redirects to the
  // managed sandbox the real run uses. Without the redirect the login target
  // stays local while the Test and the real run use the managed sandbox, so the
  // login affordance reads the wrong target. The resolver throws when the policy
  // is on but no managed sandbox is available; a render must not throw, so this
  // resolution catches that case and resolves no login environment. The Test
  // mutation surfaces the same case as a fail-closed error.
  const effectiveLoginEnvironmentId = useMemo(() => {
    try {
      return resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: rawCurrentDefaultEnvironmentId || null,
        instanceDefaultEnvironmentId: instanceSettings?.defaultEnvironmentId ?? null,
        localDefaultEnvironmentId: resolveLocalDefaultEnvironmentId(environments),
        managedSandboxOnly: experimentalSettings?.enableManagedSandboxOnly === true,
        managedSandboxEnvironmentId: resolveManagedSandboxEnvironmentId(environments),
        // The policy hides the local environment, so an agent default that still
        // points at the hidden local row names no visible environment. Pass the
        // visible ids so the resolver redirects that stale local default to the
        // managed sandbox instead of the hidden local id.
        visibleEnvironmentIds: environments.map((environment) => environment.id),
      });
    } catch {
      return null;
    }
  }, [
    rawCurrentDefaultEnvironmentId,
    instanceSettings?.defaultEnvironmentId,
    environments,
    experimentalSettings?.enableManagedSandboxOnly,
  ]);
  const effectiveLoginEnvironment = useMemo(
    () => environments.find((environment) => environment.id === effectiveLoginEnvironmentId) ?? null,
    [environments, effectiveLoginEnvironmentId],
  );
  // Load the sandbox provider capabilities. A login that runs on a real
  // pseudo-terminal needs a provider that advertises the login pseudo-terminal
  // capability. The login panel gate reads this to hide the panel for a provider
  // without the capability. Enable the query when the adapter declares a login
  // capability: every login runs on a real pseudo-terminal, so every login
  // consults this data. The gate is advisory; the server resolves the capability
  // again and fails closed.
  const { data: environmentCapabilities } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.environments.capabilities(selectedCompanyId)
      : ["environment-capabilities", "none"],
    queryFn: () => environmentsApi.capabilities(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && adapterCaps.login != null,
  });

  // When the instance forces Kubernetes execution, new agents must default to the
  // managed Kubernetes sandbox environment (never the implicit local default).
  // Only applies in create mode and only once the K8s environment is loaded; if
  // none is available the UI surfaces a notice instead of silently selecting it.
  useEffect(() => {
    if (!isCreate || !set || !forcedKubernetes || !kubernetesEnvironment) return;
    if (currentDefaultEnvironmentId === kubernetesEnvironment.id) return;
    set({ defaultEnvironmentId: kubernetesEnvironment.id });
  }, [isCreate, set, forcedKubernetes, kubernetesEnvironment, currentDefaultEnvironmentId]);

  const runnableEnvironments = useMemo(
    () => environments.filter((environment) => {
      if (!supportedEnvironmentDrivers.has(environment.driver)) return false;
      if (environment.driver === "local") return false;
      if (environment.driver !== "sandbox") return true;
      const provider = typeof environment.config?.provider === "string" ? environment.config.provider : null;
      return provider !== null && provider !== "fake";
    }),
    [environments, supportedEnvironmentDrivers],
  );
  const environmentOptions = useMemo(() => {
    if (!currentDefaultEnvironment) return runnableEnvironments;
    if (runnableEnvironments.some((environment) => environment.id === currentDefaultEnvironment.id)) {
      return runnableEnvironments;
    }
    return [...runnableEnvironments, currentDefaultEnvironment];
  }, [currentDefaultEnvironment, runnableEnvironments]);
  // `runnableEnvironments` excludes the always-available Local environment, so a
  // single entry already means the user has more than one environment configured
  // (Local + that environment) and the override selector is meaningful.
  const showEnvironmentOverrideControl = environmentsEnabled && (
    forcedKubernetes ||
    currentDefaultEnvironmentId.length > 0 ||
    runnableEnvironments.length >= 1
  );
  const managedSandboxOnly = experimentalSettings?.enableManagedSandboxOnly === true;
  const inheritedEnvironmentLabel = instanceDefaultEnvironment
    ? environmentDisplayLabel(instanceDefaultEnvironment)
    : managedSandboxOnly
      ? "Paperclip Computer"
      : "Local";

  // Fetch adapter models for the effective adapter type
  const modelQueryKey = selectedCompanyId
    ? queryKeys.agents.adapterModels(selectedCompanyId, adapterType, currentDefaultEnvironmentId || null)
    : ["agents", "none", "adapter-models", adapterType];
  const {
    data: fetchedModels,
    error: fetchedModelsError,
  } = useQuery({
    queryKey: modelQueryKey,
    queryFn: () => agentsApi.adapterModels(selectedCompanyId!, adapterType, {
      environmentId: currentDefaultEnvironmentId || null,
    }),
    enabled: Boolean(selectedCompanyId),
  });
  const [refreshModelsError, setRefreshModelsError] = useState<string | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const models = fetchedModels ?? externalModels ?? [];
  const adapterCommandField = "command";
  const {
    data: detectedModelData,
    refetch: refetchDetectedModel,
  } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.agents.detectModel(selectedCompanyId, adapterType)
      : ["agents", "none", "detect-model", adapterType],
    queryFn: () => {
      if (!selectedCompanyId) {
        throw new Error("Select a company to detect the model");
      }
      return agentsApi.detectModel(selectedCompanyId, adapterType);
    },
    enabled: Boolean(selectedCompanyId && isLocal && adapterType !== "opencode_local"),
  });
  const detectedModel = detectedModelData?.model ?? null;
  const detectedModelCandidates = detectedModelData?.candidates ?? [];

  const { data: companyAgents = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none", "list"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(!isCreate && selectedCompanyId),
  });

  /** Props passed to adapter-specific config field components */
  const adapterFieldProps = {
    mode,
    isCreate,
    adapterType,
    values: isCreate ? props.values : null,
    set: isCreate ? (patch: Partial<CreateConfigValues>) => props.onChange(patch) : null,
    config,
    eff: eff as <T>(group: "adapterConfig", field: string, original: T) => T,
    mark: mark as (group: "adapterConfig", field: string, value: unknown) => void,
    models,
    hideInstructionsFile,
  };

  // Section toggle state — advanced always starts collapsed
  const [runPolicyAdvancedOpen, setRunPolicyAdvancedOpen] = useState(false);
  // Popover states
  const [modelOpen, setModelOpen] = useState(false);
  const [cheapModelOpen, setCheapModelOpen] = useState(false);
  const [thinkingEffortOpen, setThinkingEffortOpen] = useState(false);

  // Cheap model profile state — only relevant when the adapter advertises
  // `supportsModelProfiles`. Defaults are sourced from the adapter's
  // /model-profiles endpoint so the UI does not encode adapter-specific
  // cheap defaults.
  const supportsModelProfiles = adapterCaps.supportsModelProfiles;
  const { data: adapterCheapProfileDefinitions } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.agents.adapterModelProfiles(selectedCompanyId, adapterType)
      : ["agents", "none", "adapter-model-profiles", adapterType],
    queryFn: () => agentsApi.adapterModelProfiles(selectedCompanyId!, adapterType),
    enabled: Boolean(selectedCompanyId) && supportsModelProfiles,
  });
  const adapterCheapDefault = useMemo(() => {
    return (adapterCheapProfileDefinitions ?? []).find((profile) => profile.key === "cheap") ?? null;
  }, [adapterCheapProfileDefinitions]);
  const adapterCheapDefaultModel = useMemo(() => {
    const adapterConfig = adapterCheapDefault?.adapterConfig ?? {};
    const value = (adapterConfig as Record<string, unknown>).model;
    return typeof value === "string" ? value : "";
  }, [adapterCheapDefault]);

  function buildAdapterConfigForTest(adapterConfigPatch?: Record<string, unknown>): Record<string, unknown> {
    if (isCreate) {
      const next = uiAdapter.buildAdapterConfig(val!);
      if (adapterConfigPatch) {
        Object.assign(next, adapterConfigPatch);
      }
      return omitUndefinedEntries(next);
    }
    const base = config as Record<string, unknown>;
    const next = { ...base, ...overlay.adapterConfig };
    if (adapterConfigPatch) {
      Object.assign(next, adapterConfigPatch);
    }
    return omitUndefinedEntries(next);
  }

  function buildCheapAdapterConfigForTest(adapterConfigPatch?: Record<string, unknown>): Record<string, unknown> {
    const adapterDefaultConfig = asObject(adapterCheapDefault?.adapterConfig);
    const createCheapModel = isCreate ? (val!.cheapModel ?? "").trim() : "";
    const cheapAdapterConfig = isCreate
      ? {
          ...adapterDefaultConfig,
          ...(createCheapModel ? { model: createCheapModel } : {}),
        }
      : {
          ...adapterDefaultConfig,
          ...cheapProfileFromAgent.adapterConfig,
          ...asObject(cheapOverlay?.adapterConfig),
        };
    return buildAdapterConfigForTest({ ...cheapAdapterConfig, ...adapterConfigPatch });
  }

  function getCheapModelTestCase(adapterConfigPatch?: Record<string, unknown>): { model: string; adapterConfig: Record<string, unknown> } | null {
    if (!currentCheapEnabled) return null;
    const adapterConfig = buildCheapAdapterConfigForTest(adapterConfigPatch);
    const configModel = typeof adapterConfig.model === "string" ? adapterConfig.model.trim() : "";
    const model = configModel || currentCheapModel.trim();
    if (!model) return null;
    adapterConfig.model = model;
    return { model, adapterConfig };
  }

  function prefixEnvironmentTestChecks(
    result: AdapterEnvironmentTestResult,
    label: string,
    model: string | null,
  ): AdapterEnvironmentTestResult {
    const modelLabel = model ? ` (${model})` : "";
    return {
      ...result,
      checks: [
        {
          code: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_test_started`,
          level: "info",
          message: `${label} test${modelLabel}`,
        },
        ...result.checks.map((check) => ({
          ...check,
          message: `${label} test${modelLabel}: ${check.message}`,
        })),
      ],
    };
  }

  async function runEnvironmentTestCase(
    label: string,
    model: string | null,
    adapterConfig: Record<string, unknown>,
    environmentId: string | null,
  ): Promise<AdapterEnvironmentTestResult> {
    const result = await agentsApi.testEnvironment(selectedCompanyId!, adapterType, {
      adapterConfig,
      environmentId,
    });
    return prefixEnvironmentTestChecks(result, label, model);
  }

  function mergeEnvironmentTestResults(
    results: AdapterEnvironmentTestResult[],
  ): AdapterEnvironmentTestResult {
    const checks = results.flatMap((result) => result.checks);
    const status = results.some((result) => result.status === "fail")
      ? "fail"
      : results.some((result) => result.status === "warn")
        ? "warn"
        : "pass";
    const testedAt = results[results.length - 1]?.testedAt ?? new Date().toISOString();

    return {
      adapterType,
      status,
      checks,
      testedAt,
    };
  }

  const testEnvironment = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) {
        throw new Error("Select a company to test adapter environment");
      }
      const flushedEnv = flushEnvironmentDraft();
      const adapterConfigPatch = flushedEnv ? { env: flushedEnv } : undefined;
      const primaryModel = currentModelId.trim() || null;
      const cheapTestCase = getCheapModelTestCase(adapterConfigPatch);
      // Probe where a real run would actually execute: the agent's own
      // environment, else the instance default. Testing the host for an
      // agent that runs in the instance-default sandbox reports failures
      // (e.g. a CLI that only exists in the sandbox image) a real run would
      // never hit. The raw id is sent even for a local environment — the
      // server resolves the driver and probes the host in that case.
      //
      // Test can be clicked before the settings query settles (or after it
      // failed with retry:false), so when the agent relies on the instance
      // default, resolve the settings here rather than trusting the
      // render-time cache. A fetch that still fails FAILS the test with an
      // honest diagnostic — silently probing the host instead would report
      // the exact false command-not-found failure this resolution exists to
      // fix. Agents with their own environment never need the settings.
      let settings = instanceSettings;
      let environmentList = environments;
      let managedSandboxOnly = experimentalSettings?.enableManagedSandboxOnly === true;
      if (!rawCurrentDefaultEnvironmentId) {
        // The agent has no own environment, so the Test resolves the instance
        // default, the local default, or the managed sandbox. Resolve the
        // settings, the environment list, and the managed-sandbox-only policy
        // here, because the render-time queries can be unsettled, or the
        // environments query can be disabled under the managed-sandbox-only
        // policy. A failure surfaces an honest error, not a silent host probe
        // that reports a false result.
        try {
          const [resolvedSettings, resolvedEnvironments, resolvedExperimental] =
            await Promise.all([
              queryClient.ensureQueryData({
                queryKey: queryKeys.instance.settings,
                queryFn: () => instanceSettingsApi.get(),
              }),
              queryClient.ensureQueryData({
                queryKey: queryKeys.environments.list(selectedCompanyId),
                queryFn: () => environmentsApi.list(selectedCompanyId),
              }),
              queryClient.ensureQueryData({
                queryKey: queryKeys.instance.experimentalSettings,
                queryFn: () => instanceSettingsApi.getExperimental(),
              }),
            ]);
          settings = resolvedSettings;
          environmentList = resolvedEnvironments;
          managedSandboxOnly = resolvedExperimental?.enableManagedSandboxOnly === true;
        } catch {
          throw new Error(
            "Could not load environment settings to determine which environment to test in. Retry the test.",
          );
        }
      }
      // Mirror the server run-time resolution, including the managed-sandbox-only
      // redirect: when the resolution lands on the local environment and the
      // policy is on, probe the managed sandbox the real run uses instead. The
      // resolver throws when no managed sandbox is available, which the mutation
      // surfaces as a fail-closed error rather than a local host probe.
      const environmentId = resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: rawCurrentDefaultEnvironmentId || null,
        instanceDefaultEnvironmentId: settings?.defaultEnvironmentId ?? null,
        localDefaultEnvironmentId: resolveLocalDefaultEnvironmentId(environmentList),
        managedSandboxOnly,
        managedSandboxEnvironmentId: resolveManagedSandboxEnvironmentId(environmentList),
        // The policy hides the local environment, so an agent default that still
        // points at the hidden local row names no visible environment. Pass the
        // visible ids so the resolver redirects that stale local default to the
        // managed sandbox instead of sending the hidden local id to the server.
        visibleEnvironmentIds: environmentList.map((environment) => environment.id),
      });
      const testResults: Array<{ label: string; model: string | null; result: AdapterEnvironmentTestResult }> = [
        {
          label: "Primary model",
          model: primaryModel,
          result: await runEnvironmentTestCase(
            "Primary model",
            primaryModel,
            buildAdapterConfigForTest(adapterConfigPatch),
            environmentId,
          ),
        },
      ];

      if (cheapTestCase) {
        testResults.push({
          label: "Cheap model",
          model: cheapTestCase.model,
          result: await runEnvironmentTestCase(
            "Cheap model",
            cheapTestCase.model,
            cheapTestCase.adapterConfig,
            environmentId,
          ),
        });
      }

      return testResults.length > 1
        ? mergeEnvironmentTestResults(testResults.map(({ result }) => result))
        : testResults[0]!.result;
    },
  });
  const [testActionPending, setTestActionPending] = useState(false);
  const [testActionError, setTestActionError] = useState<string | null>(null);
  const testActionLabel = "Test";
  const isSavePending = !isCreate && Boolean(props.isSaving);
  const testEnvironmentDisabled = testActionPending || isSavePending || !selectedCompanyId;

  // Drop a stale Test result when the adapter type or the effective environment
  // changes. A held result would keep the login affordance visible for a target
  // the user no longer selected. The reset unmounts the login panel too, so its
  // session state clears with it. Hold `reset` in a ref so the effect does not
  // re-run on every render (the mutation object has a new identity each render).
  const resetTestEnvironmentRef = useRef(testEnvironment.reset);
  resetTestEnvironmentRef.current = testEnvironment.reset;

  // Clear a stale Claude login claim when the adapter type or the effective
  // environment changes. A login binds `CLAUDE_CODE_OAUTH_TOKEN` to one specific
  // environment. After the environment changes, the held claim and the fixed
  // binding no longer match the new target. The create request would still send
  // the claim, and the server would reject it. So drop the claim, the
  // apply-existing flag, and the fixed binding, and return the login panel to
  // its initial state. Only create mode holds this form state; edit mode saves
  // the binding at login time. Hold the clear in a ref so the effect does not
  // re-run on every render (`set` and `val` have a new identity each render).
  const clearClaudeLoginClaimRef = useRef<() => void>(() => {});
  clearClaudeLoginClaimRef.current = () => {
    if (!isCreate || !set) return;
    const bindings = (val!.envBindings ?? {}) as Record<string, EnvBinding>;
    const hasClaim =
      val!.claudeStoredSessionId != null || val!.claudeApplyStoredLogin === true;
    const hasBinding = CLAUDE_OAUTH_TOKEN_ENV_KEY in bindings;
    if (!hasClaim && !hasBinding) return;
    const nextBindings = { ...bindings };
    delete nextBindings[CLAUDE_OAUTH_TOKEN_ENV_KEY];
    set({
      envBindings: nextBindings,
      claudeStoredSessionId: null,
      claudeApplyStoredLogin: false,
    });
  };

  useEffect(() => {
    resetTestEnvironmentRef.current();
    setTestActionError(null);
    clearClaudeLoginClaimRef.current();
  }, [adapterType, effectiveLoginEnvironmentId]);

  // Show the login affordance only for a current sandbox adapter that declares a
  // login capability, and whose most recent Test result carries the canonical
  // auth-missing check. The form reads the projected capability, not the adapter
  // name. The result keeps its own `adapterType`, so the form reads the
  // capability for that result adapter; a result from an adapter with no login
  // capability never gates the panel.
  const adapterSupportsSandboxLogin = adapterCaps.login != null;
  const testResult = testEnvironment.data;
  const testResultSupportsSandboxLogin =
    testResult != null && getCapabilities(testResult.adapterType).login != null;
  const authMissingCheck =
    testResult && testResultSupportsSandboxLogin
      ? testResult.checks.find((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE) ?? null
      : null;
  // A login runs on a real pseudo-terminal, so it needs a provider that
  // advertises the login pseudo-terminal capability. Read the capability for the
  // effective environment provider. The form reads the adapter login capability,
  // not the adapter name: every adapter login gates on this provider capability.
  const effectiveLoginProvider =
    typeof effectiveLoginEnvironment?.config?.provider === "string"
      ? effectiveLoginEnvironment.config.provider
      : null;
  const providerSupportsLoginPty =
    effectiveLoginProvider != null &&
    environmentCapabilities?.sandboxProviders?.[effectiveLoginProvider]?.supportsLoginPty === true;
  const loginNeedsPty = adapterCaps.login != null;
  const showAdapterLogin =
    adapterSupportsSandboxLogin &&
    effectiveLoginEnvironment?.driver === "sandbox" &&
    Boolean(effectiveLoginEnvironmentId) &&
    Boolean(selectedCompanyId) &&
    Boolean(authMissingCheck) &&
    (!loginNeedsPty || providerSupportsLoginPty);
  const runEnvironmentTest = useCallback(async () => {
    if (!selectedCompanyId) {
      throw new Error("Select a company to test adapter environment");
    }
    setTestActionPending(true);
    setTestActionError(null);
    testEnvironment.reset();
    try {
      return await testEnvironment.mutateAsync();
    } catch (error) {
      setTestActionError(error instanceof Error ? error.message : "Environment test failed");
      throw error;
    } finally {
      setTestActionPending(false);
    }
  }, [selectedCompanyId, testEnvironment]);
  // `runEnvironmentTest` (and `testEnvironmentDisabled`) change identity on every
  // render because `useMutation` returns a fresh result object each time. Hold the
  // latest behavior in a ref so the trigger handed to the parent stays referentially
  // stable — otherwise the `onTestActionChange` effect below re-runs every render,
  // pushing a new function into parent state and causing an infinite update loop.
  const triggerRef = useRef<() => void>(() => {});
  useEffect(() => {
    triggerRef.current = () => {
      if (testEnvironmentDisabled) return;
      void runEnvironmentTest().catch(() => undefined);
    };
  }, [runEnvironmentTest, testEnvironmentDisabled]);
  const triggerTestEnvironment = useCallback(() => {
    triggerRef.current();
  }, []);

  useEffect(() => {
    if (!showAdapterTestEnvironmentButton || !props.onTestActionChange) return;
    props.onTestActionChange(triggerTestEnvironment);
    return () => {
      props.onTestActionChange?.(null);
    };
  }, [showAdapterTestEnvironmentButton, props.onTestActionChange, triggerTestEnvironment]);

  useEffect(() => {
    if (!showAdapterTestEnvironmentButton || !props.onTestActionStateChange) return;
    props.onTestActionStateChange({
      disabled: testEnvironmentDisabled,
      pending: testActionPending,
    });
    return () => {
      props.onTestActionStateChange?.({ disabled: true, pending: false });
    };
  }, [
    showAdapterTestEnvironmentButton,
    props.onTestActionStateChange,
    testEnvironmentDisabled,
    testActionPending,
  ]);

  useEffect(() => {
    if (!props.onTestFeedbackChange) return;
    props.onTestFeedbackChange({
      errorMessage: testActionError
        ?? (testEnvironment.error instanceof Error
          ? testEnvironment.error.message
          : testEnvironment.error
            ? "Environment test failed"
            : null),
      result: testEnvironment.data ?? null,
      // `showAdapterLogin` already requires a selected company and a non-empty
      // environment id, so both are present here.
      login:
        showAdapterLogin && selectedCompanyId && effectiveLoginEnvironmentId
          ? { companyId: selectedCompanyId, adapterType, environmentId: effectiveLoginEnvironmentId }
          : null,
    });
    return () => {
      props.onTestFeedbackChange?.({ errorMessage: null, result: null, login: null });
    };
  }, [
    props.onTestFeedbackChange,
    testActionError,
    testEnvironment.data,
    testEnvironment.error,
    showAdapterLogin,
    selectedCompanyId,
    adapterType,
    effectiveLoginEnvironmentId,
  ]);

  // Current model for display
  const currentModelValue = isCreate
    ? val!.model ?? ""
    : eff("adapterConfig", "model", String(config.model ?? ""));
  const currentModelId = typeof currentModelValue === "string" ? currentModelValue : "";

  async function handleRefreshModels() {
    if (!selectedCompanyId) return;
    setRefreshingModels(true);
    setRefreshModelsError(null);
    try {
      const refreshed = await agentsApi.adapterModels(selectedCompanyId, adapterType, { refresh: true });
      queryClient.setQueryData(modelQueryKey, refreshed);
    } catch (error) {
      setRefreshModelsError(error instanceof Error ? error.message : "Failed to refresh adapter models.");
    } finally {
      setRefreshingModels(false);
    }
  }

  const thinkingEffortKey =
    adapterType === "codex_local"
      ? "modelReasoningEffort"
      : adapterType === "cursor"
        ? "mode"
        : adapterType === "opencode_local"
          ? "variant"
          : "effort";
  const thinkingEffortOptions =
    adapterType === "codex_local"
      ? codexThinkingEffortOptions
      : adapterType === "cursor"
        ? cursorModeOptions
        : adapterType === "opencode_local"
          ? openCodeThinkingEffortOptions
          : adapterType === "kimi_local"
            ? kimiThinkingEffortOptions
            : claudeThinkingEffortOptions;
  const currentThinkingEffort = isCreate
    ? val!.thinkingEffort
    : adapterType === "codex_local"
      ? eff(
          "adapterConfig",
          "modelReasoningEffort",
          String(config.modelReasoningEffort ?? config.reasoningEffort ?? ""),
        )
      : adapterType === "cursor"
        ? eff("adapterConfig", "mode", String(config.mode ?? ""))
        : adapterType === "opencode_local"
          ? eff("adapterConfig", "variant", String(config.variant ?? ""))
          : eff("adapterConfig", "effort", String(config.effort ?? ""));
  const showThinkingEffort = adapterType !== "gemini_local" && adapterType !== "cursor_cloud";
  const codexSearchEnabled = adapterType === "codex_local"
    ? (isCreate ? Boolean(val!.search) : eff("adapterConfig", "search", Boolean(config.search)))
    : false;
  // Cheap profile read/write helpers. Edit-mode values come from
  // runtimeConfig.modelProfiles.cheap with overlay overrides on top; create-mode
  // values come straight from CreateConfigValues (cheapModel + cheapModelEnabled).
  const cheapProfileFromAgent = useMemo(() => {
    const profiles = (runtimeConfig.modelProfiles ?? {}) as Record<string, unknown>;
    const cheap = (profiles.cheap ?? {}) as Record<string, unknown>;
    const cheapAdapterConfig = asObject(cheap.adapterConfig);
    return {
      enabled: cheap.enabled !== false,
      adapterConfig: cheapAdapterConfig,
      model: typeof cheapAdapterConfig.model === "string" ? cheapAdapterConfig.model : "",
    };
  }, [runtimeConfig]);
  const cheapOverlay = !isCreate ? overlay.modelProfiles?.cheap : undefined;
  const currentCheapEnabled = isCreate
    ? val!.cheapModelEnabled ?? false
    : cheapOverlay?.enabled ?? cheapProfileFromAgent.enabled;
  const currentCheapModel = isCreate
    ? val!.cheapModel ?? ""
    : (() => {
        const overlayModel = (cheapOverlay?.adapterConfig as Record<string, unknown> | undefined)?.model;
        if (typeof overlayModel === "string") return overlayModel;
        return cheapProfileFromAgent.model;
      })();

  function setCheapEnabled(next: boolean) {
    if (isCreate) {
      set!({ cheapModelEnabled: next });
      return;
    }
    setOverlay((prev) => ({
      ...prev,
      modelProfiles: {
        cheap: {
          ...(prev.modelProfiles?.cheap ?? {}),
          enabled: next,
        },
      },
    }));
  }

  function setCheapModel(next: string) {
    if (isCreate) {
      set!({ cheapModel: next });
      return;
    }
    setOverlay((prev) => {
      const existing = prev.modelProfiles?.cheap ?? {};
      const nextAdapterConfig = {
        ...((existing.adapterConfig ?? {}) as Record<string, unknown>),
        model: next || undefined,
      };
      return {
        ...prev,
        modelProfiles: {
          cheap: {
            ...existing,
            adapterConfig: nextAdapterConfig,
          },
        },
      };
    });
  }

  const effectiveRuntimeConfig = useMemo(() => {
    if (isCreate) {
      return {
        heartbeat: {
          enabled: val!.heartbeatEnabled,
          intervalSec: val!.intervalSec,
        },
      };
    }
    const mergedHeartbeat = {
      ...(runtimeConfig.heartbeat && typeof runtimeConfig.heartbeat === "object"
        ? runtimeConfig.heartbeat as Record<string, unknown>
        : {}),
      ...overlay.heartbeat,
    };
    return {
      ...runtimeConfig,
      heartbeat: mergedHeartbeat,
    };
  }, [isCreate, overlay.heartbeat, runtimeConfig, val]);
  const effectiveHeartbeat = asObject(effectiveRuntimeConfig.heartbeat);
  const maxTurnContinuation = asObject(effectiveHeartbeat.maxTurnContinuation);
  const maxTurnContinuationEnabled = asBoolean(maxTurnContinuation.enabled, true);
  const maxTurnContinuationMaxAttempts = clampInteger(
    asFiniteNumber(maxTurnContinuation.maxAttempts, MAX_TURN_CONTINUATION_DEFAULT_MAX_ATTEMPTS),
    0,
    MAX_TURN_CONTINUATION_MAX_ATTEMPTS_CAP,
  );
  const maxTurnContinuationDelaySec = clampInteger(
    asFiniteNumber(maxTurnContinuation.delayMs, MAX_TURN_CONTINUATION_DEFAULT_DELAY_SEC * 1000) / 1000,
    0,
    MAX_TURN_CONTINUATION_MAX_DELAY_SEC,
  );

  function updateMaxTurnContinuation(patch: Record<string, unknown>) {
    mark("heartbeat", "maxTurnContinuation", {
      ...maxTurnContinuation,
      ...patch,
    });
  }

  if (!isCreate && props.content === "secrets") {
    return (
      <div className={cn("relative", cards && "space-y-6")}>
        {isDirty && !props.hideInlineSave && (
          <div className="sticky top-0 z-10 flex items-center justify-end border-b border-primary/20 bg-background/90 px-4 py-2 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">Unsaved changes</span>
              <Button size="sm" onClick={handleSave} disabled={props.isSaving}>
                {props.isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        )}

        <div className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="mb-3 text-sm font-medium">Secret access</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Secret access</div>
          }
          <div className={cn(cards ? "space-y-3 rounded-lg border border-border p-4" : "space-y-3 px-4 pb-3")}>
            <p className="text-xs text-muted-foreground">{help.secretAccess}</p>
            <AgentSecretAccessEditor
              config={{ ...config, ...overlay.adapterConfig }}
              secrets={availableSecrets}
              onChange={applyAccessGrants}
              onCreateSecret={(name, value) => createSecret.mutateAsync({ name, value })}
              proposals={agentBindingProposals}
              onApproveProposal={proposalReview.requestApprove}
              onRejectProposal={proposalReview.requestReject}
            />
            {proposalReview.dialogs}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative", cards && "space-y-6")}>
      {/* ---- Floating Save button (edit mode, when dirty) ---- */}
      {isDirty && !props.hideInlineSave && (
        <div className="sticky top-0 z-10 flex items-center justify-end px-4 py-2 bg-background/90 backdrop-blur-sm border-b border-primary/20">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">Unsaved changes</span>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!isCreate && props.isSaving}
            >
              {!isCreate && props.isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* ---- Identity (edit only) ---- */}
      {!isCreate && (
        <div className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">Identity</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Identity</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <Field label="Name" hint={help.name}>
              <DraftInput
                value={eff("identity", "name", props.agent.name)}
                onCommit={(v) => mark("identity", "name", v)}
                immediate
                className={inputClass}
                placeholder="Agent name"
              />
            </Field>
            <Field label="Title" hint={help.title}>
              <DraftInput
                value={eff("identity", "title", props.agent.title ?? "")}
                onCommit={(v) => mark("identity", "title", v || null)}
                immediate
                className={inputClass}
                placeholder="e.g. VP of Engineering"
              />
            </Field>
            <Field label="Reports to" hint={help.reportsTo}>
              <ReportsToPicker
                agents={companyAgents}
                value={eff("identity", "reportsTo", props.agent.reportsTo ?? null)}
                onChange={(id) => mark("identity", "reportsTo", id)}
                excludeAgentIds={[props.agent.id]}
                chooseLabel="Choose manager…"
              />
            </Field>
            <Field label="Capabilities" hint={help.capabilities}>
              <MarkdownEditor
                value={eff("identity", "capabilities", props.agent.capabilities ?? "") ?? ""}
                onChange={(v) => mark("identity", "capabilities", v || null)}
                placeholder="Describe what this agent can do..."
                contentClassName="min-h-(--sz-44px) text-sm font-mono"
                imageUploadHandler={async (file) => {
                  const asset = await uploadMarkdownImage.mutateAsync({
                    file,
                    namespace: `agents/${props.agent.id}/capabilities`,
                  });
                  return asset.contentPath;
                }}
              />
            </Field>
            {isLocal && !props.hidePromptTemplate && (
              <>
                <Field label="Prompt Template" hint={help.promptTemplate}>
                  <MarkdownEditor
                    value={eff(
                      "adapterConfig",
                      "promptTemplate",
                      String(config.promptTemplate ?? ""),
                    )}
                    onChange={(v) => mark("adapterConfig", "promptTemplate", v ?? "")}
                    placeholder="You are agent {{ agent.name }}. Your role is {{ agent.role }}..."
                    contentClassName="min-h-(--sz-88px) text-sm font-mono"
                    imageUploadHandler={async (file) => {
                      const namespace = `agents/${props.agent.id}/prompt-template`;
                      const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                      return asset.contentPath;
                    }}
                  />
                </Field>
                <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
                  Prompt template is replayed on every heartbeat. Keep it compact and dynamic to avoid recurring token cost and cache churn.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- Execution ---- */}
      {forcedKubernetes ? (
        // Instance execution policy forces the managed Kubernetes sandbox
        // (executionMode=kubernetes): never offer local / non-Kubernetes targets.
        // Render the environment read-only instead of the selectable picker.
        <div className={cn(!cards && (isCreate ? "border-t border-border" : "border-b border-border"))}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">Environment</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Environment</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <Field
              label="Default environment"
              hint="This instance runs all agents in the Kubernetes sandbox. Local execution is disabled."
            >
              {kubernetesEnvironment ? (
                <div className={cn(inputClass, "flex items-center text-muted-foreground")}>
                  {kubernetesEnvironment.name} · Kubernetes sandbox
                </div>
              ) : (
                <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                  This instance requires the Kubernetes sandbox, but no managed Kubernetes
                  environment is available for this company yet. Configure one before creating
                  agents; execution will not fall back to local.
                </div>
              )}
            </Field>
          </div>
        </div>
      ) : showEnvironmentOverrideControl ? (
        <div className={cn(!cards && (isCreate ? "border-t border-border" : "border-b border-border"))}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">Environment</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Environment</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <Field label="Environment override">
              <div className="space-y-2">
                <select
                  className={inputClass}
                  value={currentDefaultEnvironmentId}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    if (isCreate) {
                      set!({ defaultEnvironmentId: nextValue });
                      return;
                    }
                    mark("identity", "defaultEnvironmentId", nextValue || null);
                  }}
                >
                  <option value="">Default: {inheritedEnvironmentLabel}</option>
                  {environmentOptions.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environmentDisplayLabel(environment)}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          </div>
        </div>
      ) : null}

      {/* ---- Adapter ---- */}
      <div className={cn(!cards && (isCreate ? "border-t border-border" : "border-b border-border"))}>
        <div className={cn(cards ? "flex items-center justify-between mb-3" : "px-4 py-2 flex items-center justify-between gap-2")}>
          {cards
            ? <h3 className="text-sm font-medium">Adapter</h3>
            : <span className="text-xs font-medium text-muted-foreground">Adapter</span>
          }
          {showInlineAdapterTestEnvironmentButton && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={triggerTestEnvironment}
              disabled={testEnvironmentDisabled}
            >
              {testActionPending ? `${testActionLabel}...` : testActionLabel}
            </Button>
          )}
        </div>
        <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
          {showAdapterTypeField && (
            <Field label="Adapter type" hint={help.adapterType}>
              <AdapterTypeDropdown
                value={adapterType}
                disabledTypes={disabledTypes}
                onChange={(t) => {
                  if (isCreate) {
                    // Reset all adapter-specific fields to defaults when switching adapter type
                    const { adapterType: _at, ...defaults } = defaultCreateValues;
                    const nextValues: CreateConfigValues = { ...defaults, adapterType: t };
                    if (t === "codex_local") {
                      nextValues.dangerouslyBypassSandbox =
                        DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
                    } else if (t === "gemini_local") {
                      nextValues.model = DEFAULT_GEMINI_LOCAL_MODEL;
                    } else if (t === "kimi_local") {
                      nextValues.model = DEFAULT_KIMI_LOCAL_MODEL;
                    } else if (t === "cursor") {
                      nextValues.model = DEFAULT_CURSOR_LOCAL_MODEL;
                    } else if (t === "opencode_local") {
                      nextValues.model = DEFAULT_OPENCODE_LOCAL_MODEL;
                    }
                    set!(nextValues);
                  } else {
                    // Clear all adapter config and explicitly blank out model + effort/mode keys
                    // so the old adapter's values don't bleed through via eff()
                    setOverlay((prev) => ({
                      ...prev,
                      adapterType: t,
                      modelProfiles: { cheap: { cleared: true } },
                      adapterConfig: {
                        model:
                          t === "gemini_local"
                            ? DEFAULT_GEMINI_LOCAL_MODEL
                            : t === "kimi_local"
                              ? DEFAULT_KIMI_LOCAL_MODEL
                            : t === "opencode_local"
                              ? DEFAULT_OPENCODE_LOCAL_MODEL
                            : t === "cursor"
                              ? DEFAULT_CURSOR_LOCAL_MODEL
                              : "",
                        effort: "",
                        modelReasoningEffort: "",
                        variant: "",
                        mode: "",
                        ...(t === "codex_local"
                          ? {
                              dangerouslyBypassApprovalsAndSandbox:
                                DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
                            }
                          : {}),
                      },
                    }));
                  }
                }}
              />
            </Field>
          )}

          {showInlineAdapterTestEnvironmentFeedback && (testActionError || testEnvironment.error) && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {testActionError
                ?? (testEnvironment.error instanceof Error
                  ? testEnvironment.error.message
                  : "Environment test failed")}
            </div>
          )}

          {showInlineAdapterTestEnvironmentFeedback && testEnvironment.data && (
            <AdapterEnvironmentResult result={testEnvironment.data} />
          )}

          {showInlineAdapterTestEnvironmentFeedback && showAdapterLogin && (
            <AdapterLoginPanel
              key={`${adapterType}:${effectiveLoginEnvironmentId}`}
              companyId={selectedCompanyId!}
              adapterType={adapterType}
              environmentId={effectiveLoginEnvironmentId!}
              onStored={isCreate ? handleClaudeLoginStored : handleClaudeLoginStoredEdit}
              onApplyStored={
                isCreate ? handleApplyStoredClaudeLogin : handleApplyStoredClaudeLoginEdit
              }
            />
          )}

          {/* Working directory */}
          {showLegacyWorkingDirectoryField && (
            <Field label="Working directory (deprecated)" hint={help.cwd}>
              <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
                <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <DraftInput
                  value={
                    isCreate
                      ? val!.cwd
                      : eff("adapterConfig", "cwd", String(config.cwd ?? ""))
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ cwd: v })
                      : mark("adapterConfig", "cwd", v || undefined)
                  }
                  immediate
                  className="w-full bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40"
                  placeholder="/path/to/project"
                />
                <ChoosePathButton />
              </div>
            </Field>
          )}

          {!isLocal && <uiAdapter.ConfigFields {...adapterFieldProps} />}

          {/* Local adapter-specific fields are rendered inside Permissions & Configuration */}
        </div>

      </div>

      {/* ---- Permissions & Configuration ---- */}
      {isLocal && (
        <div className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">Permissions &amp; Configuration</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Permissions &amp; Configuration</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
              <Field label="Command" hint={help.localCommand}>
                <DraftInput
                  value={
                    isCreate
                      ? val!.command
                      : eff(
                          "adapterConfig",
                          adapterCommandField,
                          String(
                            config.command ?? "",
                          ),
                        )
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ command: v })
                      : mark("adapterConfig", adapterCommandField, v || null)
                  }
                  immediate
                  className={inputClass}
                  placeholder={
                    ({
                      claude_local: "claude",
                      codex_local: "codex",
                      gemini_local: "gemini",
                      kimi_local: "kimi",
                      pi_local: "pi",
                      cursor: "agent",
                      opencode_local: "opencode",
                    } as Record<string, string>)[adapterType] ?? adapterType.replace(/_local$/, "")
                  }
                />
              </Field>

              {supportsModelProfiles && (
                <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">Primary model</div>
              )}
              <ModelDropdown
                models={models}
                value={currentModelId}
                onChange={(v) =>
                  isCreate
                    ? set!({ model: v })
                    : mark("adapterConfig", "model", v || undefined)
                }
                open={modelOpen}
                onOpenChange={setModelOpen}
                allowDefault={adapterType !== "opencode_local"}
                required={adapterType === "opencode_local"}
                groupByProvider={adapterType === "opencode_local"}
                creatable
                detectedModel={detectedModel}
                detectedModelCandidates={[]}
                onDetectModel={adapterType === "opencode_local"
                  ? undefined
                  : async () => {
                      const result = await refetchDetectedModel();
                      return result.data?.model ?? null;
                    }}
                onRefreshModels={
                  supportsAdapterModelRefresh(adapterType)
                    ? handleRefreshModels
                    : undefined
                }
                refreshingModels={refreshingModels}
                detectModelLabel="Detect model"
                emptyDetectHint="No model detected. Select or enter one manually."
              />
              {(refreshModelsError || fetchedModelsError) && (
                <p className="text-xs text-destructive">
                  {refreshModelsError
                    ?? (fetchedModelsError instanceof Error
                      ? fetchedModelsError.message
                      : "Failed to load adapter models.")}
                </p>
              )}
              {adapterType === "opencode_local"
                && currentDefaultEnvironment
                && currentDefaultEnvironment.driver !== "local" && (
                <p className="text-xs text-muted-foreground">
                  Live OpenCode model discovery only runs for Local environments. Using the curated list and manual entry for {currentDefaultEnvironment.name}.
                </p>
              )}

              {supportsModelProfiles && (
                <CheapModelSection
                  enabled={currentCheapEnabled}
                  model={currentCheapModel}
                  models={models}
                  adapterType={adapterType}
                  adapterDefaultModel={adapterCheapDefaultModel}
                  onEnabledChange={setCheapEnabled}
                  onModelChange={setCheapModel}
                  open={cheapModelOpen}
                  onOpenChange={setCheapModelOpen}
                />
              )}

              {showThinkingEffort && (
                <>
                  <ThinkingEffortDropdown
                    value={currentThinkingEffort}
                    options={thinkingEffortOptions}
                    onChange={(v) =>
                      isCreate
                        ? set!({ thinkingEffort: v })
                        : mark("adapterConfig", thinkingEffortKey, v || undefined)
                    }
                    open={thinkingEffortOpen}
                    onOpenChange={setThinkingEffortOpen}
                  />
                  {adapterType === "codex_local" &&
                    codexSearchEnabled &&
                    currentThinkingEffort === "minimal" && (
                      <p className="text-xs text-amber-400">
                        Codex may reject `minimal` thinking when search is enabled.
                      </p>
                    )}
                </>
              )}
              {!isCreate && typeof config.bootstrapPromptTemplate === "string" && config.bootstrapPromptTemplate && (
                <>
                  <Field label="Bootstrap prompt (legacy)" hint={help.bootstrapPrompt}>
                    <MarkdownEditor
                      value={eff(
                        "adapterConfig",
                        "bootstrapPromptTemplate",
                        String(config.bootstrapPromptTemplate ?? ""),
                      )}
                      onChange={(v) =>
                        mark("adapterConfig", "bootstrapPromptTemplate", v || undefined)
                      }
                      placeholder="Optional initial setup prompt for the first run"
                      contentClassName="min-h-(--sz-44px) text-sm font-mono"
                      imageUploadHandler={async (file) => {
                        const namespace = `agents/${props.agent.id}/bootstrap-prompt`;
                        const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                        return asset.contentPath;
                      }}
                    />
                  </Field>
                  <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                    Bootstrap prompt is legacy and will be removed in a future release. Consider moving this content into the agent&apos;s prompt template or instructions file instead.
                  </div>
                </>
              )}
              {adapterType === "claude_local" && (
                <ClaudeLocalAdvancedFields {...adapterFieldProps} />
              )}
              <uiAdapter.ConfigFields {...adapterFieldProps} />

              <Field label="Extra args (comma-separated)" hint={help.extraArgs}>
                <DraftInput
                  value={
                    isCreate
                      ? val!.extraArgs
                      : eff("adapterConfig", "extraArgs", formatArgList(config.extraArgs))
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ extraArgs: v })
                      : mark("adapterConfig", "extraArgs", v?.trim() ? parseCommaArgs(v) : null)
                  }
                  className={inputClass}
                  placeholder="e.g. --verbose, --foo=bar"
                />
              </Field>

              <Field label="Environment variables" hint={help.envVars}>
                <EnvironmentVariablesEditor
                  ref={environmentVariablesEditorRef}
                  value={
                    isCreate
                      ? ((val!.envBindings ?? EMPTY_ENV) as Record<string, EnvBinding>)
                      : (eff("adapterConfig", "env", (config.env ?? EMPTY_ENV) as Record<string, EnvBinding>))
                  }
                  secrets={availableSecrets}
                  userSecretDefinitions={userSecretDefinitions}
                  onCreateSecret={async (name, value) => {
                    const created = await createSecret.mutateAsync({ name, value });
                    return created;
                  }}
                  onChange={(env) =>
                    isCreate
                      ? set!({ envBindings: env ?? {}, envVars: "" })
                      : mark("adapterConfig", "env", env)
                  }
                />
              </Field>

              {/* Edit-only: timeout + grace period */}
              {!isCreate && (
                <>
                  <Field label="Timeout (sec)" hint={help.timeoutSec}>
                    <DraftNumberInput
                      value={eff(
                        "adapterConfig",
                        "timeoutSec",
                        Number(config.timeoutSec ?? 0),
                      )}
                      onCommit={(v) => mark("adapterConfig", "timeoutSec", v)}
                      immediate
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Interrupt grace period (sec)" hint={help.graceSec}>
                    <DraftNumberInput
                      value={eff(
                        "adapterConfig",
                        "graceSec",
                        Number(config.graceSec ?? 15),
                      )}
                      onCommit={(v) => mark("adapterConfig", "graceSec", v)}
                      immediate
                      className={inputClass}
                    />
                  </Field>
                </>
              )}
          </div>
        </div>
      )}

      {/* ---- Run Policy ---- */}
      {isCreate && showCreateRunPolicySection ? (
        <div className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium flex items-center gap-2 mb-3"><Heart className="h-3 w-3" /> Run Policy</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground flex items-center gap-2"><Heart className="h-3 w-3" /> Run Policy</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <ToggleWithNumber
              label="Heartbeat on interval"
              hint={help.heartbeatInterval}
              checked={val!.heartbeatEnabled}
              onCheckedChange={(v) => set!({ heartbeatEnabled: v })}
              number={val!.intervalSec}
              onNumberChange={(v) => set!({ intervalSec: v })}
              numberLabel="sec"
              numberPrefix="Run heartbeat every"
              numberHint={help.intervalSec}
              showNumber={val!.heartbeatEnabled}
            />
          </div>
        </div>
      ) : !isCreate ? (
        <div className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium flex items-center gap-2 mb-3"><Heart className="h-3 w-3" /> Run Policy</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground flex items-center gap-2"><Heart className="h-3 w-3" /> Run Policy</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg overflow-hidden" : "")}>
            <div className={cn(cards ? "p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
              <ToggleWithNumber
                label="Heartbeat on interval"
                hint={help.heartbeatInterval}
                checked={eff("heartbeat", "enabled", heartbeat.enabled === true)}
                onCheckedChange={(v) => mark("heartbeat", "enabled", v)}
                number={eff("heartbeat", "intervalSec", Number(heartbeat.intervalSec ?? 300))}
                onNumberChange={(v) => mark("heartbeat", "intervalSec", v)}
                numberLabel="sec"
                numberPrefix="Run heartbeat every"
                numberHint={help.intervalSec}
                showNumber={eff("heartbeat", "enabled", heartbeat.enabled === true)}
              />
            </div>
            <CollapsibleSection
              title="Advanced Run Policy"
              bordered={cards}
              open={runPolicyAdvancedOpen}
              onToggle={() => setRunPolicyAdvancedOpen(!runPolicyAdvancedOpen)}
            >
            <div className="space-y-3">
              <ToggleField
                label="Wake on demand"
                hint={help.wakeOnDemand}
                checked={eff(
                  "heartbeat",
                  "wakeOnDemand",
                  heartbeat.wakeOnDemand !== false,
                )}
                onChange={(v) => mark("heartbeat", "wakeOnDemand", v)}
              />
              <Field label="Cooldown (sec)" hint={help.cooldownSec}>
                <DraftNumberInput
                  value={eff(
                    "heartbeat",
                    "cooldownSec",
                    Number(heartbeat.cooldownSec ?? 10),
                  )}
                  onCommit={(v) => mark("heartbeat", "cooldownSec", v)}
                  immediate
                  className={inputClass}
                />
              </Field>
              <Field label="Max concurrent runs" hint={help.maxConcurrentRuns}>
                <DraftNumberInput
                  value={eff(
                    "heartbeat",
                    "maxConcurrentRuns",
                    Number(heartbeat.maxConcurrentRuns ?? AGENT_DEFAULT_MAX_CONCURRENT_RUNS),
                  )}
                  onCommit={(v) => mark("heartbeat", "maxConcurrentRuns", v)}
                  immediate
                  className={inputClass}
                />
              </Field>
              <div className="rounded-md border border-border/70 px-3 py-2">
                <ToggleField
                  label="Continue after max-turn stop"
                  hint={help.maxTurnContinuationEnabled}
                  checked={maxTurnContinuationEnabled}
                  onChange={(v) => updateMaxTurnContinuation({ enabled: v })}
                />
                {maxTurnContinuationEnabled ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Continuation attempts" hint={help.maxTurnContinuationMaxAttempts}>
                      <DraftNumberInput
                        value={maxTurnContinuationMaxAttempts}
                        onCommit={(v) =>
                          updateMaxTurnContinuation({
                            maxAttempts: clampInteger(v, 0, MAX_TURN_CONTINUATION_MAX_ATTEMPTS_CAP),
                          })}
                        immediate
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Continuation delay (sec)" hint={help.maxTurnContinuationDelaySec}>
                      <DraftNumberInput
                        value={maxTurnContinuationDelaySec}
                        onCommit={(v) =>
                          updateMaxTurnContinuation({
                            delayMs: clampDelayMsFromSeconds(v),
                          })}
                        immediate
                        className={inputClass}
                      />
                    </Field>
                  </div>
                ) : null}
              </div>
            </div>
          </CollapsibleSection>
          </div>
        </div>
      ) : null}

    </div>
  );
}

// The public session states that end a login. The panel stops the status poll
// and shows a terminal message when the session reaches one of these.
const ADAPTER_LOGIN_TERMINAL_STATUSES = new Set<AdapterAuthSessionStatus>([
  "authenticated",
  "failed",
  "timed_out",
  "cancelled",
]);

// The status route poll interval while a session is active (Decision A). The
// poll stops at a terminal state.
const ADAPTER_LOGIN_POLL_INTERVAL_MS = 2000;

// A copy-to-clipboard button. It mirrors the workspace service control bar: a
// short "copied" flash, then it returns to the copy icon.
function AdapterLoginCopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      className="text-muted-foreground hover:text-foreground"
      onClick={async () => {
        try {
          await copyTextToClipboard(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </Button>
  );
}

// The terminal message for a finished login. It never shows a secret. It shows
// only the fixed, non-secret failure message the server returns.
function AdapterLoginTerminalState({
  status,
  message,
}: {
  status: AdapterAuthSessionStatus;
  message: string | null;
}) {
  if (status === "authenticated") {
    return (
      <div className="flex items-center gap-2 text-(length:--text-micro) text-foreground">
        <Check className="size-3 shrink-0" />
        <span>Authenticated. The environment has credentials now.</span>
      </div>
    );
  }
  const label =
    status === "timed_out"
      ? "Login timed out"
      : status === "cancelled"
        ? "Login cancelled"
        : "Login failed";
  return (
    <div className="flex items-start gap-2 text-(length:--text-micro) text-destructive">
      <TriangleAlert className="size-3 shrink-0" />
      <span>
        {label}
        {message ? `: ${message}` : "."}
      </span>
    </div>
  );
}

// The login panel for one adapter in one sandbox environment. It starts a login
// session, polls the status route, and shows the one-time code and the
// authentication URL with copy and open actions. It shows the terminal states.
// It never writes the code, the URL, or any credential byte to a log line.
//
// The panel holds its own session state. The parent gives it a stable `key` from
// the adapter type and the environment id, so a change to either remounts the
// panel with a fresh session state.
// The props that identify one login panel: one adapter in one sandbox
// environment for one company. A parent that lifts the test feedback renders
// the panel from this descriptor.
export type AdapterLoginDescriptor = {
  companyId: string;
  adapterType: string;
  environmentId: string;
};

// The panel props. `onStored` reports the non-secret `storedSessionId` claim from
// a Claude login that reaches the server `stored` state. The create-mode form
// holds that claim for the fixed binding; the callback never carries a token.
// `onApplyStored` binds the fixed reference to an existing stored login with no
// new login round trip. The panel shows the apply-existing affordance only when
// the status route reports a stored value.
export type AdapterLoginPanelProps = AdapterLoginDescriptor & {
  onStored?: (storedSessionId: string) => void;
  onApplyStored?: () => void;
};

// The login panel dispatcher. It picks the panel from the projected panel mode,
// not from the adapter name. The `submitted_browser_code` mode shows the
// submitted-browser-code panel; every other mode shows the displayed-code panel.
export function AdapterLoginPanel(props: AdapterLoginPanelProps) {
  const getCapabilities = useAdapterCapabilities();
  const panelMode = getCapabilities(props.adapterType).login?.panelMode;
  if (panelMode === "submitted_browser_code") {
    return <SubmittedBrowserCodeLoginPanel {...props} />;
  }
  return <DisplayedCodeLoginPanel {...props} />;
}

function DisplayedCodeLoginPanel({
  companyId,
  adapterType,
  environmentId,
}: AdapterLoginPanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // The server delivers the one-time prompt on the first owner read only. Latch
  // it so a later poll that returns a null prompt does not hide the code and the
  // URL.
  const [latchedPrompt, setLatchedPrompt] = useState<AdapterAuthSessionPrompt | null>(null);

  const startLogin = useMutation({
    mutationFn: () => agentsApi.startAdapterAuthLogin(companyId, adapterType, { environmentId }),
    onSuccess: (session) => {
      setStartError(null);
      setLatchedPrompt(null);
      setSessionId(session.sessionId);
    },
    onError: (error) => {
      setStartError(error instanceof Error ? error.message : "Could not start the login.");
    },
  });

  const cancelLogin = useMutation({
    mutationFn: () => agentsApi.cancelAdapterAuthLogin(companyId, adapterType, sessionId!),
    onSuccess: () => {
      // Reset local state, so the panel returns to its idle start state and the
      // Log in button is available again.
      setSessionId(null);
      setLatchedPrompt(null);
      setStartError(null);
    },
    onError: (error) => {
      setStartError(error instanceof Error ? error.message : "Could not cancel the login.");
    },
  });

  const statusQuery = useQuery({
    queryKey: ["adapter-login-status", companyId, adapterType, sessionId],
    queryFn: () => agentsApi.getAdapterAuthLoginStatus(companyId, adapterType, sessionId!),
    enabled: Boolean(sessionId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ADAPTER_LOGIN_TERMINAL_STATUSES.has(status)
        ? false
        : ADAPTER_LOGIN_POLL_INTERVAL_MS;
    },
  });

  // Latch the first non-null prompt for the current session. A later poll
  // returns a null prompt after the one-time delivery, so keep the latched value.
  useEffect(() => {
    const next = statusQuery.data?.prompt ?? null;
    if (next) setLatchedPrompt(next);
  }, [statusQuery.data]);

  const session = statusQuery.data ?? startLogin.data ?? null;
  const status = session?.status ?? null;
  const prompt = latchedPrompt;
  const isTerminal = status ? ADAPTER_LOGIN_TERMINAL_STATUSES.has(status) : false;
  const isActive = Boolean(sessionId) && !isTerminal;
  const startDisabled = startLogin.isPending || isActive;

  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">Sign in to the environment</span>
        <div className="flex items-center gap-1.5">
          {isActive && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
              disabled={cancelLogin.isPending}
              onClick={() => cancelLogin.mutate()}
            >
              Cancel
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={startDisabled}
            onClick={() => startLogin.mutate()}
          >
            Log in
          </Button>
        </div>
      </div>

      {startError && (
        <div role="alert" className="text-(length:--text-micro) text-destructive">
          {startError}
        </div>
      )}

      {/* One live region announces the loading, prompt, and terminal states, so a
          screen reader reports each transition without a re-navigation. */}
      <div role="status" aria-live="polite" className="space-y-2 empty:hidden">
        {isActive && !prompt && (
          <div className="flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
            <Loader2 className="size-3 animate-spin shrink-0" />
            <span>Preparing the login…</span>
          </div>
        )}

        {isActive && prompt && (
          <div className="space-y-2">
            <div className="text-(length:--text-micro) text-muted-foreground">
              Open the authentication page and enter the code.
            </div>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
                Code
              </div>
              <span className="font-mono text-xs text-foreground break-all">{prompt.code}</span>
            </div>
            <AdapterLoginCopyButton value={prompt.code} label="Copy code" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
                Authentication URL
              </div>
              <span className="font-mono text-xs text-foreground break-all">{prompt.url}</span>
            </div>
            <div className="flex items-center">
              <AdapterLoginCopyButton value={prompt.url} label="Copy URL" />
              <Button
                asChild
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Open the authentication page"
                title="Open the authentication page"
                className="text-muted-foreground hover:text-foreground"
              >
                <a href={prompt.url} target="_blank" rel="noreferrer noopener">
                  <ExternalLink className="size-3" />
                </a>
              </Button>
            </div>
          </div>
        </div>
        )}

        {isTerminal && status && (
          <AdapterLoginTerminalState status={status} message={session?.failure?.message ?? null} />
        )}
      </div>
    </div>
  );
}

// The public session states that fail a Claude login. The panel returns to its
// start state and shows a fixed message at one of these.
const CLAUDE_LOGIN_FAILURE_STATUSES = new Set<AdapterAuthSessionStatus>([
  "failed",
  "timed_out",
  "cancelled",
]);

// The fixed, non-secret message for a failed Claude login. The panel shows this
// text and returns to its start state. It never shows a provider message that
// could carry a secret.
const CLAUDE_LOGIN_FAILED_MESSAGE = "The login did not finish. Start the login again.";

// The client wall-clock cap for one active login. The panel polls the status
// route and the prompt route every two seconds. The server can leave a session
// short of a terminal status, and the prompt route returns 404 until the URL is
// ready. Without a cap, the panel polls forever. When this cap passes, the panel
// stops both polls and shows the timed-out state, so the user can start again.
// A generous client failsafe for a live login whose server deadline has not
// arrived yet. The server `expiresAt` is the real cutoff; the panel drives the
// timer from it. This failsafe only bounds a stuck poll while the status route
// has not yet returned `expiresAt`, so a login can never poll forever. The
// value is far longer than the server budget, so it never cuts a normal login
// short (the earlier fixed 60-second cutoff did, which drove this fix).
const CLAUDE_LOGIN_FAILSAFE_TIMEOUT_MS = 15 * 60_000;

// The fixed, non-secret message for a timed-out Claude login. The panel shows
// this text, stops both polls, and returns to its start state.
const CLAUDE_LOGIN_TIMED_OUT_MESSAGE = "The login timed out. Start the login again.";

// The submitted-browser-code login panel for the Claude adapter. It starts a
// setup-token login, polls the status route, and reads the authorization URL
// from the guarded prompt route. The user opens the URL, reads the browser code,
// and submits it. The panel clears the code right after submit. The panel treats
// only the server `stored` state as success, and it never shows the OAuth token.
function SubmittedBrowserCodeLoginPanel({
  companyId,
  environmentId,
  onStored,
  onApplyStored,
}: AdapterLoginPanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // The server delivers the authorization URL on the guarded prompt read only.
  // Latch it so a later poll does not hide the URL.
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  // True when the guarded prompt read reports a non-confidential transport. The
  // server does not block a plain-HTTP login. The panel shows a non-blocking
  // disclaimer and the login still proceeds. Latch it beside the URL.
  const [transportInsecure, setTransportInsecure] = useState(false);
  // The browser code the user submits. The panel clears it right after submit, so
  // the secret never lingers in the input.
  const [browserCode, setBrowserCode] = useState("");
  // The non-secret stored-session claim from a completed login. It marks the
  // server `stored` state, the only success state.
  const [storedSessionId, setStoredSessionId] = useState<string | null>(null);
  // True after a completion read fails. The panel returns to its start state.
  const [completionFailed, setCompletionFailed] = useState(false);
  // True after the client wall-clock cap passes for the active login. The panel
  // stops both polls and shows the timed-out state.
  const [timedOut, setTimedOut] = useState(false);
  // True after the status poll returns 404. The server removes the row and the
  // in-memory session at once on any non-stored terminal state, so a status 404
  // means the login failed and the server cleaned up. The panel stops both
  // polls and shows a terminal failure state. It shows no credential material.
  const [statusGone, setStatusGone] = useState(false);
  // Guards the one completion read per session.
  const completionStartedRef = useRef(false);
  // True after the owner applies an existing stored login in this panel. The
  // apply-existing path binds the fixed reference with no new login round trip,
  // so the panel shows the applied confirmation and hides the apply affordance.
  const [appliedStored, setAppliedStored] = useState(false);

  const resetLocalState = () => {
    setStartError(null);
    setAuthorizationUrl(null);
    setTransportInsecure(false);
    setBrowserCode("");
    setStoredSessionId(null);
    setCompletionFailed(false);
    setTimedOut(false);
    setStatusGone(false);
    completionStartedRef.current = false;
  };

  // Read the stored Claude OAuth token status when the panel mounts. A 200 body
  // carries the secret id and the version of the owner value; a 404 means the
  // owner has no stored value. The panel applies the stored token first: when a
  // value exists, a replacement login rotates it under the captured version
  // instead of a blind first write. The server rejects a stale capture, so a
  // change by another process after the capture fails the overwrite.
  const storedTokenQuery = useQuery({
    queryKey: ["claude-oauth-token-status", companyId],
    queryFn: async () => {
      try {
        return await agentsApi.getClaudeOAuthTokenStatus(companyId);
      } catch (error) {
        // A 404 means the owner has no stored value (indistinguishable from a
        // foreign value). The panel treats it as "no stored token".
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 404) return false;
      return failureCount < 2;
    },
  });
  const storedToken = storedTokenQuery.data ?? null;

  const startLogin = useMutation({
    mutationFn: () =>
      agentsApi.startClaudeSetupTokenLogin(companyId, {
        environmentId,
        // When the owner already has a stored token, the login rotates it under
        // the captured version, so a replacement login never conflicts with an
        // existing value. Without a stored token the login is a first write.
        ...(storedToken
          ? {
              overwrite: {
                expectedSecretId: storedToken.secretId,
                expectedLatestVersion: storedToken.latestVersion,
              },
            }
          : {}),
      }),
    onSuccess: (session) => {
      resetLocalState();
      setSessionId(session.sessionId);
    },
    onError: (error) => {
      setStartError(error instanceof Error ? error.message : "Could not start the login.");
    },
  });

  const clearActiveSession = () => {
    // Return the panel to its idle start state. The Log in button is available
    // again, and both polls stop because the session id is null.
    setSessionId(null);
    resetLocalState();
  };

  const cancelLogin = useMutation({
    mutationFn: () => agentsApi.cancelClaudeSetupTokenLogin(companyId, sessionId!),
    onSuccess: () => {
      clearActiveSession();
    },
    onError: (error) => {
      // The cancel is resilient. The server removes a terminal session, so a
      // cancel of an already-terminal or unknown session can return a 404. Treat
      // that 404 the same as a successful cancel: clear the session and stop the
      // polls. The panel never keeps polling a session the server no longer
      // holds. Any other error surfaces and keeps the active login.
      if (error instanceof ApiError && error.status === 404) {
        clearActiveSession();
        return;
      }
      setStartError(error instanceof Error ? error.message : "Could not cancel the login.");
    },
  });

  // Release the server session at once, without a change to the panel state. The
  // client-cutoff timer and the unmount path both use this. The server holds a
  // per-owner reservation until the session reaches a terminal state, so an
  // abandoned session locks the owner out until the server deadline. A best-
  // effort cancel frees that reservation now, so the same owner can start a new
  // login and does not hit the "too many active sessions" cap. The server
  // removes a terminal session, so a 404 means the session is already gone. Treat
  // that 404 the same as a successful cancel. This is a fire-and-forget cleanup,
  // so it drops every error. The manual Cancel button uses the `cancelLogin`
  // mutation instead, because that path also returns the panel to its idle start
  // state.
  const releaseServerSession = useCallback(
    (id: string) => {
      void agentsApi.cancelClaudeSetupTokenLogin(companyId, id).catch(() => {
        // Drop the error. A 404 means the server already removed the session. A
        // cleanup path cannot surface any other error, so it stays silent.
      });
    },
    [companyId],
  );

  // Both polls run only while a session is active and the client cap has not
  // passed. The timeout stops the polls, so the panel never polls forever. A
  // status 404 also stops the polls: the server cleaned up the session, so the
  // panel enters a terminal failure state instead.
  const pollingEnabled = Boolean(sessionId) && !timedOut && !statusGone;

  const statusQuery = useQuery({
    queryKey: ["claude-setup-token-status", companyId, sessionId],
    queryFn: () => agentsApi.getClaudeSetupTokenLoginStatus(companyId, sessionId!),
    enabled: pollingEnabled,
    // A status 404 is terminal. The server removes a cleaned-up session at once,
    // so a retry cannot recover it. Stop at once and fail loudly.
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 404) return false;
      return failureCount < 3;
    },
    refetchInterval: (query) => {
      if (timedOut || statusGone) return false;
      const status = query.state.data?.status;
      return status && ADAPTER_LOGIN_TERMINAL_STATUSES.has(status)
        ? false
        : ADAPTER_LOGIN_POLL_INTERVAL_MS;
    },
  });

  // Fail loudly on a status 404. The server cleans up the reservation, the row,
  // and the in-memory session at once on any non-stored terminal state, so the
  // status route returns 404 when a login fails and the server cleanup wins the
  // race against the next poll. React Query keeps the last successful data on
  // error, so without this branch the panel would hold stale data and show
  // nothing. Enter the terminal failure state, which stops both polls.
  useEffect(() => {
    const error = statusQuery.error;
    if (error instanceof ApiError && error.status === 404) {
      setStatusGone(true);
    }
  }, [statusQuery.error]);

  // Poll the guarded prompt route until it returns the authorization URL. The
  // route returns 404 until the URL is ready, so the panel treats a 404 as
  // not-ready and keeps polling.
  const promptQuery = useQuery({
    queryKey: ["claude-setup-token-prompt", companyId, sessionId],
    enabled: pollingEnabled && !authorizationUrl,
    queryFn: async () => {
      try {
        return await agentsApi.getClaudeSetupTokenLoginPrompt(companyId, sessionId!);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    refetchInterval: (query) =>
      timedOut || query.state.data?.authorizationUrl ? false : ADAPTER_LOGIN_POLL_INTERVAL_MS,
  });

  useEffect(() => {
    const url = promptQuery.data?.authorizationUrl ?? null;
    if (url) setAuthorizationUrl(url);
    // The advisory rides the same guarded prompt read as the URL. Latch it, so a
    // later poll does not clear the disclaimer.
    if (promptQuery.data?.transportAdvisory) setTransportInsecure(true);
  }, [promptQuery.data]);

  const submitCode = useMutation({
    mutationFn: (code: string) =>
      agentsApi.submitClaudeSetupTokenBrowserCode(companyId, sessionId!, code),
    onError: (error) => {
      setStartError(error instanceof Error ? error.message : "Could not submit the browser code.");
    },
  });

  const completeLogin = useMutation({
    mutationFn: () => agentsApi.completeClaudeSetupTokenLogin(companyId, sessionId!),
    onSuccess: (result) => {
      // The server reached the `stored` state. Hold the non-secret claim and
      // report it to the parent. The response carries no token.
      setStoredSessionId(result.storedSessionId);
      onStored?.(result.storedSessionId);
    },
    onError: () => {
      setCompletionFailed(true);
    },
  });

  const status = statusQuery.data?.status ?? startLogin.data?.status ?? null;
  // The server deadline for the active session (ISO string). The status route
  // and the start response both carry it. The panel drives the client cutoff
  // from this value, so the client and the server share one deadline.
  const expiresAt = statusQuery.data?.expiresAt ?? startLogin.data?.expiresAt ?? null;

  // Complete the login once the server authenticates the session. The completion
  // read returns the non-secret stored-session claim. Fire it once per session.
  const completeLoginRef = useRef(completeLogin.mutate);
  completeLoginRef.current = completeLogin.mutate;
  useEffect(() => {
    if (status === "authenticated" && !completionStartedRef.current) {
      completionStartedRef.current = true;
      completeLoginRef.current();
    }
  }, [status]);

  const isStored = storedSessionId !== null;
  const isFailure =
    completionFailed ||
    statusGone ||
    Boolean(status && CLAUDE_LOGIN_FAILURE_STATUSES.has(status));
  const isCompleting = status === "authenticated" && !isStored && !completionFailed;
  const isActive = Boolean(sessionId) && !isStored && !isFailure && !timedOut;
  const startDisabled = startLogin.isPending || isActive;

  // Hold the active session id for the unmount cleanup. The panel updates it on
  // every render. When the panel unmounts, or the parent removes it as the login
  // closes, with an active, non-terminal session, the cleanup releases that
  // session on the server. The ref is null once the session leaves the active
  // state, so the cleanup never cancels a session the server already removed.
  const activeSessionRef = useRef<string | null>(null);
  activeSessionRef.current = isActive ? sessionId : null;

  useEffect(() => {
    return () => {
      const id = activeSessionRef.current;
      if (id) releaseServerSession(id);
    };
  }, [releaseServerSession]);

  // Cap the active login at the server deadline. The timer arms when the login
  // becomes active and clears when the login leaves the active state (a terminal
  // status, a stored success, or a new login). It re-arms when `expiresAt`
  // arrives or changes. When it fires, the panel enters the timed-out state. The
  // `isActive` guard already excludes `timedOut`, so the timer does not re-arm
  // after it fires.
  //
  // The delay comes from the server `expiresAt`, so the client cutoff matches
  // the server session budget instead of a fixed short window. While `expiresAt`
  // has not arrived for the live session, the panel uses a generous failsafe, so
  // a stuck poll still stops.
  useEffect(() => {
    if (!isActive) return;
    const deadlineMs = expiresAt !== null ? new Date(expiresAt).getTime() : Number.NaN;
    const remainingMs = Number.isFinite(deadlineMs)
      ? Math.max(0, deadlineMs - Date.now())
      : CLAUDE_LOGIN_FAILSAFE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      // Release the server session first, then show the timed-out state. The
      // cancel frees the server reservation now, so an immediate retry by the
      // same owner starts a new session instead of a lockout on the per-owner
      // cap. The panel keeps the timed-out state, so the user sees why the login
      // stopped.
      if (sessionId) releaseServerSession(sessionId);
      setTimedOut(true);
    }, remainingMs);
    return () => clearTimeout(timer);
  }, [isActive, expiresAt, sessionId, releaseServerSession]);

  const trimmedCode = browserCode.trim();
  const canSubmit =
    isActive &&
    Boolean(authorizationUrl) &&
    !isCompleting &&
    isValidBrowserCode(trimmedCode) &&
    !submitCode.isPending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    submitCode.mutate(trimmedCode);
    // Clear the browser code right after submit, so the secret never lingers in
    // the input.
    setBrowserCode("");
  };

  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">Sign in to the environment</span>
        <div className="flex items-center gap-1.5">
          {isActive && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
              disabled={cancelLogin.isPending}
              onClick={() => cancelLogin.mutate()}
            >
              Cancel
            </Button>
          )}
          {/* Apply the existing stored login with no new login round trip. The
              affordance shows only when the status route reports a stored value
              and no active or completed login runs in this panel. */}
          {onApplyStored && storedToken && !isActive && !isStored && !appliedStored && (
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => {
                onApplyStored();
                setAppliedStored(true);
              }}
            >
              Use saved login
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={startDisabled}
            onClick={() => startLogin.mutate()}
          >
            {storedToken && !isActive && !isStored ? "Log in to replace" : "Log in"}
          </Button>
        </div>
      </div>

      {/* When the owner already has a stored Claude login, the panel applies it
          first and does not force a fresh login. Use saved login binds the stored
          token; a replacement login rotates it under the captured version. */}
      {storedToken && !isActive && !isStored && !appliedStored && (
        <div className="text-(length:--text-micro) text-muted-foreground">
          You have a saved Claude login. Use it to bind this agent, or log in again to replace the
          stored token.
        </div>
      )}

      {appliedStored && (
        <div className="flex items-center gap-2 text-(length:--text-micro) text-foreground">
          <Check className="size-3 shrink-0" />
          <span>The saved Claude login is bound to this agent now.</span>
        </div>
      )}

      {startError && (
        <div role="alert" className="text-(length:--text-micro) text-destructive">
          {startError}
        </div>
      )}

      {/* One live region announces the loading, prompt, completing, and terminal
          states, so a screen reader reports each transition. */}
      <div role="status" aria-live="polite" className="space-y-2 empty:hidden">
        {isActive && !authorizationUrl && !isCompleting && (
          <div className="flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
            <Loader2 className="size-3 animate-spin shrink-0" />
            <span>Preparing the login…</span>
          </div>
        )}

        {isActive && authorizationUrl && !isCompleting && (
          <div className="space-y-2">
            {transportInsecure && (
              <div
                className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-(length:--text-micro) text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
              >
                <TriangleAlert className="size-3 shrink-0 mt-0.5" />
                <span>
                  This connection is not encrypted. The login code travels in clear text on this
                  network. Continue only on a network you trust.
                </span>
              </div>
            )}
            <div className="text-(length:--text-micro) text-muted-foreground">
              Open the authorization page, then enter the browser code it shows.
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
                  Authorization URL
                </div>
                <span className="font-mono text-xs text-foreground break-all">{authorizationUrl}</span>
              </div>
              <div className="flex items-center">
                <AdapterLoginCopyButton value={authorizationUrl} label="Copy URL" />
                <Button
                  asChild
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Open the authorization page"
                  title="Open the authorization page"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <a href={authorizationUrl} target="_blank" rel="noreferrer noopener">
                    <ExternalLink className="size-3" />
                  </a>
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
                Browser code
              </div>
              <div className="flex items-center gap-2">
                <input
                  aria-label="Browser code"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={browserCode}
                  onChange={(event) => setBrowserCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleSubmit();
                    }
                  }}
                  className="flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={!canSubmit}
                  onClick={handleSubmit}
                >
                  Submit
                </Button>
              </div>
            </div>
          </div>
        )}

        {isCompleting && (
          <div className="flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
            <Loader2 className="size-3 animate-spin shrink-0" />
            <span>Completing the login…</span>
          </div>
        )}

        {isStored && (
          <div className="flex items-center gap-2 text-(length:--text-micro) text-foreground">
            <Check className="size-3 shrink-0" />
            <span>Authenticated. The environment has credentials now.</span>
          </div>
        )}

        {isFailure && (
          <div className="flex items-start gap-2 text-(length:--text-micro) text-destructive">
            <TriangleAlert className="size-3 shrink-0" />
            <span>{CLAUDE_LOGIN_FAILED_MESSAGE}</span>
          </div>
        )}

        {timedOut && !isFailure && !isStored && (
          <div className="flex items-start gap-2 text-(length:--text-micro) text-destructive">
            <TriangleAlert className="size-3 shrink-0" />
            <span>{CLAUDE_LOGIN_TIMED_OUT_MESSAGE}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function AdapterEnvironmentResult({ result }: { result: AdapterEnvironmentTestResult }) {
  const statusLabel =
    result.status === "pass" ? "Passed" : result.status === "warn" ? "Warnings" : "Failed";
  const statusClass =
    result.status === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : result.status === "warn"
        ? "text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10"
        : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{statusLabel}</span>
        <span className="text-(length:--text-micro) opacity-80">
          {new Date(result.testedAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        {result.checks.map((check, idx) => (
          <div key={`${check.code}-${idx}`} className="text-(length:--text-micro) leading-relaxed break-words">
            <span className="font-medium uppercase tracking-wide opacity-80">
              {check.level}
            </span>
            <span className="mx-1 opacity-60">·</span>
            <span>{check.message}</span>
            {check.detail && <span className="block opacity-75 break-all">({check.detail})</span>}
            {check.hint && <span className="block opacity-90 break-words">Hint: {check.hint}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- Internal sub-components ---- */

export function AdapterTypeDropdown({
  value,
  onChange,
  disabledTypes,
}: {
  value: string;
  onChange: (type: string) => void;
  disabledTypes: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  const selectedDisplay = getAdapterDisplay(value);
  const adapterList = useMemo(
    () =>
      listAdapterOptions((type) => adapterLabels[type] ?? getAdapterLabel(type)).filter(
        (item) => !disabledTypes.has(item.value),
      ),
    [disabledTypes],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {value === "opencode_local" ? <OpenCodeLogoIcon className="h-3.5 w-3.5" /> : null}
            <span className="truncate">{adapterLabels[value] ?? getAdapterLabel(value)}</span>
            {selectedDisplay.experimental && <ExperimentalBadge />}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-1" align="start">
        {adapterList.map((item) => (
          <button
            key={item.value}
            disabled={item.comingSoon}
            className={cn(
              "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded",
              item.comingSoon
                ? "opacity-40 cursor-not-allowed"
                : "hover:bg-accent/50",
              item.value === value && !item.comingSoon && "bg-accent",
            )}
            onClick={() => {
              if (!item.comingSoon) {
                onChange(item.value);
                setOpen(false);
              }
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              {item.value === "opencode_local" ? <OpenCodeLogoIcon className="h-3.5 w-3.5" /> : null}
              <span>{item.label}</span>
              {item.experimental && <ExperimentalBadge />}
            </span>
            {item.comingSoon && (
              <span className="text-(length:--text-nano) text-muted-foreground">Coming soon</span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ExperimentalBadge() {
  return (
    <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-(length:--text-nano) font-medium leading-none text-amber-700 dark:text-amber-200">
      Experimental
    </span>
  );
}

export function ModelDropdown({
  models,
  value,
  onChange,
  open,
  onOpenChange,
  allowDefault,
  required,
  groupByProvider,
  creatable,
  detectedModel,
  detectedModelCandidates,
  onDetectModel,
  onRefreshModels,
  refreshingModels,
  detectModelLabel,
  emptyDetectHint,
  defaultLabel,
}: {
  models: AdapterModel[];
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allowDefault: boolean;
  required: boolean;
  groupByProvider: boolean;
  creatable?: boolean;
  detectedModel?: string | null;
  detectedModelCandidates?: string[];
  onDetectModel?: () => Promise<string | null>;
  onRefreshModels?: () => Promise<void>;
  refreshingModels?: boolean;
  detectModelLabel?: string;
  emptyDetectHint?: string;
  defaultLabel?: string;
}) {
  const [modelSearch, setModelSearch] = useState("");
  const [detectingModel, setDetectingModel] = useState(false);
  const selected = models.find((m) => m.id === value);
  const manualModel = modelSearch.trim();
  const canCreateManualModel = Boolean(
    creatable &&
      manualModel &&
      !models.some((m) => m.id.toLowerCase() === manualModel.toLowerCase()),
  );
  // Model IDs already shown as detected/candidate badges — exclude from regular list
  const promotedModelIds = useMemo(() => {
    const set = new Set<string>();
    if (detectedModel) set.add(detectedModel);
    for (const c of detectedModelCandidates ?? []) {
      if (c) set.add(c);
    }
    return set;
  }, [detectedModel, detectedModelCandidates]);

  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      if (promotedModelIds.has(m.id)) return false;
      if (!modelSearch.trim()) return true;
      const q = modelSearch.toLowerCase();
      const provider = extractProviderId(m.id) ?? "";
      return (
        m.id.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q) ||
        provider.toLowerCase().includes(q)
      );
    });
  }, [models, modelSearch, promotedModelIds]);
  const groupedModels = useMemo(() => {
    if (!groupByProvider) {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id)),
        },
      ];
    }
    const map = new Map<string, AdapterModel[]>();
    for (const model of filteredModels) {
      const provider = extractProviderId(model.id) ?? "other";
      const group = map.get(provider) ?? [];
      group.push(model);
      map.set(provider, group);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)),
      }));
  }, [filteredModels, groupByProvider]);

  async function handleDetectModel() {
    if (!onDetectModel) return;
    setDetectingModel(true);
    try {
      const nextModel = await onDetectModel();
      if (nextModel) {
        onChange(nextModel);
        onOpenChange(false);
        setModelSearch("");
      }
    } finally {
      setDetectingModel(false);
    }
  }

  return (
    <Field label="Model" hint={help.model}>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          onOpenChange(nextOpen);
          if (!nextOpen) setModelSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
            <span className={cn(!value && "text-muted-foreground")}>
              {selected
                ? selected.label
                : value
                  || (allowDefault ? (defaultLabel ?? "Default") : required ? "Select model (required)" : "Select model")}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-1" align="start">
          <div className="relative mb-1">
            <input
              className="w-full px-2 py-1.5 pr-6 text-xs bg-transparent outline-none border-b border-border placeholder:text-muted-foreground/50"
              placeholder={creatable ? "Search models... (type to create)" : "Search models..."}
              value={modelSearch}
              onChange={(e) => setModelSearch(e.target.value)}
              autoFocus
            />
            {modelSearch && (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setModelSearch("")}
              >
                <svg aria-hidden="true" focusable="false" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
          {onDetectModel && !modelSearch.trim() && (
            <button
              type="button"
              className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground"
              onClick={() => {
                void handleDetectModel();
              }}
              disabled={detectingModel}
            >
              <svg aria-hidden="true" focusable="false" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              {detectingModel ? "Detecting..." : detectedModel ? (detectModelLabel?.replace(/^Detect\b/, "Re-detect") ?? "Re-detect from config") : (detectModelLabel ?? "Detect from config")}
            </button>
          )}
          {onRefreshModels && !modelSearch.trim() && (
            <button
              type="button"
              className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground"
              onClick={() => {
                void onRefreshModels();
              }}
              disabled={refreshingModels}
            >
              <svg aria-hidden="true" focusable="false" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 0 1 15.28-6.36L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-15.28 6.36L3 16" />
                <path d="M8 16H3v5" />
              </svg>
              {refreshingModels ? "Refreshing..." : "Refresh models"}
            </button>
          )}
          {value && (!models.some((m) => m.id === value) || promotedModelIds.has(value)) && (
            <button
              type="button"
              className={cn(
                "flex items-center w-full px-2 py-1.5 text-sm rounded bg-accent/50",
              )}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              <span className="block w-full text-left truncate font-mono text-xs" title={value}>
                {models.find((m) => m.id === value)?.label ?? value}
              </span>
              <Badge variant="outline" className="ml-auto text-(length:--text-nano) px-1.5 bg-green-500/15 text-green-400 border-green-500/20">
                current
              </Badge>
            </button>
          )}
          {detectedModel && detectedModel !== value && (
            <button
              type="button"
              className={cn(
                "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
              )}
              onClick={() => {
                onChange(detectedModel);
                onOpenChange(false);
              }}
            >
              <span className="block w-full text-left truncate font-mono text-xs" title={detectedModel}>
                {models.find((m) => m.id === detectedModel)?.label ?? detectedModel}
              </span>
              <Badge variant="outline" className="ml-auto text-(length:--text-nano) px-1.5 bg-blue-500/15 text-blue-400 border-blue-500/20">
                detected
              </Badge>
            </button>
          )}
          {detectedModelCandidates
            ?.filter((candidate) => candidate && candidate !== detectedModel && candidate !== value)
            .map((candidate) => {
              const entry = models.find((m) => m.id === candidate);
              return (
                <button
                  key={`detected-${candidate}`}
                  type="button"
                  className={cn(
                    "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                  )}
                  onClick={() => {
                    onChange(candidate);
                    onOpenChange(false);
                  }}
                >
                  <span className="block w-full text-left truncate font-mono text-xs" title={candidate}>
                    {entry?.label ?? candidate}
                  </span>
                  <Badge variant="outline" className="ml-auto text-(length:--text-nano) px-1.5 bg-sky-500/15 text-sky-400 border-sky-500/20">
                    config
                  </Badge>
                </button>
              );
            })}
          <div className="max-h-(--sz-240px) overflow-y-auto">
            {allowDefault && (
              <button
                type="button"
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                  !value && "bg-accent",
                )}
                onClick={() => {
                  onChange("");
                  onOpenChange(false);
                }}
              >
                Default
              </button>
            )}
            {canCreateManualModel && (
              <button
                type="button"
                className="flex items-center justify-between gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50"
                onClick={() => {
                  onChange(manualModel);
                  onOpenChange(false);
                  setModelSearch("");
                }}
              >
                <span>Use manual model</span>
                <span className="text-xs font-mono text-muted-foreground">{manualModel}</span>
              </button>
            )}
            {groupedModels.map((group) => (
              <div key={group.provider} className="mb-1 last:mb-0">
                {groupByProvider && (
                  <div className="px-2 py-1 text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
                    {group.provider} ({group.entries.length})
                  </div>
                )}
                {group.entries.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className={cn(
                      "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                      m.id === value && "bg-accent",
                    )}
                    onClick={() => {
                      onChange(m.id);
                      onOpenChange(false);
                    }}
                  >
                    <span className="block w-full text-left truncate" title={m.id}>
                      {groupByProvider ? extractModelName(m.id) : m.label}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {filteredModels.length === 0 && !canCreateManualModel && promotedModelIds.size === 0 && (
              <div className="px-2 py-2 space-y-2">
                <p className="text-xs text-muted-foreground">
                  {onDetectModel
                    ? (emptyDetectHint ?? "No model detected yet. Enter a provider/model manually.")
                    : "No models found."}
                </p>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

function CheapModelSection({
  enabled,
  model,
  models,
  adapterType,
  adapterDefaultModel,
  onEnabledChange,
  onModelChange,
  open,
  onOpenChange,
}: {
  enabled: boolean;
  model: string;
  models: AdapterModel[];
  adapterType: string;
  adapterDefaultModel: string;
  onEnabledChange: (next: boolean) => void;
  onModelChange: (next: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const placeholderHint = adapterDefaultModel
    ? `Adapter default · ${adapterDefaultModel}`
    : "No adapter default — choose a cheaper model";
  return (
    <div className="rounded-md border border-border/70 bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">Cheap model</div>
          <p className="text-xs text-muted-foreground">
            Used when a run requests the cheap profile (e.g. routine summaries). The primary model stays unchanged.
          </p>
        </div>
        <ToggleSwitch checked={enabled} onCheckedChange={onEnabledChange} />
      </div>
      {enabled ? (
        <ModelDropdown
          models={models}
          value={model}
          onChange={onModelChange}
          open={open}
          onOpenChange={onOpenChange}
          allowDefault
          required={false}
          groupByProvider={adapterType === "opencode_local"}
          creatable
          detectedModel={null}
          detectedModelCandidates={[]}
          emptyDetectHint={placeholderHint}
          defaultLabel={placeholderHint}
        />
      ) : null}
      {enabled && !model && adapterDefaultModel ? (
        <p className="text-(length:--text-micro) text-muted-foreground">
          No explicit cheap model selected — runtime falls back to <code>{adapterDefaultModel}</code>.
        </p>
      ) : null}
      {enabled && !model && !adapterDefaultModel ? (
        <p className="text-(length:--text-micro) text-amber-500">
          No cheap model selected and the adapter has no default. Cheap-lane runs will continue on the primary model with a fallback note.
        </p>
      ) : null}
    </div>
  );
}

function ThinkingEffortDropdown({
  value,
  options,
  onChange,
  open,
  onOpenChange,
}: {
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const selected = options.find((option) => option.id === value) ?? options[0];

  return (
    <Field label="Thinking effort" hint={help.thinkingEffort}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
            <span className={cn(!value && "text-muted-foreground")}>{selected?.label ?? "Auto"}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-1" align="start">
          {options.map((option) => (
            <button
              key={option.id || "auto"}
              className={cn(
                "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                option.id === value && "bg-accent",
              )}
              onClick={() => {
                onChange(option.id);
                onOpenChange(false);
              }}
            >
              <span>{option.label}</span>
              {option.id ? <span className="text-xs text-muted-foreground font-mono">{option.id}</span> : null}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </Field>
  );
}
