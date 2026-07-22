import type { ReactNode } from "react";
import { Search, Zap } from "lucide-react";
import type { Agent, AgentEnvConfig } from "@paperclipai/shared";
import { adapterLabels } from "./agent-config-primitives";
import { Badge } from "@/components/ui/badge";
import { cn } from "../lib/utils";

export type AgentConfigurationSectionId =
  | "runtime"
  | "environment"
  | "schedule"
  | "access"
  | "keys"
  | "danger"
  | "history";

export const agentConfigurationSections: ReadonlyArray<{
  id: AgentConfigurationSectionId;
  label: string;
  instant?: boolean;
  fields: string[];
}> = [
  { id: "runtime", label: "Runtime", fields: ["adapter", "model", "effort", "turns", "command", "arguments", "engine", "timeout", "chrome"] },
  { id: "environment", label: "Environment", fields: ["execution environment", "environment override", "variables", "secrets"] },
  { id: "schedule", label: "Schedule & Runs", fields: ["heartbeat", "wake on demand", "cooldown", "concurrent runs", "continuation"] },
  { id: "access", label: "Access & Governance", instant: true, fields: ["trust preset", "boundary", "create agents", "create skills", "assign tasks"] },
  { id: "keys", label: "API Keys", instant: true, fields: ["credentials", "create key", "revoke key"] },
  { id: "danger", label: "Danger & Legacy", fields: ["skip permissions", "bypass sandbox", "working directory", "deprecated"] },
  { id: "history", label: "History", instant: true, fields: ["configuration revisions", "restore"] },
];

export function filterAgentConfigurationSections(query: string): Set<AgentConfigurationSectionId> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return new Set(agentConfigurationSections.map((section) => section.id));
  return new Set(
    agentConfigurationSections
      .filter((section) => section.label.toLowerCase().includes(normalized) || section.fields.some((field) => field.includes(normalized)))
      .map((section) => section.id),
  );
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function resolveEffectiveConfiguration(agent: Agent, apiKeyCount = 0) {
  const adapterConfig = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  const runtimeConfig = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
  const heartbeat = (runtimeConfig.heartbeat ?? {}) as Record<string, unknown>;
  const profiles = (runtimeConfig.modelProfiles ?? {}) as Record<string, unknown>;
  const cheap = (profiles.cheap ?? {}) as Record<string, unknown>;
  const cheapConfig = (cheap.adapterConfig ?? {}) as Record<string, unknown>;
  const explicitModel = readString(adapterConfig.model);
  const resolvedModel = explicitModel || "Adapter default";
  const effort = readString(adapterConfig.modelReasoningEffort || adapterConfig.reasoningEffort || adapterConfig.effort || adapterConfig.variant || adapterConfig.mode);
  const env = (adapterConfig.env ?? {}) as AgentEnvConfig;
  return {
    adapter: adapterLabels[agent.adapterType] ?? agent.adapterType,
    model: `${resolvedModel}${effort ? ` · ${effort}` : ""}`,
    modelInherited: !explicitModel,
    cheapModel: readString(cheapConfig.model) || "Primary model",
    cheapInherited: !readString(cheapConfig.model),
    environment: agent.defaultEnvironmentId ? "Override" : "Company default",
    environmentInherited: !agent.defaultEnvironmentId,
    cadence: heartbeat.enabled === true ? `Every ${Number(heartbeat.intervalSec ?? 300)} sec` : "On demand",
    trust: agent.permissions?.trustPreset === "low_trust_review" ? "Low-trust review" : "Standard",
    apiKeyCount,
    environmentVariableCount: Object.keys(env).length,
  };
}

export type EffectiveConfigurationChip = {
  label: string;
  value: string;
  section: AgentConfigurationSectionId;
  inherited?: boolean;
};

export function buildEffectiveConfigurationChips(effectiveConfig: ReturnType<typeof resolveEffectiveConfiguration>): EffectiveConfigurationChip[] {
  return [
    { label: "Adapter", value: effectiveConfig.adapter, section: "runtime" },
    { label: "Model", value: effectiveConfig.model, section: "runtime", inherited: effectiveConfig.modelInherited },
    { label: "Cost saver", value: effectiveConfig.cheapModel, section: "runtime", inherited: effectiveConfig.cheapInherited },
    { label: "Environment", value: effectiveConfig.environment, section: "environment", inherited: effectiveConfig.environmentInherited },
    { label: "Cadence", value: effectiveConfig.cadence, section: "schedule" },
    { label: "Trust", value: effectiveConfig.trust, section: "access" },
    { label: "API keys", value: String(effectiveConfig.apiKeyCount), section: "keys" },
  ];
}

export function AgentConfigurationRail({
  query,
  onQueryChange,
  visibleSections,
  dirtySections,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  visibleSections: Set<AgentConfigurationSectionId>;
  dirtySections: ReadonlySet<string>;
}) {
  const shown = agentConfigurationSections.filter((section) => visibleSections.has(section.id));
  return (
    <>
      <div className="sticky top-0 z-20 bg-background py-2 md:hidden">
        <label className="mb-2 flex items-center gap-2 rounded-md border border-border px-2.5 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Find a setting"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
        <select
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          aria-label="Configuration section"
          onChange={(event) => document.getElementById(`config-${event.target.value}`)?.scrollIntoView({ behavior: "smooth" })}
        >
          {shown.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
        </select>
      </div>
      <aside className="sticky top-4 hidden self-start md:block">
        <label className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Find a setting"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
        <nav className="mt-3 space-y-1" aria-label="Configuration sections">
          {shown.map((section) => (
            <a key={section.id} href={`#config-${section.id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
              <span className="flex-1">{section.label}</span>
              {dirtySections.has(section.id) ? <span className="text-primary" aria-label="Unsaved changes">●</span> : null}
              {section.instant ? <Zap className="h-3 w-3" aria-label="Applies immediately" /> : null}
            </a>
          ))}
        </nav>
        <div className="mt-4 space-y-1 border-t border-border pt-3 text-xs text-muted-foreground" aria-label="Configuration section legend">
          <p><span className="text-primary" aria-hidden="true">●</span> = unsaved change in section</p>
          <p><span aria-hidden="true">⚡</span> = changes apply immediately</p>
        </div>
      </aside>
    </>
  );
}

export function EffectiveConfigurationStrip({ chips }: { chips: EffectiveConfigurationChip[] }) {
  return (
    <div className="flex max-w-full gap-2 overflow-x-auto border-b border-border pb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Effective configuration" tabIndex={0}>
      {chips.map((chip) => (
        <a
          key={chip.label}
          href={`#config-${chip.section}`}
          className="shrink-0"
          title={chip.inherited ? `${chip.label} is inherited` : undefined}
        >
          <Badge variant="outline" className={cn("gap-1.5 py-1", chip.inherited && "text-muted-foreground")}>
            <span>{chip.label}</span>
            <span className="font-mono">{chip.value}</span>
            {chip.inherited ? <span className="sr-only">inherited</span> : null}
          </Badge>
        </a>
      ))}
    </div>
  );
}

export function ConfigurationSection({ id, title, instant, children }: { id: AgentConfigurationSectionId; title: string; instant?: boolean; children: ReactNode }) {
  return (
    <section id={`config-${id}`} className="scroll-mt-24 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {instant ? <Badge variant="outline" className="gap-1"><Zap className="h-3 w-3" /> applies immediately</Badge> : null}
      </div>
      {children}
    </section>
  );
}
