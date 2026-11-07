import { getPageValueLabel } from "@/pages/tools/shared";
import { t as finalPagesT } from "@/i18n";
import { t as translateAgentPage, useTranslation } from "@/i18n";
import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Layers, Plus, Pencil, Trash2, Link2, ShieldCheck } from "lucide-react";
import type {
  ToolCatalogEntry,
  ToolProfileBinding,
  ToolProfileBindingTargetType,
  ToolProfileDefaultAction,
  ToolProfileEntry,
  ToolProfileEntryEffect,
  ToolProfileEntrySelectorType,
  ToolProfileStatus,
  ToolProfileWithDetails,
  ToolRiskLevel,
} from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { routinesApi } from "@/api/routines";
import {
  toolsApi,
  type CreateToolProfileInput,
  type ToolProfileBindingInput,
  type ToolProfileEntryInput,
  type UpdateToolProfileInput,
} from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AgentSelect } from "@/components/AgentMultiSelect";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/context/ToastContext";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import {
  CapabilityBadges,
  LoadingState,
  RelativeTime,
  RiskBadge,
  ToolsPageHeader,
} from "./shared";
import { describeError } from "@/api/errors";

const SELECTOR_TYPES: Array<{ value: ToolProfileEntrySelectorType; label: string }> = [
  { value: "tool_name", get label() { return translateAgentPage("agents:tool_name"); } },
  { value: "risk_level", get label() { return translateAgentPage("agents:risk_level"); } },
  { value: "application", get label() { return translateAgentPage("agents:application"); } },
  { value: "connection", get label() { return translateAgentPage("agents:connection"); } },
  { value: "catalog_entry", get label() { return translateAgentPage("agents:catalog_entry_id"); } },
];

const TARGET_TYPES: Array<{ value: ToolProfileBindingTargetType; label: string }> = [
  { value: "company", get label() { return translateAgentPage("agents:company_7a1994"); } },
  { value: "agent", get label() { return translateAgentPage("agents:agent_5ce2e6"); } },
  { value: "project", get label() { return translateAgentPage("agents:project_f6f4da"); } },
  { value: "routine", get label() { return translateAgentPage("agents:routine_482273"); } },
  { value: "issue", get label() { return translateAgentPage("agents:issue_id"); } },
];

const RISK_LEVELS: ToolRiskLevel[] = ["read", "write", "destructive", "low", "medium", "high", "critical"];

