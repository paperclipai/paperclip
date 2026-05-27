import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  AdapterEnvironmentTestResult,
  CompanySecret,
  EnvBinding,
  Environment,
} from "@paperclipai/shared";
import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS, supportedEnvironmentDriversForAdapter } from "@paperclipai/shared";
import type { AdapterModel } from "../api/agents";
import { agentsApi } from "../api/agents";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import { secretsApi } from "../api/secrets";
import { assetsApi } from "../api/assets";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL } from "@paperclipai/adapter-opencode-local";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { FolderOpen, Heart, ChevronDown, X } from "lucide-react";
import { asBoolean, asFiniteNumber, asObject, cn } from "../lib/utils";
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
import { EnvVarEditor } from "./EnvVarEditor";
import { shouldShowLegacyWorkingDirectoryField } from "../lib/legacy-agent-config";
import { listAdapterOptions, listVisibleAdapterTypes } from "../adapters/metadata";
import { getAdapterLabel, getLocalizedAdapterDisplay } from "../adapters/adapter-display-registry";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { buildAgentUpdatePatch, type AgentConfigOverlay } from "../lib/agent-config-patch";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import { filterAcpxModelsByAgent } from "../lib/acpx-model-filter";
import { useLocalizedCopy } from "../i18n/ui-copy";

/* ---- Create mode values ---- */

