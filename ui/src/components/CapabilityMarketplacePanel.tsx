import { useMemo, useState } from "react";
import type { AgentCapabilityConfigInput, AgentCapabilityMcpServer } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  capabilityCategoryGroups,
  mcpPresetCatalog,
  presetToDesiredMcpServer,
  type CapabilityCategoryKey,
  type McpPresetEntry,
} from "./capabilityMarketplaceCatalog";

interface CapabilityMarketplacePanelProps {
  draftConfig: AgentCapabilityConfigInput | null;
  onAddMcpPreset: (server: AgentCapabilityMcpServer) => void;
  onRemoveMcpPreset: (serverId: string) => void;
}

function riskBadgeClass(risk: McpPresetEntry["riskClass"]) {
  switch (risk) {
    case "low":
      return "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100";
    case "medium":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100";
    case "high":
      return "bg-rose-100 text-rose-900 dark:bg-rose-950/40 dark:text-rose-100";
  }
}

function approvalBadgeText(posture: McpPresetEntry["approvalPosture"]) {
  return posture === "approval_required_for_live_action"
    ? "Approval required for live apply"
    : "Desired-only · no live action";
}

export function CapabilityMarketplacePanel({
  draftConfig,
  onAddMcpPreset,
  onRemoveMcpPreset,
}: CapabilityMarketplacePanelProps) {
  const [activeCategory, setActiveCategory] = useState<CapabilityCategoryKey>("mcp");
  const [searchQuery, setSearchQuery] = useState("");

  const draftMcpServerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const server of draftConfig?.mcpServers ?? []) {
      if (server?.id) ids.add(server.id);
    }
    return ids;
  }, [draftConfig]);

  const filteredMcpPresets = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return mcpPresetCatalog;
    return mcpPresetCatalog.filter((preset) => {
      const haystack = [
        preset.displayName,
        preset.description,
        preset.source,
        preset.provider,
        ...preset.tags,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [searchQuery]);

  const activeGroup = capabilityCategoryGroups.find((group) => group.key === activeCategory);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold">Capability marketplace</h3>
          <p className="text-xs text-muted-foreground">
            Browse safe presets and add them to this agent&apos;s desired config. Selections never install, connect,
            execute, or apply capabilities — live apply remains approval-gated.
          </p>
        </div>
        <span
          className="rounded-full border border-amber-300/70 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100"
          aria-label="Marketplace edits desired config only"
        >
          desired config only
        </span>
      </div>

      <div
        role="tablist"
        aria-label="Capability categories"
        className="flex flex-wrap gap-1 rounded-md bg-muted p-1"
      >
        {capabilityCategoryGroups.map((group) => {
          const isActive = group.key === activeCategory;
          const disabled = group.status === "coming_soon";
          return (
            <button
              key={group.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`capability-category-panel-${group.key}`}
              id={`capability-category-tab-${group.key}`}
              disabled={disabled}
              onClick={() => setActiveCategory(group.key)}
              className={
                "min-h-[32px] rounded px-3 py-1 text-xs font-medium transition-colors " +
                (isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground") +
                (disabled ? " cursor-not-allowed opacity-60" : "")
              }
            >
              <span>{group.label}</span>
              {group.status === "coming_soon" && (
                <span className="ml-2 rounded-full bg-muted-foreground/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  not implemented
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`capability-category-panel-${activeCategory}`}
        aria-labelledby={`capability-category-tab-${activeCategory}`}
      >
        {activeGroup?.description && (
          <p className="mb-3 text-xs text-muted-foreground">{activeGroup.description}</p>
        )}

        {activeCategory === "mcp" ? (
          <McpPresetGrid
            presets={filteredMcpPresets}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            draftMcpServerIds={draftMcpServerIds}
            onAddMcpPreset={onAddMcpPreset}
            onRemoveMcpPreset={onRemoveMcpPreset}
          />
        ) : (
          <ComingSoonPlaceholder note={activeGroup?.comingSoonNote ?? "Catalog not implemented yet."} />
        )}
      </div>
    </div>
  );
}

function ComingSoonPlaceholder({ note }: { note: string }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
      <p>{note}</p>
      <p className="mt-1 text-xs">
        This category is desired-config only and live-disabled until a backend-backed catalog ships.
      </p>
    </div>
  );
}

function McpPresetGrid({
  presets,
  searchQuery,
  onSearchQueryChange,
  draftMcpServerIds,
  onAddMcpPreset,
  onRemoveMcpPreset,
}: {
  presets: McpPresetEntry[];
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  draftMcpServerIds: Set<string>;
  onAddMcpPreset: (server: AgentCapabilityMcpServer) => void;
  onRemoveMcpPreset: (serverId: string) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="sr-only">Search MCP presets</span>
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder="Search MCP presets (name, provider, tag)"
          className="min-h-[36px] w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          aria-label="Search MCP presets"
        />
      </label>

      {presets.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
          No MCP presets match &quot;{searchQuery}&quot;.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="MCP preset catalog">
          {presets.map((preset) => {
            const inDraft = draftMcpServerIds.has(preset.id);
            return (
              <li
                key={preset.id}
                className="flex flex-col gap-2 rounded-md border border-border bg-background p-3"
                data-preset-id={preset.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">{preset.displayName}</p>
                    <p className="text-xs text-muted-foreground">
                      MCP server · {preset.source} · {preset.provider}
                    </p>
                  </div>
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-[11px] font-medium " + riskBadgeClass(preset.riskClass)
                    }
                    aria-label={`Risk class: ${preset.riskClass}`}
                  >
                    risk: {preset.riskClass}
                  </span>
                </div>

                <p className="text-xs text-muted-foreground">{preset.description}</p>

                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                    {approvalBadgeText(preset.approvalPosture)}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                    desired state: enabled
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                    live state: not_installed
                  </span>
                </div>

                {preset.requiredSecretNames.length > 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    Required named secrets:&nbsp;
                    <span className="font-mono">{preset.requiredSecretNames.join(", ")}</span>
                    <span className="ml-1 italic">(names only — never paste raw values here)</span>
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">No named secrets required.</p>
                )}

                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    {inDraft ? "In desired config" : "Not in desired config"}
                  </span>
                  {inDraft ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onRemoveMcpPreset(preset.id)}
                      aria-label={`Remove ${preset.displayName} from desired config`}
                    >
                      Remove preset
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => onAddMcpPreset(presetToDesiredMcpServer(preset))}
                      aria-label={`Add ${preset.displayName} to desired config`}
                    >
                      Add to desired config
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
