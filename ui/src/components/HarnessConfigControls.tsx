import { setupEfforts } from "../lib/agent-setup-fields";
import { codexReasoningEffortOptions } from "../lib/codex-reasoning-effort";
import { useMemo, useState } from "react";
import type { AdapterModel } from "../api/agents";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { NativeSelect, SelectPopover } from "./ui/select";
import { AdapterMark } from "./AdapterMark";
import { Field, help, adapterLabels } from "./agent-config-primitives";
import { listAdapterOptions } from "../adapters/metadata";
import { getAdapterDisplay, getAdapterLabel } from "../adapters/adapter-display-registry";
import { extractModelName, extractProviderId } from "../lib/model-utils";
import { cn } from "../lib/utils";

export function AdapterTypeDropdown({
  value,
  onChange,
  disabledTypes,
  openAiDotEnabled = false,
  museEnabled = false,
  nativeRunnerEnabled = false,
  poolEnabled = false,
  poolEligible = true,
  allowedTypes,
}: {
  value: string;
  onChange: (type: string) => void;
  disabledTypes: Set<string>;
  openAiDotEnabled?: boolean;
  museEnabled?: boolean;
  nativeRunnerEnabled?: boolean;
  poolEnabled?: boolean;
  poolEligible?: boolean;
  allowedTypes?: ReadonlySet<string>;
}) {
  const selectedDisplay = getAdapterDisplay(value);
  const adapterList = useMemo(() =>
    [...listAdapterOptions(type => adapterLabels[type] ?? getAdapterLabel(type)),
      ...(openAiDotEnabled ? [{ value: "openai_dot", label: "OpenAI Dot", experimental: true, comingSoon: false }] : []),
      ...(poolEnabled && poolEligible && nativeRunnerEnabled && !disabledTypes.has("paperclip_runner") ? [{ value: "pool", label: "Pool", experimental: true, comingSoon: false }] : []),
      ...(museEnabled ? [{ value: "muse", label: "Muse — Personal agent", experimental: true, comingSoon: false }] : []),
    ].filter(item => !item.comingSoon && (item.value !== "paperclip_runner" || (nativeRunnerEnabled && !poolEnabled)) && !disabledTypes.has(item.value) && (!allowedTypes || allowedTypes.has(item.value)))
      .sort((a, b) => Number(a.value === "paperclip_runner") - Number(b.value === "paperclip_runner")),
    [disabledTypes, openAiDotEnabled, nativeRunnerEnabled, museEnabled, poolEnabled, poolEligible, allowedTypes]);
  return <SelectPopover aria-label="Harness" value={value} onValueChange={onChange}
    displayValue={<span className="inline-flex min-w-0 items-center gap-1.5">
      <span aria-hidden="true" className="inline-flex shrink-0"><AdapterMark type={value} className="size-4" /></span>
      <span className="truncate">{value === "pool" ? "Pool" : adapterLabels[value] ?? getAdapterLabel(value)}</span>
      {selectedDisplay.experimental && <ExperimentalBadge />}
    </span>}
    options={adapterList.map(item => ({ value: item.value,
      group: item.value === "paperclip_runner" ? "Advanced" : undefined,
      label: <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="inline-flex shrink-0"><AdapterMark type={item.value} className="size-4" /></span><span>{item.label}</span>{item.experimental && <ExperimentalBadge />}</span>,
    }))} />;
}