function slugifyProfileKey(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

function statusVariant(status: ToolProfileStatus): "default" | "secondary" | "outline" | "destructive" {
  if (status === "active") return "default";
  if (status === "archived") return "outline";
  return "secondary";
}

function targetIdForType(input: {
  companyId: string;
  targetType: ToolProfileBindingTargetType;
  agentId: string;
  projectId: string;
  routineId: string;
  issueId: string;
}) {
  if (input.targetType === "company") return input.companyId;
  if (input.targetType === "agent") return input.agentId;
  if (input.targetType === "project") return input.projectId;
  if (input.targetType === "routine") return input.routineId;
  return input.issueId.trim();
}

function buildEntryInput(input: {
  selectorType: ToolProfileEntrySelectorType;
  effect: ToolProfileEntryEffect;
  applicationId: string;
  connectionId: string;
  catalogEntryId: string;
  toolName: string;
  riskLevel: ToolRiskLevel;
}): ToolProfileEntryInput | null {
  const base = { selectorType: input.selectorType, effect: input.effect };
  if (input.selectorType === "application") {
    return input.applicationId ? { ...base, applicationId: input.applicationId } : null;
  }
  if (input.selectorType === "connection") {
    return input.connectionId ? { ...base, connectionId: input.connectionId } : null;
  }
  if (input.selectorType === "catalog_entry") {
    const catalogEntryId = input.catalogEntryId.trim();
    return catalogEntryId ? { ...base, catalogEntryId } : null;
  }
  if (input.selectorType === "tool_name") {
    const toolName = input.toolName.trim();
    return toolName ? { ...base, toolName } : null;
  }
  return { ...base, riskLevel: input.riskLevel };
}

function entryLabel(
  entry: ToolProfileEntry,
  applicationsById: Map<string, string>,
  connectionsById: Map<string, string>,
) {
  if (entry.selectorType === "application") return applicationsById.get(entry.applicationId ?? "") ?? entry.applicationId ?? finalPagesT("final-pages:application_1fe289");
  if (entry.selectorType === "connection") return connectionsById.get(entry.connectionId ?? "") ?? entry.connectionId ?? finalPagesT("final-pages:connection_b38d9d");
  if (entry.selectorType === "catalog_entry") return entry.catalogEntryId ?? translateAgentPage("agents:catalog_entry");
  if (entry.selectorType === "risk_level") return entry.riskLevel ? getPageValueLabel(entry.riskLevel) : translateAgentPage("agents:risk_level_73ded9");
  return entry.toolName ?? finalPagesT("final-pages:tool_7c9bbe");
}

function bindingLabel(
  targetType: ToolProfileBindingTargetType,
  targetId: string,
  labels: {
    companyId: string;
    agentsById: Map<string, string>;
    projectsById: Map<string, string>;
    routinesById: Map<string, string>;
  },
) {
  if (targetType === "company") return targetId === labels.companyId ? translateAgentPage("agents:company_7a1994") : targetId;
  if (targetType === "agent") return labels.agentsById.get(targetId) ?? targetId;
  if (targetType === "project") return labels.projectsById.get(targetId) ?? targetId;
  if (targetType === "routine") return labels.routinesById.get(targetId) ?? targetId;
  return targetId;
}

/** Short, human subtitle for the master rail: prefers the agent count the spec calls for. */
function bindingsSubtitle(bindings: ToolProfileBinding[]): string {
  if (bindings.length === 0) return finalPagesT("final-pages:unbound_0e2a58");
  const agents = bindings.filter((b) => b.targetType === "agent").length;
  if (agents === bindings.length) return translateAgentPage("agents:bound_to_agent_count", { value1: agents, count: agents });
  return translateAgentPage("agents:binding_count", { value1: bindings.length, count: bindings.length });
}

// --- Allow-list resolution ------------------------------------------------
//
// The v2 Profiles surface resolves a profile's selector entries against the
// known tool catalog so reviewers see *concrete tools* and, crucially, *why*
// each one is allowed (the Source column). A pattern selector (wildcard tool
// name, application, connection, or risk level) is a foot-gun precisely
// because the tool it pulls in is invisible without this resolution.

export type AllowSource =
  | { kind: "explicit" }
  | { kind: "pattern"; label: string }
  | { kind: "default" };

export interface AllowListRow {
  key: string;
  toolName: string;
  applicationName: string | null;
  isReadOnly: boolean;
  isWrite: boolean;
  isDestructive: boolean;
  risk: ToolRiskLevel | null;
  source: AllowSource;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function entryMatchesTool(entry: ToolProfileEntry, tool: ToolCatalogEntry): boolean {
  switch (entry.selectorType) {
    case "tool_name":
      if (!entry.toolName) return false;
      return entry.toolName.includes("*")
        ? wildcardToRegExp(entry.toolName).test(tool.toolName)
        : entry.toolName === tool.toolName;
    case "catalog_entry":
      return entry.catalogEntryId != null && entry.catalogEntryId === tool.id;
    case "application":
      return entry.applicationId != null && entry.applicationId === tool.applicationId;
    case "connection":
      return entry.connectionId != null && entry.connectionId === tool.connectionId;
    case "risk_level":
      return entry.riskLevel != null && entry.riskLevel === tool.riskLevel;
    default:
      return false;
  }
}

/** Higher = more specific. Explicit grants win over patterns when both match a tool. */
function entrySpecificity(entry: ToolProfileEntry): number {
  if (entry.selectorType === "catalog_entry") return 5;
  if (entry.selectorType === "tool_name") return entry.toolName?.includes("*") ? 3 : 4;
  if (entry.selectorType === "application" || entry.selectorType === "connection") return 2;
  return 1; // risk_level
}

function sourceFromEntry(
  entry: ToolProfileEntry,
  applicationsById: Map<string, string>,
  connectionsById: Map<string, string>,
): AllowSource {
  if (entry.selectorType === "catalog_entry") return { kind: "explicit" };
  if (entry.selectorType === "tool_name") {
    return entry.toolName?.includes("*")
      ? { kind: "pattern", label: entry.toolName }
      : { kind: "explicit" };
  }
  if (entry.selectorType === "application") {
    return { kind: "pattern", label: `app:${applicationsById.get(entry.applicationId ?? "") ?? entry.applicationId ?? "?"}` };
  }
  if (entry.selectorType === "connection") {
    return { kind: "pattern", label: `conn:${connectionsById.get(entry.connectionId ?? "") ?? entry.connectionId ?? "?"}` };
  }
  return { kind: "pattern", label: `risk:${entry.riskLevel ?? "?"}` };
}

export function resolveAllowList(
  profile: ToolProfileWithDetails,
  catalog: ToolCatalogEntry[],
  applicationsById: Map<string, string>,
  connectionsById: Map<string, string>,
): AllowListRow[] {
  const includes = profile.entries.filter((e) => e.effect === "include");
  const excludes = profile.entries.filter((e) => e.effect === "exclude");
  const rows: AllowListRow[] = [];

  for (const tool of catalog) {
    if (excludes.some((e) => entryMatchesTool(e, tool))) continue;
    const matchingIncludes = includes.filter((e) => entryMatchesTool(e, tool));
    let source: AllowSource;
    if (matchingIncludes.length > 0) {
      const best = matchingIncludes.reduce((a, b) =>
        entrySpecificity(b) > entrySpecificity(a) ? b : a,
      );
      source = sourceFromEntry(best, applicationsById, connectionsById);
    } else if (profile.defaultAction === "allow") {
      source = { kind: "default" };
    } else {
      continue;
    }
    rows.push({
      key: tool.id,
      toolName: tool.toolName,
      applicationName: applicationsById.get(tool.applicationId ?? "") ?? null,
      isReadOnly: tool.isReadOnly,
      isWrite: tool.isWrite,
      isDestructive: tool.isDestructive,
      risk: tool.riskLevel,
      source,
    });
  }

  // Surface explicit grants that don't resolve to a known catalog tool yet
  // (stale/empty catalog) so they aren't silently dropped from the allow list.
  const resolvedNames = new Set(rows.map((r) => r.toolName));
  for (const entry of includes) {
    if (entry.selectorType !== "tool_name" || !entry.toolName || entry.toolName.includes("*")) continue;
    if (resolvedNames.has(entry.toolName)) continue;
    if (excludes.some((e) => e.selectorType === "tool_name" && e.toolName === entry.toolName)) continue;
    rows.push({
      key: `entry-${entry.id}`,
      toolName: entry.toolName,
      applicationName: null,
      isReadOnly: false,
      isWrite: false,
      isDestructive: false,
      risk: null,
      source: { kind: "explicit" },
    });
    resolvedNames.add(entry.toolName);
  }

  return rows.sort((a, b) => a.toolName.localeCompare(b.toolName));
}

function useLookupData(companyId: string) {
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const projects = useQuery({
    queryKey: queryKeys.projects.list(companyId, { includeArchived: true }),
    queryFn: () => projectsApi.list(companyId, { includeArchived: true }),
  });
  const routines = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
  });
  const applications = useQuery({
    queryKey: queryKeys.tools.applications(companyId),
    queryFn: () => toolsApi.listApplications(companyId),
  });
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });

  const maps = useMemo(() => ({
    agentsById: new Map((agents.data ?? []).map((agent) => [agent.id, agent.name])),
    projectsById: new Map((projects.data ?? []).map((project) => [project.id, project.name])),
    routinesById: new Map((routines.data ?? []).map((routine) => [routine.id, routine.title])),
    applicationsById: new Map((applications.data?.applications ?? []).map((app) => [app.id, app.name])),
    connectionsById: new Map((connections.data?.connections ?? []).map((conn) => [conn.id, conn.name])),
  }), [agents.data, applications.data, connections.data, projects.data, routines.data]);

  return { agents, projects, routines, applications, connections, maps };
}

