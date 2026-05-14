import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import {
  extractModelName,
  extractProviderIdWithFallback,
} from "../lib/model-utils";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import { AdapterTypePicker } from "./AdapterTypePicker";
import { AdapterEnvironmentResult } from "./AdapterEnvironmentResult";

const COMMAND_PLACEHOLDERS: Record<string, string> = {
  claude_local: "claude",
  codex_local: "codex",
  gemini_local: "gemini",
  pi_local: "pi",
  cursor: "agent",
  opencode_local: "opencode",
};

export function resolveEffectiveAdapterCommand(
  adapterType: string,
  command: string,
): string {
  return (
    command.trim()
    || COMMAND_PLACEHOLDERS[adapterType]
    || adapterType.replace(/_local$/, "")
  );
}

export interface AdapterStepFieldsProps {
  companyId: string | null;

  adapterType: string;
  onAdapterTypeChange: (next: string) => void;

  model: string;
  onModelChange: (next: string) => void;

  url: string;
  onUrlChange: (next: string) => void;

  envResult: AdapterEnvironmentTestResult | null;
  envError: string | null;
  envLoading: boolean;
  onRunProbe: () => Promise<void> | void;

  forceUnsetAnthropicApiKey: boolean;
  unsetAnthropicLoading: boolean;
  onUnsetAnthropicApiKey: () => Promise<void> | void;

  effectiveAdapterCommand: string;

  enabled?: boolean;
}

