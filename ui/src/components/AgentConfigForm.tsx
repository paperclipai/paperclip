import { useState, useEffect, useRef, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import type {
  Agent,
  AdapterEnvironmentTestResult,
  CompanySecret,
  EnvBinding,
} from "@paperclipai/shared";
import type { AdapterModel } from "../api/agents";
import { agentsApi } from "../api/agents";
import { secretsApi } from "../api/secrets";
import { assetsApi } from "../api/assets";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL } from "@paperclipai/adapter-opencode-local";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { FolderOpen, Heart, ChevronDown, X } from "lucide-react";
import { cn } from "../lib/utils";
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
import { defaultCreateValues } from "./agent-config-defaults";
import { getUIAdapter } from "../adapters";
import { ClaudeLocalAdvancedFields } from "../adapters/claude-local/config-fields";
import { MarkdownEditor } from "./MarkdownEditor";
import { ChoosePathButton } from "./PathInstructionsModal";

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
  hideInlineSave?: boolean;
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

interface Overlay {
  identity: Record<string, unknown>;
  adapterType?: string;
  adapterConfig: Record<string, unknown>;
  heartbeat: Record<string, unknown>;
  runtime: Record<string, unknown>;
}

const emptyOverlay: Overlay = {
  identity: {},
  adapterConfig: {},
  heartbeat: {},
  runtime: {},
};

/** Stable empty object used as fallback for missing env config to avoid new-object-per-render. */
const EMPTY_ENV: Record<string, EnvBinding> = {};