// Canonical type lives in @paperclipai/adapter-utils; re-exported here
// so existing imports from this file keep working.
export type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

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
  }) => void;
  hideInlineSave?: boolean;
  showAdapterTypeField?: boolean;
  showAdapterTestEnvironmentButton?: boolean;
  showCreateRunPolicySection?: boolean;
  hideInstructionsFile?: boolean;
  /** Hide the prompt template field from the Identity section (used when it's shown in a separate Prompts tab). */
  hidePromptTemplate?: boolean;
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
      onSave: (patch: Record<string, unknown>) => void;
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
  const copy = useLocalizedCopy();
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

  // Sync disabled adapter types from server so dropdown filters them out
  const disabledTypes = useDisabledAdaptersSync();

  const { data: availableSecrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const environmentsEnabled = experimentalSettings?.enableEnvironments === true;

  const { data: environments = [] } = useQuery<Environment[]>({
    queryKey: selectedCompanyId ? queryKeys.environments.list(selectedCompanyId) : ["environments", "none"],
    queryFn: () => environmentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && environmentsEnabled,
  });
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

  /** Build accumulated patch and send to parent */
  const handleCancel = useCallback(() => {
    setOverlay({ ...emptyOverlay });
  }, []);

  const handleSave = useCallback(() => {
    if (isCreate || !isDirty) return;
    props.onSave(buildAgentUpdatePatch(props.agent, overlay));
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
  const currentDefaultEnvironmentId = isCreate
    ? val!.defaultEnvironmentId ?? ""
    : eff("identity", "defaultEnvironmentId", props.agent.defaultEnvironmentId ?? "");
  const currentDefaultEnvironment = useMemo(
    () => environments.find((environment) => environment.id === currentDefaultEnvironmentId) ?? null,
    [currentDefaultEnvironmentId, environments],
  );
  const runnableEnvironments = useMemo(
    () => environments.filter((environment) => {
      if (!supportedEnvironmentDrivers.has(environment.driver)) return false;
      if (environment.driver !== "sandbox") return true;
      const provider = typeof environment.config?.provider === "string" ? environment.config.provider : null;
      return provider !== null && provider !== "fake";
    }),
    [environments, supportedEnvironmentDrivers],
  );

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
  const rawModels = fetchedModels ?? externalModels ?? [];
  const adapterCommandField =
    adapterType === "hermes_local" ? "hermesCommand" : "command";
  const acpxAgent =
    adapterType === "acpx_local"
      ? isCreate
        ? String(val!.adapterSchemaValues?.agent ?? "claude")
        : eff("adapterConfig", "agent", String(config.agent ?? "claude"))
      : "";
  const models = useMemo(
    () => adapterType === "acpx_local"
      ? filterAcpxModelsByAgent(rawModels, acpxAgent)
      : rawModels,
    [adapterType, rawModels, acpxAgent],
  );
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

  function buildAdapterConfigForTest(): Record<string, unknown> {
    if (isCreate) {
      return uiAdapter.buildAdapterConfig(val!);
    }
    const base = config as Record<string, unknown>;
    const next = { ...base, ...overlay.adapterConfig };
    if (adapterType === "hermes_local") {
      const hermesCommand =
        typeof next.hermesCommand === "string" && next.hermesCommand.length > 0
          ? next.hermesCommand
          : typeof next.command === "string" && next.command.length > 0
            ? next.command
            : undefined;
      if (hermesCommand) {
        next.hermesCommand = hermesCommand;
      }
    }
    return next;
  }

  const testEnvironment = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) {
        throw new Error("Select a company to test adapter environment");
      }
      return agentsApi.testEnvironment(selectedCompanyId, adapterType, {
        adapterConfig: buildAdapterConfigForTest(),
        environmentId: currentDefaultEnvironmentId || null,
      });
    },
  });
  const testEnvironmentDisabled = testEnvironment.isPending || !selectedCompanyId;
  const triggerTestEnvironment = useCallback(() => {
    if (testEnvironmentDisabled) return;
    testEnvironment.mutate();
  }, [testEnvironment.mutate, testEnvironmentDisabled]);

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
      pending: testEnvironment.isPending,
    });
    return () => {
      props.onTestActionStateChange?.({ disabled: true, pending: false });
    };
  }, [
    showAdapterTestEnvironmentButton,
    props.onTestActionStateChange,
    testEnvironmentDisabled,
    testEnvironment.isPending,
  ]);

  useEffect(() => {
    if (!props.onTestFeedbackChange) return;
    props.onTestFeedbackChange({
      errorMessage: testEnvironment.error instanceof Error
        ? testEnvironment.error.message
        : testEnvironment.error
          ? "Environment test failed"
          : null,
      result: testEnvironment.data ?? null,
    });
    return () => {
      props.onTestFeedbackChange?.({ errorMessage: null, result: null });
    };
  }, [props.onTestFeedbackChange, testEnvironment.data, testEnvironment.error]);

  // Current model for display
  const currentModelId = isCreate
    ? val!.model
    : eff("adapterConfig", "model", String(config.model ?? ""));

  async function handleRefreshModels() {
    if (!selectedCompanyId) return;
    setRefreshingModels(true);
    setRefreshModelsError(null);
    try {
      const refreshed = await agentsApi.adapterModels(selectedCompanyId, adapterType, { refresh: true });
      queryClient.setQueryData(modelQueryKey, refreshed);
    } catch (error) {
      setRefreshModelsError(error instanceof Error ? error.message : copy("agentConfig.models.refreshFailed", "Failed to refresh adapter models.", "어댑터 모델 목록을 새로고침하지 못했습니다."));
    } finally {
      setRefreshingModels(false);
    }
  }

  const thinkingEffortKey =
    adapterType === "codex_local"
      ? "modelReasoningEffort"
      : adapterType === "acpx_local" && acpxAgent === "codex"
        ? "modelReasoningEffort"
        : adapterType === "cursor"
          ? "mode"
          : adapterType === "opencode_local"
            ? "variant"
            : "effort";
  const thinkingEffortOptions =
    adapterType === "codex_local"
      ? codexThinkingEffortOptions
      : adapterType === "acpx_local" && acpxAgent === "codex"
        ? codexThinkingEffortOptions
        : adapterType === "cursor"
          ? cursorModeOptions
          : adapterType === "opencode_local"
            ? openCodeThinkingEffortOptions
            : claudeThinkingEffortOptions;
  const currentThinkingEffort = isCreate
    ? val!.thinkingEffort
    : adapterType === "codex_local"
      ? eff(
          "adapterConfig",
          "modelReasoningEffort",
          String(config.modelReasoningEffort ?? config.reasoningEffort ?? ""),
        )
      : adapterType === "acpx_local" && acpxAgent === "codex"
        ? eff(
            "adapterConfig",
            "modelReasoningEffort",
            String(config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort ?? ""),
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
    const cheapAdapterConfig = (cheap.adapterConfig ?? {}) as Record<string, unknown>;
    return {
      enabled: cheap.enabled !== false,
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

  return (
    <div className={cn("relative", cards && "space-y-6")}>
      {/* ---- Floating Save button (edit mode, when dirty) ---- */}
      {isDirty && !props.hideInlineSave && (
        <div className="sticky top-0 z-10 flex items-center justify-end px-4 py-2 bg-background/90 backdrop-blur-sm border-b border-primary/20">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">{copy("agentConfig.unsavedChanges", "Unsaved changes", "저장하지 않은 변경")}</span>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!isCreate && props.isSaving}
            >
              {!isCreate && props.isSaving ? copy("common.savingDots", "Saving...", "저장 중...") : copy("common.save", "Save", "저장")}
            </Button>
          </div>
        </div>
      )}

      {/* ---- Identity (edit only) ---- */}
      {!isCreate && (
        <div className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">{copy("agentConfig.identity", "Identity", "기본 정보")}</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">{copy("agentConfig.identity", "Identity", "기본 정보")}</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <Field label={copy("agentConfig.name", "Name", "이름")} hint={help.name}>
              <DraftInput
                value={eff("identity", "name", props.agent.name)}
                onCommit={(v) => mark("identity", "name", v)}
                immediate
                className={inputClass}
                placeholder={copy("agentConfig.namePlaceholder", "Agent name", "직원 이름")}
              />
            </Field>
            <Field label={copy("agentConfig.title", "Title", "직책")} hint={help.title}>
              <DraftInput
                value={eff("identity", "title", props.agent.title ?? "")}
                onCommit={(v) => mark("identity", "title", v || null)}
                immediate
                className={inputClass}
                placeholder={copy("agentConfig.titlePlaceholder", "e.g. VP of Engineering", "예: 개발 총괄")}
              />
            </Field>
            <Field label={copy("agentConfig.reportsTo", "Reports to", "보고 대상")} hint={help.reportsTo}>
              <ReportsToPicker
                agents={companyAgents}
                value={eff("identity", "reportsTo", props.agent.reportsTo ?? null)}
                onChange={(id) => mark("identity", "reportsTo", id)}
                excludeAgentIds={[props.agent.id]}
                chooseLabel={copy("agentConfig.chooseManager", "Choose manager…", "상위 관리자 선택…")}
              />
            </Field>
            <Field label={copy("agentConfig.capabilities", "Capabilities", "역할/능력")} hint={help.capabilities}>
              <MarkdownEditor
                value={eff("identity", "capabilities", props.agent.capabilities ?? "") ?? ""}
                onChange={(v) => mark("identity", "capabilities", v || null)}
                placeholder={copy("agentConfig.capabilitiesPlaceholder", "Describe what this agent can do...", "이 직원이 할 수 있는 일을 설명하세요...")}
                contentClassName="min-h-[44px] text-sm font-mono"
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
                <Field label={copy("agentConfig.promptTemplate", "Prompt Template", "프롬프트 템플릿")} hint={help.promptTemplate}>
                  <MarkdownEditor
                    value={eff(
                      "adapterConfig",
                      "promptTemplate",
                      String(config.promptTemplate ?? ""),
                    )}
                    onChange={(v) => mark("adapterConfig", "promptTemplate", v ?? "")}
                    placeholder={copy("agentConfig.promptTemplatePlaceholder", "You are agent {{ agent.name }}. Your role is {{ agent.role }}...", "당신은 {{ agent.name }}입니다. 역할은 {{ agent.role }}입니다...")}
                    contentClassName="min-h-[88px] text-sm font-mono"
                    imageUploadHandler={async (file) => {
                      const namespace = `agents/${props.agent.id}/prompt-template`;
                      const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                      return asset.contentPath;
                    }}
                  />
                </Field>
                <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                  {copy("agentConfig.promptTemplateWarning", "Prompt template is replayed on every heartbeat. Keep it compact and dynamic to avoid recurring token cost and cache churn.", "프롬프트 템플릿은 매 상태 점검마다 반복됩니다. 반복 토큰 비용과 캐시 낭비를 줄이려면 짧고 동적으로 유지하세요.")}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- Execution ---- */}
      {environmentsEnabled ? (
        <div className={cn(!cards && (isCreate ? "border-t border-border" : "border-b border-border"))}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">{copy("agentConfig.execution", "Execution", "실행")}</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">{copy("agentConfig.execution", "Execution", "실행")}</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <Field
              label={copy("agentConfig.defaultEnvironment", "Default environment", "기본 실행 환경")}
              hint={copy("agentConfig.defaultEnvironmentHint", "Agent-level default execution target. Project and issue settings can still override this.", "직원 기본 실행 대상입니다. 프로젝트와 작업 설정이 이를 덮어쓸 수 있습니다.")}
            >
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
                <option value="">{copy("agentConfig.companyDefaultLocal", "Company default (Local)", "회사 기본값(Local)")}</option>
                {runnableEnvironments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name} · {environment.driver}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      ) : null}

      {/* ---- Adapter ---- */}
      <div className={cn(!cards && (isCreate ? "border-t border-border" : "border-b border-border"))}>
        <div className={cn(cards ? "flex items-center justify-between mb-3" : "px-4 py-2 flex items-center justify-between gap-2")}>
          {cards
            ? <h3 className="text-sm font-medium">{copy("agentConfig.adapter", "Adapter", "어댑터")}</h3>
            : <span className="text-xs font-medium text-muted-foreground">{copy("agentConfig.adapter", "Adapter", "어댑터")}</span>
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
              {testEnvironment.isPending ? copy("agentConfig.testing", "Testing...", "테스트 중...") : copy("agentConfig.test", "Test", "테스트")}
            </Button>
          )}
        </div>
        <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
          {showAdapterTypeField && (
            <Field label={copy("agentConfig.adapterType", "Adapter type", "어댑터 유형")} hint={help.adapterType}>
              <AdapterTypeDropdown
                value={adapterType}
                disabledTypes={disabledTypes}
                onChange={(t) => {
                  if (isCreate) {
                    // Reset all adapter-specific fields to defaults when switching adapter type
                    const { adapterType: _at, ...defaults } = defaultCreateValues;
                    const nextValues: CreateConfigValues = { ...defaults, adapterType: t };
                    if (t === "codex_local") {
                      nextValues.model = DEFAULT_CODEX_LOCAL_MODEL;
                      nextValues.dangerouslyBypassSandbox =
                        DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
                    } else if (t === "gemini_local") {
                      nextValues.model = DEFAULT_GEMINI_LOCAL_MODEL;
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
                          t === "codex_local"
                            ? DEFAULT_CODEX_LOCAL_MODEL
                            : t === "gemini_local"
                              ? DEFAULT_GEMINI_LOCAL_MODEL
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

          {showInlineAdapterTestEnvironmentFeedback && testEnvironment.error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {testEnvironment.error instanceof Error
                ? testEnvironment.error.message
                : copy("agentConfig.environmentTestFailed", "Environment test failed", "환경 테스트 실패")}
            </div>
          )}

          {showInlineAdapterTestEnvironmentFeedback && testEnvironment.data && (
            <AdapterEnvironmentResult result={testEnvironment.data} />
          )}

          {/* Working directory */}
          {showLegacyWorkingDirectoryField && (
            <Field label={copy("agentConfig.workingDirectoryDeprecated", "Working directory (deprecated)", "작업 폴더(구 방식)")} hint={help.cwd}>
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

          {/* Adapter-specific fields are rendered inside Permissions & Configuration */}
        </div>

      </div>

      {/* ---- Permissions & Configuration ---- */}
      {isLocal && (
        <div className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">{copy("agentConfig.permissionsConfiguration", "Permissions & Configuration", "권한 및 설정")}</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">{copy("agentConfig.permissionsConfiguration", "Permissions & Configuration", "권한 및 설정")}</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
              <Field label={copy("agentConfig.command", "Command", "명령")} hint={help.localCommand}>
                <DraftInput
                  value={
                    isCreate
                      ? val!.command
                      : eff(
                          "adapterConfig",
                          adapterCommandField,
                          String(
                            (adapterType === "hermes_local"
                              ? config.hermesCommand ?? config.command
                              : config.command) ?? "",
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
                      pi_local: "pi",
                      cursor: "agent",
                      opencode_local: "opencode",
                    } as Record<string, string>)[adapterType] ?? adapterType.replace(/_local$/, "")
                  }
                />
              </Field>

              {supportsModelProfiles && (
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{copy("agentConfig.primaryModel", "Primary model", "기본 모델")}</div>
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
                  adapterType === "codex_local" || adapterType === "acpx_local"
                    ? handleRefreshModels
                    : undefined
                }
                refreshingModels={refreshingModels}
                detectModelLabel={copy("agentConfig.models.detect", "Detect model", "모델 감지")}
                emptyDetectHint={copy("agentConfig.models.emptyDetectHint", "No model detected. Select or enter one manually.", "감지된 모델이 없습니다. 직접 선택하거나 입력하세요.")}
              />
              {(refreshModelsError || fetchedModelsError) && (
                <p className="text-xs text-destructive">
                  {refreshModelsError
                    ?? (fetchedModelsError instanceof Error
                      ? fetchedModelsError.message
                      : copy("agentConfig.models.loadFailed", "Failed to load adapter models.", "어댑터 모델 목록을 불러오지 못했습니다."))}
                </p>
              )}
              {adapterType === "opencode_local"
                && currentDefaultEnvironment
                && currentDefaultEnvironment.driver !== "local" && (
                <p className="text-xs text-muted-foreground">
                  {copy("agentConfig.opencodLocalOnly", "Live OpenCode model discovery only runs for Local environments. Using the curated list and manual entry for", "OpenCode 실시간 모델 감지는 Local 환경에서만 동작합니다. 현재 환경은 기본 목록과 수동 입력을 사용합니다:")} {currentDefaultEnvironment.name}.
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
                        {copy("agentConfig.codexMinimalSearchWarning", "Codex may reject `minimal` thinking when search is enabled.", "검색이 켜진 상태에서는 Codex가 `minimal` 추론을 거부할 수 있습니다.")}
                      </p>
                    )}
                </>
              )}
              {!isCreate && typeof config.bootstrapPromptTemplate === "string" && config.bootstrapPromptTemplate && (
                <>
                  <Field label={copy("agentConfig.bootstrapPromptLegacy", "Bootstrap prompt (legacy)", "부트스트랩 프롬프트(구 방식)")} hint={help.bootstrapPrompt}>
                    <MarkdownEditor
                      value={eff(
                        "adapterConfig",
                        "bootstrapPromptTemplate",
                        String(config.bootstrapPromptTemplate ?? ""),
                      )}
                      onChange={(v) =>
                        mark("adapterConfig", "bootstrapPromptTemplate", v || undefined)
                      }
                      placeholder={copy("agentConfig.bootstrapPromptPlaceholder", "Optional initial setup prompt for the first run", "첫 실행에만 사용할 초기 설정 프롬프트")}
                      contentClassName="min-h-[44px] text-sm font-mono"
                      imageUploadHandler={async (file) => {
                        const namespace = `agents/${props.agent.id}/bootstrap-prompt`;
                        const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                        return asset.contentPath;
                      }}
                    />
                  </Field>
                  <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    {copy("agentConfig.bootstrapPromptLegacyWarning", "Bootstrap prompt is legacy and will be removed in a future release. Consider moving this content into the agent's prompt template or instructions file instead.", "부트스트랩 프롬프트는 구 방식이며 향후 제거될 수 있습니다. 이 내용은 직원 프롬프트 템플릿이나 지침 파일로 옮기는 것을 권장합니다.")}
                  </div>
                </>
              )}
              {adapterType === "claude_local" && (
                <ClaudeLocalAdvancedFields {...adapterFieldProps} />
              )}
              <uiAdapter.ConfigFields {...adapterFieldProps} />

              <Field label={copy("agentConfig.extraArgs", "Extra args (comma-separated)", "추가 인자(쉼표로 구분)")} hint={help.extraArgs}>
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
                  immediate
                  className={inputClass}
                  placeholder={copy("agentConfig.extraArgsPlaceholder", "e.g. --verbose, --foo=bar", "예: --verbose, --foo=bar")}
                />
              </Field>

              <Field label={copy("agentConfig.environmentVariables", "Environment variables", "환경 변수")} hint={help.envVars}>
                <EnvVarEditor
                  value={
                    isCreate
                      ? ((val!.envBindings ?? EMPTY_ENV) as Record<string, EnvBinding>)
                      : ((eff("adapterConfig", "env", (config.env ?? EMPTY_ENV) as Record<string, EnvBinding>))
                      )
                  }
                  secrets={availableSecrets}
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
                  <Field label={copy("agentConfig.timeoutSec", "Timeout (sec)", "제한 시간(초)")} hint={help.timeoutSec}>
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
                  <Field label={copy("agentConfig.graceSec", "Interrupt grace period (sec)", "중단 대기 시간(초)")} hint={help.graceSec}>
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
        <span className="text-[11px] opacity-80">
          {new Date(result.testedAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        {result.checks.map((check, idx) => (
          <div key={`${check.code}-${idx}`} className="text-[11px] leading-relaxed break-words">
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

function AdapterTypeDropdown({
  value,
  onChange,
  disabledTypes,
}: {
  value: string;
  onChange: (type: string) => void;
  disabledTypes: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  const copy = useLocalizedCopy();
  const selectedDisplay = getLocalizedAdapterDisplay(value, copy);
  const experimentalLabel = copy("common.experimental", "Experimental", "실험");
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
            {selectedDisplay.experimental && <ExperimentalBadge label={experimentalLabel} />}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
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
              {item.experimental && <ExperimentalBadge label={experimentalLabel} />}
            </span>
            {item.comingSoon && (
              <span className="text-[10px] text-muted-foreground">{copy("common.comingSoon", "Coming soon", "예정")}</span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ExperimentalBadge({ label = "Experimental" }: { label?: string }) {
  return (
    <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-700 dark:text-amber-200">
      {label}
    </span>
  );
}

function ModelDropdown({
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
  const copy = useLocalizedCopy();
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
    <Field label={copy("agentConfig.models.model", "Model", "모델")} hint={help.model}>
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
                  || (allowDefault ? (defaultLabel ?? copy("agentConfig.models.default", "Default", "기본값")) : required ? copy("agentConfig.models.selectRequired", "Select model (required)", "모델 선택(필수)") : copy("agentConfig.models.select", "Select model", "모델 선택"))}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
          <div className="relative mb-1">
            <input
              className="w-full px-2 py-1.5 pr-6 text-xs bg-transparent outline-none border-b border-border placeholder:text-muted-foreground/50"
              placeholder={creatable
                ? copy("agentConfig.models.searchCreatable", "Search models... (type to create)", "모델 검색... 직접 입력 가능")
                : copy("agentConfig.models.search", "Search models...", "모델 검색...")}
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
              {detectingModel
                ? copy("agentConfig.models.detecting", "Detecting...", "감지 중...")
                : detectedModel
                  ? copy("agentConfig.models.redetectFromConfig", "Re-detect from config", "설정에서 다시 감지")
                  : (detectModelLabel ?? copy("agentConfig.models.detectFromConfig", "Detect from config", "설정에서 감지"))}
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
              {refreshingModels
                ? copy("agentConfig.models.refreshing", "Refreshing...", "새로고침 중...")
                : copy("agentConfig.models.refresh", "Refresh models", "모델 목록 새로고침")}
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
              <span className="shrink-0 ml-auto text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/20">
                {copy("agentConfig.models.current", "current", "현재")}
              </span>
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
              <span className="shrink-0 ml-auto text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/20">
                {copy("agentConfig.models.detected", "detected", "감지됨")}
              </span>
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
                  <span className="shrink-0 ml-auto text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-400 border border-sky-500/20">
                    {copy("agentConfig.models.config", "config", "설정")}
                  </span>
                </button>
              );
            })}
          <div className="max-h-[240px] overflow-y-auto">
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
                {copy("agentConfig.models.default", "Default", "기본값")}
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
                <span>{copy("agentConfig.models.useManual", "Use manual model", "수동 모델 사용")}</span>
                <span className="text-xs font-mono text-muted-foreground">{manualModel}</span>
              </button>
            )}
            {groupedModels.map((group) => (
              <div key={group.provider} className="mb-1 last:mb-0">
                {groupByProvider && (
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
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
                    ? (emptyDetectHint ?? copy("agentConfig.models.noDetectedYet", "No model detected yet. Enter a provider/model manually.", "아직 감지된 모델이 없습니다. provider/model을 직접 입력하세요."))
                    : copy("agentConfig.models.noModelsFound", "No models found.", "모델을 찾지 못했습니다.")}
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
  const copy = useLocalizedCopy();
  const placeholderHint = adapterDefaultModel
    ? `${copy("agentConfig.cheapModel.adapterDefault", "Adapter default", "어댑터 기본값")} · ${adapterDefaultModel}`
    : copy("agentConfig.cheapModel.noAdapterDefault", "No adapter default — choose a cheaper model", "어댑터 기본값 없음 - 저비용 모델을 선택하세요");
  return (
    <div className="rounded-md border border-border/70 bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{copy("agentConfig.cheapModel.title", "Cheap model", "저비용 모델")}</div>
          <p className="text-xs text-muted-foreground">
            {copy("agentConfig.cheapModel.description", "Used when a run requests the cheap profile (e.g. routine summaries). The primary model stays unchanged.", "저비용 프로필을 요청하는 실행에서 사용합니다. 기본 모델은 그대로 유지됩니다.")}
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
        <p className="text-[11px] text-muted-foreground">
          {copy("agentConfig.cheapModel.fallbackPrefix", "No explicit cheap model selected — runtime falls back to", "명시적인 저비용 모델이 없어 런타임이 다음 모델로 대체합니다:")} <code>{adapterDefaultModel}</code>.
        </p>
      ) : null}
      {enabled && !model && !adapterDefaultModel ? (
        <p className="text-[11px] text-amber-500">
          {copy("agentConfig.cheapModel.noFallback", "No cheap model selected and the adapter has no default. Cheap-lane runs will continue on the primary model with a fallback note.", "저비용 모델이 선택되지 않았고 어댑터 기본값도 없습니다. 저비용 실행은 안내 문구와 함께 기본 모델로 계속 실행됩니다.")}
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
  const copy = useLocalizedCopy();
  const selected = options.find((option) => option.id === value) ?? options[0];
  const labelFor = (label: string) => ({
    Auto: copy("agentConfig.thinking.auto", "Auto", "자동"),
    Minimal: copy("agentConfig.thinking.minimal", "Minimal", "최소"),
    Low: copy("agentConfig.thinking.low", "Low", "낮음"),
    Medium: copy("agentConfig.thinking.medium", "Medium", "보통"),
    High: copy("agentConfig.thinking.high", "High", "높음"),
    "X-High": copy("agentConfig.thinking.xhigh", "X-High", "매우 높음"),
    Max: copy("agentConfig.thinking.max", "Max", "최대"),
  }[label] ?? label);

  return (
    <Field label={copy("agentConfig.thinkingEffort", "Thinking effort", "추론 강도")} hint={help.thinkingEffort}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
            <span className={cn(!value && "text-muted-foreground")}>{selected ? labelFor(selected.label) : copy("agentConfig.thinking.auto", "Auto", "자동")}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
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
              <span>{labelFor(option.label)}</span>
              {option.id ? <span className="text-xs text-muted-foreground font-mono">{option.id}</span> : null}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </Field>
  );
}