export function AdapterStepFields({
  companyId,
  adapterType,
  onAdapterTypeChange,
  model,
  onModelChange,
  url,
  onUrlChange,
  envResult,
  envError,
  envLoading,
  onRunProbe,
  unsetAnthropicLoading,
  onUnsetAnthropicApiKey,
  effectiveAdapterCommand,
  enabled = true,
}: AdapterStepFieldsProps) {
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  const getCapabilities = useAdapterCapabilities();
  const adapterCaps = getCapabilities(adapterType);
  const isLocalAdapter =
    adapterCaps.supportsInstructionsBundle
    || adapterCaps.supportsSkills
    || adapterCaps.supportsLocalAgentJwt;

  const { data: adapterModels } = useQuery({
    queryKey: companyId
      ? queryKeys.agents.adapterModels(companyId, adapterType, null)
      : ["agents", "none", "adapter-models", adapterType, null],
    queryFn: () =>
      agentsApi.adapterModels(companyId!, adapterType, { environmentId: null }),
    enabled: Boolean(companyId) && enabled && isLocalAdapter,
  });

  const selectedModel = (adapterModels ?? []).find((m) => m.id === model);

  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return (adapterModels ?? []).filter((entry) => {
      if (!query) return true;
      const provider = extractProviderIdWithFallback(entry.id, "");
      return (
        entry.id.toLowerCase().includes(query)
        || entry.label.toLowerCase().includes(query)
        || provider.toLowerCase().includes(query)
      );
    });
  }, [adapterModels, modelSearch]);

  const groupedModels = useMemo(() => {
    if (adapterType !== "opencode_local") {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) =>
            a.id.localeCompare(b.id),
          ),
        },
      ];
    }
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const entry of filteredModels) {
      const provider = extractProviderIdWithFallback(entry.id);
      const bucket = groups.get(provider) ?? [];
      bucket.push(entry);
      groups.set(provider, bucket);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)),
      }));
  }, [filteredModels, adapterType]);

  const hasAnthropicApiKeyOverrideCheck =
    envResult?.checks.some(
      (check) =>
        check.code === "claude_anthropic_api_key_overrides_subscription",
    ) ?? false;
  const shouldSuggestUnsetAnthropicApiKey =
    adapterType === "claude_local"
    && envResult?.status === "fail"
    && hasAnthropicApiKeyOverrideCheck;

  return (
    <div className="space-y-5">
      <div>
        <label className="text-xs text-muted-foreground mb-2 block">
          Adapter type
        </label>
        <AdapterTypePicker value={adapterType} onChange={onAdapterTypeChange} />
      </div>

      {isLocalAdapter ? (
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            Model
          </label>
          <Popover
            open={modelOpen}
            onOpenChange={(next) => {
              setModelOpen(next);
              if (!next) setModelSearch("");
            }}
          >
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
                <span className={cn(!model && "text-muted-foreground")}>
                  {selectedModel
                    ? selectedModel.label
                    : model
                      || (adapterType === "opencode_local"
                        ? "Select model (required)"
                        : "Default")}
                </span>
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[var(--radix-popover-trigger-width)] p-1"
              align="start"
            >
              <input
                className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
                placeholder="Search models..."
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                autoFocus
              />
              {adapterType !== "opencode_local" ? (
                <button
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                    !model && "bg-accent",
                  )}
                  onClick={() => {
                    onModelChange("");
                    setModelOpen(false);
                  }}
                >
                  Default
                </button>
              ) : null}
              <div className="max-h-[240px] overflow-y-auto">
                {groupedModels.map((group) => (
                  <div key={group.provider} className="mb-1 last:mb-0">
                    {adapterType === "opencode_local" ? (
                      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {group.provider} ({group.entries.length})
                      </div>
                    ) : null}
                    {group.entries.map((m) => (
                      <button
                        key={m.id}
                        className={cn(
                          "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                          m.id === model && "bg-accent",
                        )}
                        onClick={() => {
                          onModelChange(m.id);
                          setModelOpen(false);
                        }}
                      >
                        <span
                          className="block w-full text-left truncate"
                          title={m.id}
                        >
                          {adapterType === "opencode_local"
                            ? extractModelName(m.id)
                            : m.label}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              {filteredModels.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  No models discovered.
                </p>
              ) : null}
            </PopoverContent>
          </Popover>
        </div>
      ) : null}

      {isLocalAdapter ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium">Adapter environment check</p>
              <p className="text-[11px] text-muted-foreground">
                Runs a live probe that asks the adapter CLI to respond with hello.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              disabled={envLoading}
              onClick={() => void onRunProbe()}
            >
              {envLoading ? "Testing..." : envResult ? "Re-test" : "Test now"}
            </Button>
          </div>

          {envError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
              {envError}
            </div>
          ) : null}

          {envResult?.status === "pass" ? (
            <div className="flex items-center gap-2 rounded-md border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300 animate-in fade-in slide-in-from-bottom-1 duration-300">
              <Check className="h-3.5 w-3.5 shrink-0" />
              <span className="font-medium">Passed</span>
            </div>
          ) : envResult ? (
            <AdapterEnvironmentResult result={envResult} />
          ) : null}

          {shouldSuggestUnsetAnthropicApiKey ? (
            <div className="rounded-md border border-amber-300/60 bg-amber-50/40 px-2.5 py-2 space-y-2">
              <p className="text-[11px] text-amber-900/90 leading-relaxed">
                Claude failed while{" "}
                <span className="font-mono">ANTHROPIC_API_KEY</span> is set. You
                can clear it in this CEO adapter config and retry the probe.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-xs"
                disabled={envLoading || unsetAnthropicLoading}
                onClick={() => void onUnsetAnthropicApiKey()}
              >
                {unsetAnthropicLoading
                  ? "Retrying..."
                  : "Unset ANTHROPIC_API_KEY"}
              </Button>
            </div>
          ) : null}

          {envResult?.status === "fail" ? (
            <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-[11px] space-y-1.5">
              <p className="font-medium">Manual debug</p>
              <p className="text-muted-foreground font-mono break-all">
                {adapterType === "cursor"
                  ? `${effectiveAdapterCommand} -p --mode ask --output-format json "Respond with hello."`
                  : adapterType === "codex_local"
                    ? `${effectiveAdapterCommand} exec --json -`
                    : adapterType === "gemini_local"
                      ? `${effectiveAdapterCommand} --output-format json "Respond with hello."`
                      : adapterType === "opencode_local"
                        ? `${effectiveAdapterCommand} run --format json "Respond with hello."`
                        : `${effectiveAdapterCommand} --print - --output-format stream-json --verbose`}
              </p>
              <p className="text-muted-foreground">
                Prompt:{" "}
                <span className="font-mono">Respond with hello.</span>
              </p>
              {adapterType === "cursor"
                || adapterType === "codex_local"
                || adapterType === "gemini_local"
                || adapterType === "opencode_local" ? (
                <p className="text-muted-foreground">
                  If auth fails, set{" "}
                  <span className="font-mono">
                    {adapterType === "cursor"
                      ? "CURSOR_API_KEY"
                      : adapterType === "gemini_local"
                        ? "GEMINI_API_KEY"
                        : "OPENAI_API_KEY"}
                  </span>{" "}
                  in env or run{" "}
                  <span className="font-mono">
                    {adapterType === "cursor"
                      ? "agent login"
                      : adapterType === "codex_local"
                        ? "codex login"
                        : adapterType === "gemini_local"
                          ? "gemini auth"
                          : "opencode auth login"}
                  </span>
                  .
                </p>
              ) : (
                <p className="text-muted-foreground">
                  If login is required, run{" "}
                  <span className="font-mono">claude login</span> and retry.
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {adapterType === "http" || adapterType === "openclaw_gateway" ? (
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            {adapterType === "openclaw_gateway" ? "Gateway URL" : "Webhook URL"}
          </label>
          <input
            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
            placeholder={
              adapterType === "openclaw_gateway"
                ? "ws://127.0.0.1:18789"
                : "https://..."
            }
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
          />
        </div>
      ) : null}
    </div>
  );
}