function isOverlayDirty(o: Overlay): boolean {
  return (
    Object.keys(o.identity).length > 0 ||
    o.adapterType !== undefined ||
    Object.keys(o.adapterConfig).length > 0 ||
    Object.keys(o.heartbeat).length > 0 ||
    Object.keys(o.runtime).length > 0
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
] as const;

const opencodeVariantOptions = [
  { id: "", label: "Auto" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
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


/* ---- Form ---- */

export function AgentConfigForm(props: AgentConfigFormProps) {
  const { mode, adapterModels: externalModels } = props;
  const isCreate = mode === "create";
  const cards = props.sectionLayout === "cards";
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const { data: availableSecrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
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
  const [overlay, setOverlay] = useState<Overlay>(emptyOverlay);
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

  /** Read effective value: overlay if dirty, else original */
  function eff<T>(group: keyof Omit<Overlay, "adapterType">, field: string, original: T): T {
    const o = overlay[group];
    if (field in o) return o[field] as T;
    return original;
  }

  /** Mark field dirty in overlay */
  function mark(group: keyof Omit<Overlay, "adapterType">, field: string, value: unknown) {
    setOverlay((prev) => ({
      ...prev,
      [group]: { ...prev[group], [field]: value },
    }));
  }

  /** Build accumulated patch and send to parent */
  function handleSave() {
    if (isCreate || !isDirty) return;
    const agent = props.agent;
    const patch: Record<string, unknown> = {};

    if (Object.keys(overlay.identity).length > 0) {
      Object.assign(patch, overlay.identity);
    }
    if (overlay.adapterType !== undefined) {
      patch.adapterType = overlay.adapterType;
      // When adapter type changes, send only the new config — don't merge
      // with old config since old adapter fields are meaningless for the new type
      patch.adapterConfig = overlay.adapterConfig;
    } else if (Object.keys(overlay.adapterConfig).length > 0) {
      const existing = (agent.adapterConfig ?? {}) as Record<string, unknown>;
      patch.adapterConfig = { ...existing, ...overlay.adapterConfig };
    }
    if (Object.keys(overlay.heartbeat).length > 0) {
      const existingRc = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
      const existingHb = (existingRc.heartbeat ?? {}) as Record<string, unknown>;
      patch.runtimeConfig = { ...existingRc, heartbeat: { ...existingHb, ...overlay.heartbeat } };
    }
    if (Object.keys(overlay.runtime).length > 0) {
      Object.assign(patch, overlay.runtime);
    }

    props.onSave(patch);
  }

  useEffect(() => {
    if (!isCreate) {
      props.onDirtyChange?.(isDirty);
      props.onSaveActionChange?.(() => handleSave());
      props.onCancelActionChange?.(() => setOverlay({ ...emptyOverlay }));
      return () => {
        props.onSaveActionChange?.(null);
        props.onCancelActionChange?.(null);
        props.onDirtyChange?.(false);
      };
    }
    return;
  }, [isCreate, isDirty, props.onDirtyChange, props.onSaveActionChange, props.onCancelActionChange, overlay]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Resolve values ----
  const config = !isCreate ? ((props.agent.adapterConfig ?? {}) as Record<string, unknown>) : {};
  const runtimeConfig = !isCreate ? ((props.agent.runtimeConfig ?? {}) as Record<string, unknown>) : {};
  const heartbeat = !isCreate ? ((runtimeConfig.heartbeat ?? {}) as Record<string, unknown>) : {};

  const adapterType = isCreate
    ? props.values.adapterType
    : overlay.adapterType ?? props.agent.adapterType;
  const isLocal =
    adapterType === "claude_local" ||
    adapterType === "codex_local" ||
    adapterType === "opencode_local" ||
    adapterType === "cursor";
  const uiAdapter = useMemo(() => getUIAdapter(adapterType), [adapterType]);

  // Fetch adapter models for the effective adapter type
  const { data: fetchedModels } = useQuery({
    queryKey: ["adapter-models", adapterType],
    queryFn: () => agentsApi.adapterModels(adapterType),
  });
  const models = fetchedModels ?? externalModels ?? [];

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
  };

  // Section toggle state — advanced always starts collapsed
  const [runPolicyAdvancedOpen, setRunPolicyAdvancedOpen] = useState(false);
  // Popover states
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkingEffortOpen, setThinkingEffortOpen] = useState(false);

  // Create mode helpers
  const val = isCreate ? props.values : null;
  const set = isCreate
    ? (patch: Partial<CreateConfigValues>) => props.onChange(patch)
    : null;

  function buildAdapterConfigForTest(): Record<string, unknown> {
    if (isCreate) {
      return uiAdapter.buildAdapterConfig(val!);
    }
    const base = config as Record<string, unknown>;
    return { ...base, ...overlay.adapterConfig };
  }

  const testEnvironment = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) {
        throw new Error("Select a company to test adapter environment");
      }
      return agentsApi.testEnvironment(selectedCompanyId, adapterType, {
        adapterConfig: buildAdapterConfigForTest(),
      });
    },
  });

  // Current model for display
  const currentModelId = isCreate
    ? val!.model
    : eff("adapterConfig", "model", String(config.model ?? ""));

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
        ? opencodeVariantOptions
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
  const codexSearchEnabled = adapterType === "codex_local"
    ? (isCreate ? Boolean(val!.search) : eff("adapterConfig", "search", Boolean(config.search)))
    : false;

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
            <Field label="Capabilities" hint={help.capabilities}>
              <MarkdownEditor
                value={eff("identity", "capabilities", props.agent.capabilities ?? "")}
                onChange={(v) => mark("identity", "capabilities", v || null)}
                placeholder="Describe what this agent can do..."
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
            {isLocal && (
              <Field label="Prompt Template" hint={help.promptTemplate}>
                <MarkdownEditor
                  value={eff(
                    "adapterConfig",
                    "promptTemplate",
                    String(config.promptTemplate ?? ""),
                  )}
                  onChange={(v) => mark("adapterConfig", "promptTemplate", v || undefined)}
                  placeholder="You are agent {{ agent.name }}. Your role is {{ agent.role }}..."
                  contentClassName="min-h-[88px] text-sm font-mono"
                  imageUploadHandler={async (file) => {
                    const namespace = `agents/${props.agent.id}/prompt-template`;
                    const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                    return asset.contentPath;
                  }}
                />
              </Field>
            )}
          </div>
        </div>
      )}

      {/* ---- Adapter ---- */}
      <div className={cn(!cards && (isCreate ? "border-t border-border" : "border-b border-border"))}>
        <div className={cn(cards ? "flex items-center justify-between mb-3" : "px-4 py-2 flex items-center justify-between gap-2")}>
          {cards
            ? <h3 className="text-sm font-medium">Adapter</h3>
            : <span className="text-xs font-medium text-muted-foreground">Adapter</span>
          }
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => testEnvironment.mutate()}
            disabled={testEnvironment.isPending || !selectedCompanyId}
          >
            {testEnvironment.isPending ? "Testing..." : "Test environment"}
          </Button>
        </div>
        <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
          <Field label="Adapter type" hint={help.adapterType}>
            <AdapterTypeDropdown
              value={adapterType}
              onChange={(t) => {
                if (isCreate) {
                  // Reset all adapter-specific fields to defaults when switching adapter type
                  const { adapterType: _at, ...defaults } = defaultCreateValues;
                  const nextValues: CreateConfigValues = { ...defaults, adapterType: t };
                  if (t === "codex_local") {
                    nextValues.model = DEFAULT_CODEX_LOCAL_MODEL;
                    nextValues.dangerouslyBypassSandbox =
                      DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
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
                    adapterConfig: {
                      model:
                        t === "codex_local"
                          ? DEFAULT_CODEX_LOCAL_MODEL
                          : t === "cursor"
                            ? DEFAULT_CURSOR_LOCAL_MODEL
                          : t === "opencode_local"
                            ? DEFAULT_OPENCODE_LOCAL_MODEL
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

          {testEnvironment.error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {testEnvironment.error instanceof Error
                ? testEnvironment.error.message
                : "Environment test failed"}
            </div>
          )}

          {testEnvironment.data && (
            <AdapterEnvironmentResult result={testEnvironment.data} />
          )}

          {/* Working directory */}
          {isLocal && (
            <Field label="Working directory" hint={help.cwd}>
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

          {/* Prompt template (create mode only — edit mode shows this in Identity) */}
          {isLocal && isCreate && (
            <Field label="Prompt Template" hint={help.promptTemplate}>
              <MarkdownEditor
                value={val!.promptTemplate}
                onChange={(v) => set!({ promptTemplate: v })}
                placeholder="You are agent {{ agent.name }}. Your role is {{ agent.role }}..."
                contentClassName="min-h-[88px] text-sm font-mono"
                imageUploadHandler={async (file) => {
                  const namespace = "agents/drafts/prompt-template";
                  const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                  return asset.contentPath;
                }}
              />
            </Field>
          )}

          {/* Adapter-specific fields */}
          <uiAdapter.ConfigFields {...adapterFieldProps} />
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
                      : eff("adapterConfig", "command", String(config.command ?? ""))
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ command: v })
                      : mark("adapterConfig", "command", v || undefined)
                  }
                  immediate
                  className={inputClass}
                  placeholder={
                    adapterType === "codex_local"
                      ? "codex"
                      : adapterType === "cursor"
                        ? "agent"
                      : adapterType === "opencode_local"
                        ? "opencode"
                        : "claude"
                  }
                />
              </Field>

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
              />

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
              <Field label="Bootstrap prompt (first run)" hint={help.bootstrapPrompt}>
                <MarkdownEditor
                  value={
                    isCreate
                      ? val!.bootstrapPrompt
                      : eff(
                          "adapterConfig",
                          "bootstrapPromptTemplate",
                          String(config.bootstrapPromptTemplate ?? ""),
                        )
                  }
                  onChange={(v) =>
                    isCreate
                      ? set!({ bootstrapPrompt: v })
                      : mark("adapterConfig", "bootstrapPromptTemplate", v || undefined)
                  }
                  placeholder="Optional initial setup prompt for the first run"
                  contentClassName="min-h-[44px] text-sm font-mono"
                  imageUploadHandler={async (file) => {
                    const namespace = isCreate
                      ? "agents/drafts/bootstrap-prompt"
                      : `agents/${props.agent.id}/bootstrap-prompt`;
                    const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                    return asset.contentPath;
                  }}
                />
              </Field>
              {adapterType === "claude_local" && (
                <ClaudeLocalAdvancedFields {...adapterFieldProps} />
              )}

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
                      : mark("adapterConfig", "extraArgs", v ? parseCommaArgs(v) : undefined)
                  }
                  immediate
                  className={inputClass}
                  placeholder="e.g. --verbose, --foo=bar"
                />
              </Field>

              <Field label="Environment variables" hint={help.envVars}>
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
      {isCreate ? (
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
      ) : (
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
                checked={eff("heartbeat", "enabled", heartbeat.enabled !== false)}
                onCheckedChange={(v) => mark("heartbeat", "enabled", v)}
                number={eff("heartbeat", "intervalSec", Number(heartbeat.intervalSec ?? 300))}
                onNumberChange={(v) => mark("heartbeat", "intervalSec", v)}
                numberLabel="sec"
                numberPrefix="Run heartbeat every"
                numberHint={help.intervalSec}
                showNumber={eff("heartbeat", "enabled", heartbeat.enabled !== false)}
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
                    Number(heartbeat.maxConcurrentRuns ?? 1),
                  )}
                  onCommit={(v) => mark("heartbeat", "maxConcurrentRuns", v)}
                  immediate
                  className={inputClass}
                />
              </Field>
            </div>
          </CollapsibleSection>
          </div>
        </div>
      )}

    </div>
  );
}