function EntryFields({
  selectorType,
  setSelectorType,
  effect,
  setEffect,
  applicationId,
  setApplicationId,
  connectionId,
  setConnectionId,
  catalogEntryId,
  setCatalogEntryId,
  toolName,
  setToolName,
  riskLevel,
  setRiskLevel,
  applications,
  connections,
}: {
  selectorType: ToolProfileEntrySelectorType;
  setSelectorType: (value: ToolProfileEntrySelectorType) => void;
  effect: ToolProfileEntryEffect;
  setEffect: (value: ToolProfileEntryEffect) => void;
  applicationId: string;
  setApplicationId: (value: string) => void;
  connectionId: string;
  setConnectionId: (value: string) => void;
  catalogEntryId: string;
  setCatalogEntryId: (value: string) => void;
  toolName: string;
  setToolName: (value: string) => void;
  riskLevel: ToolRiskLevel;
  setRiskLevel: (value: ToolRiskLevel) => void;
  applications: Array<{ id: string; name: string }>;
  connections: Array<{ id: string; name: string }>;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  return (
    <div className="grid gap-3 sm:grid-cols-(--gtc-60)">
      <div className="space-y-1.5">
        <Label>{translateAgentPage("agents:selector")}</Label>
        <Select value={selectorType} onValueChange={(value) => setSelectorType(value as ToolProfileEntrySelectorType)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SELECTOR_TYPES.map((type) => (
              <SelectItem key={type.value} value={type.value}>
                {type.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>{translateAgentPage("agents:effect")}</Label>
        <Select value={effect} onValueChange={(value) => setEffect(value as ToolProfileEntryEffect)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="include">{translateAgentPage("agents:include")}</SelectItem>
            <SelectItem value="exclude">{translateAgentPage("agents:exclude")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {selectorType === "application" ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label>{translateAgentPage("agents:application")}</Label>
          <Select value={applicationId} onValueChange={setApplicationId}>
            <SelectTrigger>
              <SelectValue placeholder={translateAgentPage("agents:select_an_application")} />
            </SelectTrigger>
            <SelectContent>
              {applications.map((app) => (
                <SelectItem key={app.id} value={app.id}>
                  {app.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {selectorType === "connection" ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label>{translateAgentPage("agents:connection")}</Label>
          <Select value={connectionId} onValueChange={setConnectionId}>
            <SelectTrigger>
              <SelectValue placeholder={translateAgentPage("agents:select_a_connection")} />
            </SelectTrigger>
            <SelectContent>
              {connections.map((conn) => (
                <SelectItem key={conn.id} value={conn.id}>
                  {conn.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {selectorType === "catalog_entry" ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="catalog-entry-id">{translateAgentPage("agents:catalog_entry_id")}</Label>
          <Input id="catalog-entry-id" value={catalogEntryId} onChange={(event) => setCatalogEntryId(event.target.value)} />
        </div>
      ) : null}
      {selectorType === "tool_name" ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="tool-name">{translateAgentPage("agents:tool_name")}</Label>
          <Input id="tool-name" value={toolName} onChange={(event) => setToolName(event.target.value)} placeholder={translateAgentPage("agents:e_g_send_email_or_slack_list")} />
        </div>
      ) : null}
      {selectorType === "risk_level" ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label>{translateAgentPage("agents:risk_level")}</Label>
          <Select value={riskLevel} onValueChange={(value) => setRiskLevel(value as ToolRiskLevel)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RISK_LEVELS.map((risk) => (
                <SelectItem key={risk} value={risk}>
                  {risk}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  );
}

export function EffectiveAgentPanel({ companyId, agentOptions }: { companyId: string; agentOptions: Array<{ id: string; name: string }> }) {
  const { t: translateAgentPage } = useTranslation("agents");
  const [agentId, setAgentId] = useState("");
  const effective = useQuery({
    queryKey: agentId
      ? queryKeys.tools.effectiveProfilesForAgent(companyId, agentId)
      : ["tools", companyId, "profiles", "effective", "agent", "__none__"],
    queryFn: () => toolsApi.getEffectiveProfilesForAgent(companyId, agentId),
    enabled: Boolean(agentId),
  });
  const effectiveView = useQueryView(effective);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="space-y-1.5">
        <Label>{translateAgentPage("agents:agent_5ce2e6")}</Label>
        <AgentSelect agents={agentOptions} value={agentId} onChange={setAgentId} />
      </div>
      {!agentId ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">{translateAgentPage("agents:pick_an_agent_to_see_what_it_can")}</div>
      ) : effective.isLoading || effectiveView.kind === "reconnecting" ? (
        <LoadingState label={translateAgentPage("agents:checking_access")} />
      ) : effectiveView.kind === "error" ? (
        <QueryErrorState
          error={effective.error}
          action={translateAgentPage("agents:check_this_agent_s_access")}
          onRetry={effectiveView.retry}
          retrying={effectiveView.isFetching}
        />
      ) : (
        <div className="min-h-0 space-y-5 overflow-y-auto pr-1">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">{translateAgentPage("agents:can_use")}</h3>
              <span className="text-xs text-muted-foreground tabular-nums">
                {(effective.data?.allowedToolNames ?? []).length}{" "}{translateAgentPage("agents:tools_0284c6")}</span>
            </div>
            {(effective.data?.allowedToolNames ?? []).length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">{translateAgentPage("agents:this_agent_cannot_use_any_app_tools_right")}</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(effective.data?.allowedToolNames ?? []).slice(0, 80).map((tool) => (
                  <Badge key={tool} variant="outline">{tool}</Badge>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{translateAgentPage("agents:access_profiles")}</h3>
            {(effective.data?.profiles ?? []).length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">{translateAgentPage("agents:no_active_profile_applies_to_this_agent")}</div>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {(effective.data?.profiles ?? []).map((profile) => (
                  <div key={profile.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">{profile.name}</span>
                    {profile.summary.isCompanyDefault ? (
                      <Badge variant="secondary">{translateAgentPage("agents:organization_default")}</Badge>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The Source column — the key v2 addition. Patterns are flagged as a foot-gun. */
function SourceBadge({ source }: { source: AllowSource }) {
  const { t: translateAgentPage } = useTranslation("agents");
  if (source.kind === "explicit") {
    return <Badge variant="secondary">{translateAgentPage("agents:explicit")}</Badge>;
  }
  if (source.kind === "default") {
    return <Badge variant="outline">{translateAgentPage("agents:default_allow")}</Badge>;
  }
  return (
    <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400">
      <AlertTriangle className="h-3 w-3" />
      <span className="font-mono text-(length:--text-micro)">{translateAgentPage("agents:pattern")}{" "}{source.label}</span>
    </Badge>
  );
}

function AllowList({ rows, catalogLoading }: { rows: AllowListRow[]; catalogLoading: boolean }) {
  const { t: translateAgentPage } = useTranslation("agents");
  const patternCount = rows.filter((r) => r.source.kind === "pattern").length;
  const explicitCount = rows.filter((r) => r.source.kind === "explicit").length;
  const defaultCount = rows.filter((r) => r.source.kind === "default").length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground">{translateAgentPage("agents:allow_list")}</h4>
        <p className="text-xs text-muted-foreground">
          {translateAgentPage("agents:count_tool", { count: rows.length })}
          {explicitCount > 0 ? translateAgentPage("agents:explicit_30b8fb", { value1: explicitCount }) : ""}
          {patternCount > 0 ? translateAgentPage("agents:via_pattern", { value1: patternCount }) : ""}
          {defaultCount > 0 ? translateAgentPage("agents:via_default", { value1: defaultCount }) : ""}
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          {catalogLoading
            ? translateAgentPage("agents:resolving_allowed_tools")
            : translateAgentPage("agents:no_tools_resolved_for_this_profile_add_an")}
        </div>
      ) : (
        <Card>
          <CardContent className="px-0 py-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2.5 font-medium">{translateAgentPage("agents:tool_9a830c")}</th>
                  <th className="px-3 py-2.5 font-medium">{translateAgentPage("agents:application")}</th>
                  <th className="px-3 py-2.5 font-medium">{translateAgentPage("agents:capabilities")}</th>
                  <th className="px-3 py-2.5 font-medium">{translateAgentPage("agents:risk")}</th>
                  <th className="px-3 py-2.5 font-medium">{translateAgentPage("agents:source")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.key} className="align-top">
                    <td className="px-3 py-2.5">
                      <span className="font-mono text-xs text-foreground">{row.toolName}</span>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {row.applicationName ?? <span className="text-muted-foreground/60">—</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {row.isReadOnly || row.isWrite || row.isDestructive ? (
                        <CapabilityBadges
                          isReadOnly={row.isReadOnly}
                          isWrite={row.isWrite}
                          isDestructive={row.isDestructive}
                        />
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {row.risk ? <RiskBadge risk={row.risk} /> : <span className="text-muted-foreground/60">—</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <SourceBadge source={row.source} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
      {patternCount > 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />{translateAgentPage("agents:tools_marked")}{" "}<span className="font-medium">{translateAgentPage("agents:pattern")}</span>{" "}{translateAgentPage("agents:were_pulled_in_by_a_wildcard_application_connection")}</p>
      ) : null}
    </div>
  );
}

export function ProfilesTab({ companyId }: { companyId: string }) {
  const { t: translateAgentPage } = useTranslation("agents");
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [editProfile, setEditProfile] = useState<ToolProfileWithDetails | null>(null);
  const [entryProfile, setEntryProfile] = useState<ToolProfileWithDetails | null>(null);
  const [bindProfileFor, setBindProfileFor] = useState<ToolProfileWithDetails | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [profileKey, setProfileKey] = useState("");
  const [description, setDescription] = useState("");
  const [defaultAction, setDefaultAction] = useState<ToolProfileDefaultAction>("deny");
  const [status, setStatus] = useState<ToolProfileStatus>("active");

  const [selectorType, setSelectorType] = useState<ToolProfileEntrySelectorType>("tool_name");
  const [effect, setEffect] = useState<ToolProfileEntryEffect>("include");
  const [applicationId, setApplicationId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [catalogEntryId, setCatalogEntryId] = useState("");
  const [toolName, setToolName] = useState("");
  const [riskLevel, setRiskLevel] = useState<ToolRiskLevel>("read");

  const [targetType, setTargetType] = useState<ToolProfileBindingTargetType>("agent");
  const [targetAgentId, setTargetAgentId] = useState("");
  const [targetProjectId, setTargetProjectId] = useState("");
  const [targetRoutineId, setTargetRoutineId] = useState("");
  const [targetIssueId, setTargetIssueId] = useState("");
  const [priority, setPriority] = useState("100");

  const lookups = useLookupData(companyId);
  const profiles = useQuery({
    queryKey: queryKeys.tools.profiles(companyId),
    queryFn: () => toolsApi.listProfiles(companyId),
  });
  const profilesView = useQueryView(profiles);

  const connectionList = lookups.connections.data?.connections ?? [];
  // Company-wide catalog, assembled per connection (there is no aggregate
  // endpoint). It powers allow-list resolution: concrete tool + capabilities +
  // risk + which selector pulled it in.
  const catalogQueries = useQueries({
    queries: connectionList.map((c) => ({
      queryKey: queryKeys.tools.catalog(c.id),
      queryFn: () => toolsApi.listCatalog(c.id),
      staleTime: 60_000,
    })),
  });
  const catalog = useMemo(
    () => catalogQueries.flatMap((q) => q.data?.catalog ?? []),
    [catalogQueries],
  );
  const catalogLoading = catalogQueries.some((q) => q.isLoading);

  const applicationOptions = lookups.applications.data?.applications ?? [];
  const connectionOptions = lookups.connections.data?.connections ?? [];
  const agentOptions = lookups.agents.data ?? [];
  const projectOptions = (lookups.projects.data ?? []).filter((project) => !project.archivedAt);
  const routineOptions = lookups.routines.data ?? [];

  const invalidateProfiles = () => {
    qc.invalidateQueries({ queryKey: queryKeys.tools.profiles(companyId) });
    qc.invalidateQueries({ queryKey: ["tools", companyId, "profiles", "effective"] });
    qc.invalidateQueries({ queryKey: queryKeys.tools.testAgentAccesses() });
  };

  const resetProfileForm = () => {
    setName("");
    setProfileKey("");
    setDescription("");
    setDefaultAction("deny");
    setStatus("active");
  };

  const resetEntryForm = () => {
    setSelectorType("tool_name");
    setEffect("include");
    setApplicationId("");
    setConnectionId("");
    setCatalogEntryId("");
    setToolName("");
    setRiskLevel("read");
  };

  const createProfile = useMutation({
    mutationFn: (input: CreateToolProfileInput) => toolsApi.createProfile(companyId, input),
    onSuccess: (created) => {
      invalidateProfiles();
      setCreateOpen(false);
      setSelectedId(created.id);
      resetProfileForm();
      resetEntryForm();
      pushToast({ title: translateAgentPage("agents:profile_created"), tone: "success" });
    },
    onError: (error) => pushToast({
      title: translateAgentPage("agents:could_not_create_profile"),
      body: describeError(error).body,
      tone: "error",
    }),
  });

  const updateProfile = useMutation({
    mutationFn: ({ profileId, input }: { profileId: string; input: UpdateToolProfileInput }) =>
      toolsApi.updateProfile(profileId, input),
    onSuccess: () => {
      invalidateProfiles();
      setEditProfile(null);
      resetProfileForm();
      pushToast({ title: translateAgentPage("agents:profile_updated"), tone: "success" });
    },
    onError: (error) => pushToast({
      title: translateAgentPage("agents:could_not_update_profile"),
      body: describeError(error).body,
      tone: "error",
    }),
  });

  const addEntry = useMutation({
    mutationFn: ({ profileId, input }: { profileId: string; input: ToolProfileEntryInput }) =>
      toolsApi.addProfileEntry(profileId, input),
    onSuccess: () => {
      invalidateProfiles();
      setEntryProfile(null);
      resetEntryForm();
      pushToast({ title: translateAgentPage("agents:entry_added"), tone: "success" });
    },
    onError: (error) => pushToast({
      title: translateAgentPage("agents:could_not_add_entry"),
      body: describeError(error).body,
      tone: "error",
    }),
  });

  const deleteEntry = useMutation({
    mutationFn: (entryId: string) => toolsApi.deleteProfileEntry(entryId),
    onSuccess: () => {
      invalidateProfiles();
      pushToast({ title: translateAgentPage("agents:entry_removed"), tone: "success" });
    },
    onError: (error) => pushToast({
      title: translateAgentPage("agents:could_not_remove_entry"),
      body: describeError(error).body,
      tone: "error",
    }),
  });

  const bind = useMutation({
    mutationFn: ({ profileId, input }: { profileId: string; input: ToolProfileBindingInput }) =>
      toolsApi.bindProfile(companyId, profileId, input),
    onSuccess: () => {
      invalidateProfiles();
      setBindProfileFor(null);
      setTargetType("agent");
      setPriority("100");
      pushToast({ title: translateAgentPage("agents:profile_bound"), tone: "success" });
    },
    onError: (error) => pushToast({
      title: translateAgentPage("agents:could_not_bind_profile"),
      body: describeError(error).body,
      tone: "error",
    }),
  });

  const unbind = useMutation({
    mutationFn: ({ profileId, targetType, targetId }: {
      profileId: string;
      targetType: ToolProfileBindingTargetType;
      targetId: string;
    }) => toolsApi.unbindProfile(companyId, profileId, { targetType, targetId }),
    onSuccess: () => {
      invalidateProfiles();
      pushToast({ title: translateAgentPage("agents:binding_removed"), tone: "success" });
    },
    onError: (error) => pushToast({
      title: translateAgentPage("agents:could_not_remove_binding"),
      body: describeError(error).body,
      tone: "error",
    }),
  });

  if (profiles.isLoading || profilesView.kind === "reconnecting") return <LoadingState />;
  if (profilesView.kind === "error") {
    return (
      <QueryErrorState
        error={profiles.error}
        action={translateAgentPage("agents:load_profiles")}
        onRetry={profilesView.retry}
        retrying={profilesView.isFetching}
      />
    );
  }

  const list = profiles.data?.profiles ?? [];
  const selected = list.find((p) => p.id === selectedId) ?? list[0] ?? null;

  const openEdit = (profile: ToolProfileWithDetails) => {
    setEditProfile(profile);
    setName(profile.name);
    setProfileKey(profile.profileKey);
    setDescription(profile.description ?? "");
    setDefaultAction(profile.defaultAction);
    setStatus(profile.status);
  };

  const saveProfile = () => {
    const key = profileKey.trim() || slugifyProfileKey(name);
    if (!name.trim() || !key) return;
    if (editProfile) {
      updateProfile.mutate({
        profileId: editProfile.id,
        input: {
          name: name.trim(),
          profileKey: key,
          description: description.trim() || null,
          defaultAction,
          status,
        },
      });
      return;
    }
    const entry = buildEntryInput({
      selectorType,
      effect,
      applicationId,
      connectionId,
      catalogEntryId,
      toolName,
      riskLevel,
    });
    createProfile.mutate({
      name: name.trim(),
      profileKey: key,
      description: description.trim() || null,
      defaultAction,
      status,
      entries: entry ? [entry] : [],
    });
  };

  const saveEntry = () => {
    if (!entryProfile) return;
    const entry = buildEntryInput({
      selectorType,
      effect,
      applicationId,
      connectionId,
      catalogEntryId,
      toolName,
      riskLevel,
    });
    if (!entry) {
      pushToast({ title: translateAgentPage("agents:entry_target_required"), tone: "error" });
      return;
    }
    addEntry.mutate({ profileId: entryProfile.id, input: entry });
  };

  const saveBinding = () => {
    if (!bindProfileFor) return;
    const targetId = targetIdForType({
      companyId,
      targetType,
      agentId: targetAgentId,
      projectId: targetProjectId,
      routineId: targetRoutineId,
      issueId: targetIssueId,
    });
    if (!targetId) {
      pushToast({ title: translateAgentPage("agents:binding_target_required"), tone: "error" });
      return;
    }
    bind.mutate({
      profileId: bindProfileFor.id,
      input: {
        targetType,
        targetId,
        priority: Number(priority) || 100,
      },
    });
  };

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title={translateAgentPage("agents:access_profiles")}
        description={translateAgentPage("agents:reusable_bundles_of_allowed_applications_connections_and_tools")}
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />{translateAgentPage("agents:new_profile")}</Button>
        }
      />

      <EffectiveAgentPanel companyId={companyId} agentOptions={agentOptions} />

      {list.length === 0 ? (
        <EmptyState
          icon={Layers}
          message={translateAgentPage("agents:no_access_profiles_yet")}
          description={translateAgentPage("agents:create_a_profile_to_group_tool_selectors_then")}
          action={translateAgentPage("agents:new_profile")}
          onAction={() => setCreateOpen(true)}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-(--gtc-63)">
          {/* Master rail */}
          <Card className="h-fit">
            <CardContent className="p-0">
              <ul className="divide-y divide-border">
                {list.map((profile) => {
                  const toolCount = resolveAllowList(
                    profile,
                    catalog,
                    lookups.maps.applicationsById,
                    lookups.maps.connectionsById,
                  ).length;
                  const isActive = selected?.id === profile.id;
                  return (
                    <li key={profile.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(profile.id)}
                        className={cn(
                          "flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-accent/50",
                          isActive && "bg-accent/70",
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium text-foreground">{profile.name}</span>
                          {profile.status !== "active" ? (
                            <Badge variant={statusVariant(profile.status)} className="text-(length:--text-nano)">
                              {getPageValueLabel(profile.status)}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {translateAgentPage("agents:count_tool", { count: toolCount })} · {bindingsSubtitle(profile.bindings)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>

          {/* Detail pane */}
          {selected ? (
            <ProfileDetail
              profile={selected}
              catalog={catalog}
              catalogLoading={catalogLoading}
              maps={lookups.maps}
              companyId={companyId}
              onEdit={() => openEdit(selected)}
              onAddEntry={() => {
                setEntryProfile(selected);
                resetEntryForm();
              }}
              onBind={() => setBindProfileFor(selected)}
              onDeleteEntry={(entryId) => deleteEntry.mutate(entryId)}
              onUnbind={(binding) =>
                unbind.mutate({
                  profileId: selected.id,
                  targetType: binding.targetType,
                  targetId: binding.targetId,
                })
              }
            />
          ) : null}
        </div>
      )}

      <Dialog open={createOpen || Boolean(editProfile)} onOpenChange={(open) => {
        if (!open) {
          setCreateOpen(false);
          setEditProfile(null);
          resetProfileForm();
          resetEntryForm();
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editProfile ? translateAgentPage("agents:edit_profile") : translateAgentPage("agents:new_profile")}</DialogTitle>
            <DialogDescription>{translateAgentPage("agents:profile_rules_are_enforced_by_the_tool_gateway")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="profile-name">{translateAgentPage("agents:name")}</Label>
                <Input
                  id="profile-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (!editProfile && !profileKey.trim()) setProfileKey(slugifyProfileKey(event.target.value));
                  }}
                  placeholder={translateAgentPage("agents:engineering_write_tools")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="profile-key">{translateAgentPage("agents:key")}</Label>
                <Input id="profile-key" value={profileKey} onChange={(event) => setProfileKey(event.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-description">{translateAgentPage("agents:description")}</Label>
              <Textarea
                id="profile-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={translateAgentPage("agents:optional_context_for_reviewers")}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{translateAgentPage("agents:default_action")}</Label>
                <Select value={defaultAction} onValueChange={(value) => setDefaultAction(value as ToolProfileDefaultAction)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="deny">{translateAgentPage("agents:deny_unless_included")}</SelectItem>
                    <SelectItem value="allow">{translateAgentPage("agents:allow_unless_excluded")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{translateAgentPage("agents:status")}</Label>
                <Select value={status} onValueChange={(value) => setStatus(value as ToolProfileStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">{translateAgentPage("agents:active")}</SelectItem>
                    <SelectItem value="disabled">{translateAgentPage("agents:disabled")}</SelectItem>
                    <SelectItem value="archived">{translateAgentPage("agents:archived")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {!editProfile ? (
              <EntryFields
                selectorType={selectorType}
                setSelectorType={setSelectorType}
                effect={effect}
                setEffect={setEffect}
                applicationId={applicationId}
                setApplicationId={setApplicationId}
                connectionId={connectionId}
                setConnectionId={setConnectionId}
                catalogEntryId={catalogEntryId}
                setCatalogEntryId={setCatalogEntryId}
                toolName={toolName}
                setToolName={setToolName}
                riskLevel={riskLevel}
                setRiskLevel={setRiskLevel}
                applications={applicationOptions}
                connections={connectionOptions}
              />
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setCreateOpen(false);
              setEditProfile(null);
              resetProfileForm();
              resetEntryForm();
            }}>{translateAgentPage("agents:cancel")}</Button>
            <Button disabled={!name.trim() || createProfile.isPending || updateProfile.isPending} onClick={saveProfile}>
              {editProfile ? translateAgentPage("agents:save") : createProfile.isPending ? translateAgentPage("agents:creating") : translateAgentPage("agents:create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(entryProfile)} onOpenChange={(open) => {
        if (!open) {
          setEntryProfile(null);
          resetEntryForm();
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{translateAgentPage("agents:add_entry")}</DialogTitle>
            <DialogDescription>{entryProfile?.name}</DialogDescription>
          </DialogHeader>
          <EntryFields
            selectorType={selectorType}
            setSelectorType={setSelectorType}
            effect={effect}
            setEffect={setEffect}
            applicationId={applicationId}
            setApplicationId={setApplicationId}
            connectionId={connectionId}
            setConnectionId={setConnectionId}
            catalogEntryId={catalogEntryId}
            setCatalogEntryId={setCatalogEntryId}
            toolName={toolName}
            setToolName={setToolName}
            riskLevel={riskLevel}
            setRiskLevel={setRiskLevel}
            applications={applicationOptions}
            connections={connectionOptions}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEntryProfile(null)}>{translateAgentPage("agents:cancel")}</Button>
            <Button disabled={addEntry.isPending} onClick={saveEntry}>{translateAgentPage("agents:add_entry")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(bindProfileFor)} onOpenChange={(open) => {
        if (!open) setBindProfileFor(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{translateAgentPage("agents:bind_profile")}</DialogTitle>
            <DialogDescription>{bindProfileFor?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{translateAgentPage("agents:target_type")}</Label>
              <Select value={targetType} onValueChange={(value) => setTargetType(value as ToolProfileBindingTargetType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TARGET_TYPES.map((target) => (
                    <SelectItem key={target.value} value={target.value}>
                      {target.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {targetType === "agent" ? (
              <div className="space-y-1.5">
                <Label>{translateAgentPage("agents:agent_5ce2e6")}</Label>
                <AgentSelect agents={agentOptions} value={targetAgentId} onChange={setTargetAgentId} />
              </div>
            ) : null}
            {targetType === "project" ? (
              <div className="space-y-1.5">
                <Label>{translateAgentPage("agents:project_f6f4da")}</Label>
                <Select value={targetProjectId} onValueChange={setTargetProjectId}>
                  <SelectTrigger><SelectValue placeholder={translateAgentPage("agents:select_a_project")} /></SelectTrigger>
                  <SelectContent>
                    {projectOptions.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {targetType === "routine" ? (
              <div className="space-y-1.5">
                <Label>{translateAgentPage("agents:routine_482273")}</Label>
                <Select value={targetRoutineId} onValueChange={setTargetRoutineId}>
                  <SelectTrigger><SelectValue placeholder={translateAgentPage("agents:select_a_routine")} /></SelectTrigger>
                  <SelectContent>
                    {routineOptions.map((routine) => <SelectItem key={routine.id} value={routine.id}>{routine.title}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {targetType === "issue" ? (
              <div className="space-y-1.5">
                <Label htmlFor="target-issue-id">{translateAgentPage("agents:issue_id")}</Label>
                <Input id="target-issue-id" value={targetIssueId} onChange={(event) => setTargetIssueId(event.target.value)} />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="profile-priority">{translateAgentPage("agents:priority")}</Label>
              <Input id="profile-priority" type="number" min={0} max={10000} value={priority} onChange={(event) => setPriority(event.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBindProfileFor(null)}>{translateAgentPage("agents:cancel")}</Button>
            <Button disabled={bind.isPending} onClick={saveBinding}>{translateAgentPage("agents:bind")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProfileDetail({
  profile,
  catalog,
  catalogLoading,
  maps,
  companyId,
  onEdit,
  onAddEntry,
  onBind,
  onDeleteEntry,
  onUnbind,
}: {
  profile: ToolProfileWithDetails;
  catalog: ToolCatalogEntry[];
  catalogLoading: boolean;
  maps: {
    companyId?: string;
    agentsById: Map<string, string>;
    projectsById: Map<string, string>;
    routinesById: Map<string, string>;
    applicationsById: Map<string, string>;
    connectionsById: Map<string, string>;
  };
  companyId: string;
  onEdit: () => void;
  onAddEntry: () => void;
  onBind: () => void;
  onDeleteEntry: (entryId: string) => void;
  onUnbind: (binding: ToolProfileBinding) => void;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  const rows = useMemo(
    () => resolveAllowList(profile, catalog, maps.applicationsById, maps.connectionsById),
    [profile, catalog, maps.applicationsById, maps.connectionsById],
  );
  const includeCount = profile.entries.filter((e) => e.effect === "include").length;
  const excludeCount = profile.entries.filter((e) => e.effect === "exclude").length;

  return (
    <Card>
      <CardContent className="space-y-5 py-4">
        {/* Header */}
        <div className="flex flex-wrap items-start gap-3">
          <Layers className="mt-0.5 h-5 w-5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{profile.name}</span>
              <Badge variant="outline">{profile.profileKey}</Badge>
              <Badge variant={statusVariant(profile.status)}>{getPageValueLabel(profile.status)}</Badge>
              <Badge variant={profile.defaultAction === "allow" ? "secondary" : "outline"}>{translateAgentPage("agents:default_7505d6")}{" "}{profile.defaultAction}
              </Badge>
            </div>
            {profile.description ? (
              <p className="mt-1 text-sm text-muted-foreground">{profile.description}</p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">{translateAgentPage("agents:updated_13a189")}{" "}<RelativeTime value={profile.updatedAt} />
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil className="mr-1 h-3.5 w-3.5" />{translateAgentPage("agents:edit_530164")}</Button>
            <Button size="sm" variant="outline" onClick={onAddEntry}>
              <Plus className="mr-1 h-3.5 w-3.5" />{translateAgentPage("agents:entry")}</Button>
            <Button size="sm" variant="outline" onClick={onBind}>
              <Link2 className="mr-1 h-3.5 w-3.5" />{translateAgentPage("agents:bind")}</Button>
          </div>
        </div>

        {/* Targets */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-foreground">{translateAgentPage("agents:targets")}</h4>
          <div className="flex flex-wrap gap-2">
            {profile.bindings.length === 0 ? (
              <span className="text-sm text-muted-foreground">{translateAgentPage("agents:no_targets_bound")}</span>
            ) : profile.bindings.map((binding) => (
              <span key={binding.id} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                <Badge variant="outline">{binding.targetType}</Badge>
                <span>{bindingLabel(binding.targetType, binding.targetId, { companyId, ...maps })}</span>
                <span className="text-muted-foreground">{finalPagesT("final-pages:p_priority_af7dc3", { priority: binding.priority })}</span>
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                  onClick={() => onUnbind(binding)}
                  aria-label={translateAgentPage("agents:remove_binding", { value1: binding.targetType })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* Effective scope summary */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-foreground">{translateAgentPage("agents:effective_scope")}</h4>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">{translateAgentPage("agents:default")}{" "}<span className="font-medium text-foreground">{profile.defaultAction}</span>
            </span>
            <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">
              <span className="font-medium text-foreground">{rows.length}</span>{" "}{translateAgentPage("agents:tools_allowed")}</span>
            <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">
              <span className="font-medium text-foreground">{includeCount}</span>{" "}{translateAgentPage("agents:include_3782ee")}{" "}
              <span className="font-medium text-foreground">{excludeCount}</span>{" "}{translateAgentPage("agents:exclude_f3acce")}</span>
          </div>
        </div>

        {/* Selectors (entry management) */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-foreground">{translateAgentPage("agents:selectors")}</h4>
          <div className="flex flex-wrap gap-2">
            {profile.entries.length === 0 ? (
              <span className="text-sm text-muted-foreground">{translateAgentPage("agents:no_selectors")}</span>
            ) : profile.entries.map((entry) => (
              <span key={entry.id} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                <Badge variant={entry.effect === "include" ? "secondary" : "destructive"}>{entry.effect}</Badge>
                <span className="font-mono">{entry.selectorType}</span>
                {entry.selectorType === "risk_level" ? <RiskBadge risk={entry.riskLevel} /> : (
                  <span className="max-w-64 truncate">{entryLabel(entry, maps.applicationsById, maps.connectionsById)}</span>
                )}
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                  onClick={() => onDeleteEntry(entry.id)}
                  aria-label={translateAgentPage("agents:delete_entry", { value1: entry.selectorType })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* Allow list */}
        <AllowList rows={rows} catalogLoading={catalogLoading} />
      </CardContent>
    </Card>
  );
}