export function ExperimentalBadge() {
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
  preserveOrder,
  creatable,
  detectedModel,
  detectedModelCandidates,
  onDetectModel,
  onRefreshModels,
  refreshingModels,
  loadingModels,
  detectModelLabel,
  emptyDetectHint,
  defaultLabel,
  presentation = "searchable",
}: {
  models: AdapterModel[];
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allowDefault: boolean;
  required: boolean;
  groupByProvider: boolean;
  /** Keep the adapter's list order (curated lists) instead of sorting ungrouped entries by id. */
  preserveOrder?: boolean;
  creatable?: boolean;
  detectedModel?: string | null;
  detectedModelCandidates?: string[];
  onDetectModel?: () => Promise<string | null>;
  onRefreshModels?: () => Promise<void>;
  refreshingModels?: boolean;
  loadingModels?: boolean;
  detectModelLabel?: string;
  emptyDetectHint?: string;
  defaultLabel?: string;
  presentation?: "searchable" | "native";
}) {
  const [modelSearch, setModelSearch] = useState("");
  const [enteringCustomModel, setEnteringCustomModel] = useState(false);
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
      // A hand-ordered list (newest release of each family first, older releases at the end) is
      // shown as the adapter ordered it; a discovered list has no stable order, so sort it.
      const entries = preserveOrder ? filteredModels : [...filteredModels].sort((a, b) => a.id.localeCompare(b.id));
      return [{ provider: "models", entries }];
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
  }, [filteredModels, groupByProvider, preserveOrder]);

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

  if (presentation === "native") {
    const customOption = "__paperclip_custom_model__";
    const extraModels = [...new Set([value, ...promotedModelIds])].filter(id => id && (!models.some(model => model.id === id) || promotedModelIds.has(id)));
    return (
      <Field label="Model" hint={help.model}>
        <NativeSelect
          aria-label="Model"
          aria-busy={loadingModels || refreshingModels}
          value={enteringCustomModel ? customOption : value}
          required={required && !enteringCustomModel}
          onChange={event => {
            const next = event.target.value;
            setEnteringCustomModel(next === customOption);
            if (next !== customOption) onChange(next);
          }}
        >
          <option value="" disabled={!allowDefault}>
            {allowDefault ? (defaultLabel ?? "Default") : loadingModels ? "Loading models…" : required ? "Select model (required)" : "Select model"}
          </option>
          {extraModels.map(id => <option key={id} value={id}>{models.find(model => model.id === id)?.label ?? id}</option>)}
          {groupedModels.map(({ provider, entries }) => groupByProvider ? (
            <optgroup key={provider} label={provider}>
              {entries.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
            </optgroup>
          ) : entries.map(model => <option key={model.id} value={model.id}>{model.label}</option>))}
          {creatable && <option value={customOption}>Enter custom model…</option>}
        </NativeSelect>
        {enteringCustomModel && (
          <label className="mt-3 block space-y-1 text-xs text-muted-foreground">
            Model ID
            <Input aria-label="Model ID" value={value} onChange={event => onChange(event.target.value)}
              placeholder="Enter model ID or alias" autoFocus required={required} />
          </label>
        )}
        {loadingModels && <p role="status" className="mt-2 text-xs text-muted-foreground">Loading models…</p>}
        {onRefreshModels && <Button type="button" variant="ghost" size="sm" disabled={refreshingModels}
          onClick={() => void onRefreshModels()}>{refreshingModels ? "Refreshing…" : "Refresh models"}</Button>}
      </Field>
    );
  }

  return (
    <Field label="Model" hint={help.model}>
      <SelectPopover aria-label="Model" value={value}
        displayValue={<span className={cn("truncate", !value && "text-muted-foreground")}>
          {selected?.label ?? (value || (allowDefault ? (defaultLabel ?? "Default") : required ? "Select model (required)" : "Select model"))}
        </span>}
        open={open}
        onOpenChange={(nextOpen) => {
          onOpenChange(nextOpen);
          if (!nextOpen) setModelSearch("");
        }}
      >
        <div role="listbox" aria-label="Model">
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
              role="option" aria-selected
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
              role="option" aria-selected={false}
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
                  role="option" aria-selected={false}
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
                role="option" aria-selected={!value}
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
                role="option" aria-selected={false}
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
                    role="option" aria-selected={m.id === value}
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
                  {loadingModels ? "Loading models…" : onDetectModel
                    ? (emptyDetectHint ?? "No model detected yet. Enter a provider/model manually.")
                    : "No models found."}
                </p>
              </div>
            )}
          </div>
        </div>
      </SelectPopover>
    </Field>
  );
}

export function ThinkingEffortDropdown({
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
  return <Field label="Thinking effort" hint={help.thinkingEffort}>
    <SelectPopover aria-label="Thinking effort" value={value} onValueChange={onChange}
      open={open} onOpenChange={onOpenChange}
      options={options.map(option => ({ value: option.id, label: option.label,
        suffix: option.id ? <span className="text-xs text-muted-foreground font-mono">{option.id}</span> : undefined,
      }))} />
  </Field>;
}

const openCodeThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X-High" },
  { id: "max", label: "Max" },
] as const;

export function harnessThinkingEffortOptions(adapter: string, model: string): ReadonlyArray<{ id: string; label: string }> {
  if (adapter === "opencode_local") return openCodeThinkingEffortOptions;
  if (adapter === "codex_local") return codexReasoningEffortOptions(model, "Auto").map(option => ({ id: option.value, label: option.label }));
  return [{ id: "", label: "Auto" }, ...setupEfforts(adapter, model).map(id => ({ id, label: id === "xhigh" ? "X-High" : id[0]!.toUpperCase() + id.slice(1) }))];
}