function AdapterEnvironmentResult({ result }: { result: AdapterEnvironmentTestResult }) {
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

const ENABLED_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "opencode_local", "cursor"]);

/** Display list includes all real adapter types plus UI-only coming-soon entries. */
const ADAPTER_DISPLAY_LIST: { value: string; label: string; comingSoon: boolean }[] = [
  ...AGENT_ADAPTER_TYPES.map((t) => ({
    value: t,
    label: adapterLabels[t] ?? t,
    comingSoon: !ENABLED_ADAPTER_TYPES.has(t),
  })),
];

function AdapterTypeDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (type: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
          <span>{adapterLabels[value] ?? value}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
        {ADAPTER_DISPLAY_LIST.map((item) => (
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
              if (!item.comingSoon) onChange(item.value);
            }}
          >
            <span>{item.label}</span>
            {item.comingSoon && (
              <span className="text-[10px] text-muted-foreground">Coming soon</span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function EnvVarEditor({
  value,
  secrets,
  onCreateSecret,
  onChange,
}: {
  value: Record<string, EnvBinding>;
  secrets: CompanySecret[];
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  onChange: (env: Record<string, EnvBinding> | undefined) => void;
}) {
  type Row = {
    key: string;
    source: "plain" | "secret";
    plainValue: string;
    secretId: string;
  };

  function toRows(rec: Record<string, EnvBinding> | null | undefined): Row[] {
    if (!rec || typeof rec !== "object") {
      return [{ key: "", source: "plain", plainValue: "", secretId: "" }];
    }
    const entries = Object.entries(rec).map(([k, binding]) => {
      if (typeof binding === "string") {
        return {
          key: k,
          source: "plain" as const,
          plainValue: binding,
          secretId: "",
        };
      }
      if (
        typeof binding === "object" &&
        binding !== null &&
        "type" in binding &&
        (binding as { type?: unknown }).type === "secret_ref"
      ) {
        const recBinding = binding as { secretId?: unknown };
        return {
          key: k,
          source: "secret" as const,
          plainValue: "",
          secretId: typeof recBinding.secretId === "string" ? recBinding.secretId : "",
        };
      }
      if (
        typeof binding === "object" &&
        binding !== null &&
        "type" in binding &&
        (binding as { type?: unknown }).type === "plain"
      ) {
        const recBinding = binding as { value?: unknown };
        return {
          key: k,
          source: "plain" as const,
          plainValue: typeof recBinding.value === "string" ? recBinding.value : "",
          secretId: "",
        };
      }
      return {
        key: k,
        source: "plain" as const,
        plainValue: "",
        secretId: "",
      };
    });
    return [...entries, { key: "", source: "plain", plainValue: "", secretId: "" }];
  }

  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const [sealError, setSealError] = useState<string | null>(null);
  const valueRef = useRef(value);

  // Sync when value identity changes (overlay reset after save)
  useEffect(() => {
    if (value !== valueRef.current) {
      valueRef.current = value;
      setRows(toRows(value));
    }
  }, [value]);

  function emit(nextRows: Row[]) {
    const rec: Record<string, EnvBinding> = {};
    for (const row of nextRows) {
      const k = row.key.trim();
      if (!k) continue;
      if (row.source === "secret") {
        if (!row.secretId) continue;
        rec[k] = { type: "secret_ref", secretId: row.secretId, version: "latest" };
      } else {
        rec[k] = { type: "plain", value: row.plainValue };
      }
    }
    onChange(Object.keys(rec).length > 0 ? rec : undefined);
  }

  function updateRow(i: number, patch: Partial<Row>) {
    const withPatch = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    if (
      withPatch[withPatch.length - 1].key ||
      withPatch[withPatch.length - 1].plainValue ||
      withPatch[withPatch.length - 1].secretId
    ) {
      withPatch.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(withPatch);
    emit(withPatch);
  }

  function removeRow(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    if (
      next.length === 0 ||
      next[next.length - 1].key ||
      next[next.length - 1].plainValue ||
      next[next.length - 1].secretId
    ) {
      next.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(next);
    emit(next);
  }

  function defaultSecretName(key: string): string {
    return key
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
  }

  async function sealRow(i: number) {
    const row = rows[i];
    if (!row) return;
    const key = row.key.trim();
    const plain = row.plainValue;
    if (!key || plain.length === 0) return;

    const suggested = defaultSecretName(key) || "secret";
    const name = window.prompt("Secret name", suggested)?.trim();
    if (!name) return;

    try {
      setSealError(null);
      const created = await onCreateSecret(name, plain);
      updateRow(i, {
        source: "secret",
        secretId: created.id,
      });
    } catch (err) {
      setSealError(err instanceof Error ? err.message : "Failed to create secret");
    }
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => {
        const isTrailing =
          i === rows.length - 1 &&
          !row.key &&
          !row.plainValue &&
          !row.secretId;
        return (
          <div key={i} className="flex items-center gap-1.5">
            <input
              className={cn(inputClass, "flex-[2]")}
              placeholder="KEY"
              value={row.key}
              onChange={(e) => updateRow(i, { key: e.target.value })}
            />
            <select
              className={cn(inputClass, "flex-[1] bg-background")}
              value={row.source}
              onChange={(e) =>
                updateRow(i, {
                  source: e.target.value === "secret" ? "secret" : "plain",
                  ...(e.target.value === "plain" ? { secretId: "" } : {}),
                })
              }
            >
              <option value="plain">Plain</option>
              <option value="secret">Secret</option>
            </select>
            {row.source === "secret" ? (
              <>
                <select
                  className={cn(inputClass, "flex-[3] bg-background")}
                  value={row.secretId}
                  onChange={(e) => updateRow(i, { secretId: e.target.value })}
                >
                  <option value="">Select secret...</option>
                  {secrets.map((secret) => (
                    <option key={secret.id} value={secret.id}>
                      {secret.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
                  onClick={() => sealRow(i)}
                  disabled={!row.key.trim() || !row.plainValue}
                  title="Create secret from current plain value"
                >
                  New
                </button>
              </>
            ) : (
              <>
                <input
                  className={cn(inputClass, "flex-[3]")}
                  placeholder="value"
                  value={row.plainValue}
                  onChange={(e) => updateRow(i, { plainValue: e.target.value })}
                />
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
                  onClick={() => sealRow(i)}
                  disabled={!row.key.trim() || !row.plainValue}
                  title="Store value as secret and replace with reference"
                >
                  Seal
                </button>
              </>
            )}
            {!isTrailing ? (
              <button
                type="button"
                className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                onClick={() => removeRow(i)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <div className="w-[26px] shrink-0" />
            )}
          </div>
        );
      })}
      {sealError && <p className="text-[11px] text-destructive">{sealError}</p>}
      <p className="text-[11px] text-muted-foreground/60">
        PAPERCLIP_* variables are injected automatically at runtime.
      </p>
    </div>
  );
}

function ModelDropdown({
  models,
  value,
  onChange,
  open,
  onOpenChange,
}: {
  models: AdapterModel[];
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [modelSearch, setModelSearch] = useState("");
  const selected = models.find((m) => m.id === value);
  const filteredModels = models.filter((m) => {
    if (!modelSearch.trim()) return true;
    const q = modelSearch.toLowerCase();
    return m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q);
  });

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
          <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
            <span className={cn(!value && "text-muted-foreground")}>
              {selected ? selected.label : value || "Default"}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
          <input
            className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
            placeholder="Search models..."
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            autoFocus
          />
          <div className="max-h-[240px] overflow-y-auto">
            <button
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
            {filteredModels.map((m) => (
              <button
                key={m.id}
                className={cn(
                  "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                  m.id === value && "bg-accent",
                )}
                onClick={() => {
                  onChange(m.id);
                  onOpenChange(false);
                }}
              >
                <span>{m.label}</span>
                <span className="text-xs text-muted-foreground font-mono">{m.id}</span>
              </button>
            ))}
            {filteredModels.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No models found.</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </Field>
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
              <span>{option.label}</span>
              {option.id ? <span className="text-xs text-muted-foreground font-mono">{option.id}</span> : null}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </Field>
  );
}
