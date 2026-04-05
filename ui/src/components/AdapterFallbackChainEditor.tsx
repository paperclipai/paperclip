import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { agentsApi } from "../api/agents";
import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import { ToggleField, adapterLabels, help } from "./agent-config-primitives";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";
import { extractModelName, extractProviderId } from "../lib/model-utils";
import type { AdapterFallbackChainEntryConfig } from "@paperclipai/adapter-utils";

interface AdapterFallbackChainEditorProps {
  companyId: string;
  chain: AdapterFallbackChainEntryConfig[];
  onChange: (chain: AdapterFallbackChainEntryConfig[]) => void;
  primaryAdapterType: string;
}

const ENABLED_ADAPTER_TYPES = new Set<string>([
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "openclaw_gateway",
  "process",
  "http",
  "pi_local",
  "hermes_local",
  "cursor",
]);

const ADAPTER_DISPLAY_LIST: { value: string; label: string; comingSoon: boolean }[] = [
  ...AGENT_ADAPTER_TYPES.map((t) => ({
    value: t,
    label: adapterLabels[t] ?? t,
    comingSoon: !ENABLED_ADAPTER_TYPES.has(t),
  })),
];

function AdapterSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (type: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-[160px] justify-between">
          <span className="inline-flex items-center gap-1.5 truncate">
            {value === "opencode_local" ? <OpenCodeLogoIcon className="h-3.5 w-3.5" /> : null}
            <span className="truncate">{adapterLabels[value] ?? value}</span>
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[160px] p-1" align="start">
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
            <span className="inline-flex items-center gap-1.5 truncate">
              {item.value === "opencode_local" ? <OpenCodeLogoIcon className="h-3.5 w-3.5 shrink-0" /> : null}
              <span className="truncate">{item.label}</span>
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ModelSelect({
  companyId,
  adapterType,
  value,
  onChange,
}: {
  companyId: string;
  adapterType: string;
  value: string;
  onChange: (model: string) => void;
}) {
  const { data: models = [] } = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, adapterType),
    queryFn: () => agentsApi.adapterModels(companyId, adapterType),
    enabled: Boolean(companyId && adapterType),
  });

  const hasModels = models.length > 0;
  
  if (adapterType === "process" || adapterType === "http" || adapterType === "openclaw_gateway") {
    return (
      <div className="flex-1 opacity-50 px-2.5 py-1.5 text-sm">
        N/A
      </div>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button 
          className="inline-flex flex-1 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors justify-between text-left"
          disabled={!hasModels}
        >
          <span className="text-muted-foreground truncate">
            {value || (hasModels ? "Select model..." : "No models")}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-1 max-h-[300px] overflow-y-auto" align="start">
        {models.map((m) => (
          <button
            key={m.id}
            className={cn(
              "flex flex-col items-start w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50 text-left",
              m.id === value && "bg-accent"
            )}
            onClick={() => onChange(m.id)}
          >
            <span className="truncate w-full">{extractModelName(m.id)}</span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider truncate w-full">
              {extractProviderId(m.id)}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function parseExtraArgsInput(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatExtraArgsInput(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter((item): item is string => typeof item === "string").join(", ");
}

function formatNumberInput(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function defaultAdapterConfigForType(adapterType: string): Record<string, unknown> {
  switch (adapterType) {
    case "codex_local":
      return {
        command: "codex",
        model: "gpt-5.4",
        extraArgs: ["--skip-git-repo-check"],
        dangerouslyBypassApprovalsAndSandbox: true,
      };
    case "gemini_local":
      return {
        command: "gemini",
        model: "gemini-2.5-flash",
      };
    case "claude_local":
      return {
        command: "claude",
        model: "claude-sonnet-4-6",
      };
    default:
      return {};
  }
}

export function AdapterFallbackChainEditor({
  companyId,
  chain,
  onChange,
  primaryAdapterType,
}: AdapterFallbackChainEditorProps) {
  function addFallback() {
    onChange([
      ...chain,
      { adapterType: "codex_local", adapterConfig: defaultAdapterConfigForType("codex_local") }
    ]);
  }

  function updateFallback(index: number, updates: Partial<AdapterFallbackChainEntryConfig>) {
    const next = [...chain];
    next[index] = { ...next[index], ...updates };
    onChange(next);
  }

  function removeFallback(index: number) {
    const next = [...chain];
    next.splice(index, 1);
    onChange(next);
  }

  function moveUp(index: number) {
    if (index === 0) return;
    const next = [...chain];
    const temp = next[index - 1];
    next[index - 1] = next[index];
    next[index] = temp;
    onChange(next);
  }

  function moveDown(index: number) {
    if (index === chain.length - 1) return;
    const next = [...chain];
    const temp = next[index + 1];
    next[index + 1] = next[index];
    next[index] = temp;
    onChange(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Fallback Adapters</span>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={addFallback}>
          <Plus className="h-3 w-3 mr-1" /> Add fallback
        </Button>
      </div>
      
      {chain.length === 0 ? (
        <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-3 text-center border border-dashed border-border">
          Only primary adapter ({adapterLabels[primaryAdapterType] ?? primaryAdapterType}) will be used.
        </div>
      ) : (
        <div className="space-y-2">
          {chain.map((entry, index) => (
            <div key={index} className="bg-background border border-border rounded-md p-2 space-y-2">
              <div className="flex items-center gap-2">
              <div className="flex flex-col gap-0.5 px-1">
                <button
                  type="button"
                  disabled={index === 0}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  onClick={() => moveUp(index)}
                >
                  <ChevronDown className="h-3 w-3 rotate-180" />
                </button>
                <button
                  type="button"
                  disabled={index === chain.length - 1}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  onClick={() => moveDown(index)}
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </div>
              
              <div className="flex items-center gap-2 flex-1">
                <AdapterSelect
                  value={entry.adapterType}
                  onChange={(t) => updateFallback(index, { adapterType: t, adapterConfig: defaultAdapterConfigForType(t) })}
                />
                <ModelSelect
                  companyId={companyId}
                  adapterType={entry.adapterType}
                  value={entry.adapterConfig?.model as string || ""}
                  onChange={(m) => updateFallback(index, { adapterConfig: { ...entry.adapterConfig, model: m } })}
                />
              </div>

              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0 mx-1"
                onClick={() => removeFallback(index)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pl-10">
                <input
                  className="rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40"
                  value={String(entry.adapterConfig?.command ?? "")}
                  onChange={(e) =>
                    updateFallback(index, {
                      adapterConfig: {
                        ...entry.adapterConfig,
                        command: e.target.value,
                      },
                    })
                  }
                  placeholder="command"
                />
                <input
                  className="rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40"
                  value={formatExtraArgsInput(entry.adapterConfig?.extraArgs)}
                  onChange={(e) =>
                    updateFallback(index, {
                      adapterConfig: {
                        ...entry.adapterConfig,
                        extraArgs: parseExtraArgsInput(e.target.value),
                      },
                    })
                  }
                  placeholder="extra args, comma-separated"
                />
                <input
                  type="number"
                  className="rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40"
                  value={formatNumberInput(entry.adapterConfig?.timeoutSec)}
                  onChange={(e) =>
                    updateFallback(index, {
                      adapterConfig: {
                        ...entry.adapterConfig,
                        timeoutSec: e.target.value === "" ? undefined : Number(e.target.value),
                      },
                    })
                  }
                  placeholder="timeout seconds"
                />
                <input
                  type="number"
                  className="rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40"
                  value={formatNumberInput(entry.adapterConfig?.graceSec)}
                  onChange={(e) =>
                    updateFallback(index, {
                      adapterConfig: {
                        ...entry.adapterConfig,
                        graceSec: e.target.value === "" ? undefined : Number(e.target.value),
                      },
                    })
                  }
                  placeholder="grace seconds"
                />
                {entry.adapterType === "codex_local" ? (
                  <div className="md:col-span-2 rounded-md border border-border px-2.5 py-2">
                    <ToggleField
                      label="Bypass approvals/sandbox"
                      hint={help.dangerouslyBypassSandbox}
                      checked={
                        entry.adapterConfig?.dangerouslyBypassApprovalsAndSandbox !== false &&
                        entry.adapterConfig?.dangerouslyBypassSandbox !== false
                      }
                      onChange={(checked) =>
                        updateFallback(index, {
                          adapterConfig: {
                            ...entry.adapterConfig,
                            dangerouslyBypassApprovalsAndSandbox: checked,
                          },
                        })
                      }
                    />
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
