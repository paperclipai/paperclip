import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { STATUS_LABEL } from "./profiles/profile-summary";
import { toolRiskLabel, toolEntityLabel } from "./shared";
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
import { ApiError } from "@/api/client";
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
import {
  CapabilityBadges,
  ErrorState,
  LoadingState,
  RelativeTime,
  RiskBadge,
  ToolsPageHeader,
} from "./shared";

const SELECTOR_TYPES: Array<{ value: ToolProfileEntrySelectorType; label: string }> = [
  { value: "tool_name", get label() { return t("localizationTools.toolName400"); } },
  { value: "risk_level", get label() { return t("localizationTools.riskLevel212"); } },
  { value: "application", get label() { return t("localizationTools.application15"); } },
  { value: "connection", get label() { return t("localizationActivity.connection"); } },
  { value: "catalog_entry", get label() { return t("localizationTools.catalogEntryID402"); } },
];

const TARGET_TYPES: Array<{ value: ToolProfileBindingTargetType; label: string }> = [
  { value: "company", get label() { return t("localizationActivity.company"); } },
  { value: "agent", get label() { return t("localizationFilters.agent"); } },
  { value: "project", get label() { return t("pages.routines.project"); } },
  { value: "routine", get label() { return t("localizationActivity.routine"); } },
  { value: "issue", get label() { return t("localizationTools.issueID403"); } },
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
  if (entry.selectorType === "application") return applicationsById.get(entry.applicationId ?? "") ?? entry.applicationId ?? toolEntityLabel("application");
  if (entry.selectorType === "connection") return connectionsById.get(entry.connectionId ?? "") ?? entry.connectionId ?? toolEntityLabel("connection");
  if (entry.selectorType === "catalog_entry") return entry.catalogEntryId ?? t("localizationTools.catalogEntry404");
  if (entry.selectorType === "risk_level") return entry.riskLevel ? toolRiskLabel(entry.riskLevel) : t("localizationTools.riskLevel405");
  return entry.toolName ?? "tool";
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
  if (targetType === "company") return targetId === labels.companyId ? t("localizationActivity.company") : targetId;
  if (targetType === "agent") return labels.agentsById.get(targetId) ?? targetId;
  if (targetType === "project") return labels.projectsById.get(targetId) ?? targetId;
  if (targetType === "routine") return labels.routinesById.get(targetId) ?? targetId;
  return targetId;
}

/** Short, human subtitle for the master rail: prefers the agent count the spec calls for. */
function bindingsSubtitle(bindings: ToolProfileBinding[]): string {
  if (bindings.length === 0) return "unbound";
  const agents = bindings.filter((b) => b.targetType === "agent").length;
  if (agents === bindings.length) return t("localizationTools.boundAgents", { count: agents });
  return t("localizationTools.bindingCount", { count: bindings.length });
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
    return { kind: "pattern", label: t("localizationTools.appSelector", { name: applicationsById.get(entry.applicationId ?? "") ?? entry.applicationId ?? "?" }) };
  }
  if (entry.selectorType === "connection") {
    return { kind: "pattern", label: t("localizationTools.connectionSelector", { name: connectionsById.get(entry.connectionId ?? "") ?? entry.connectionId ?? "?" }) };
  }
  return { kind: "pattern", label: t("localizationTools.riskSource", { risk: toolRiskLabel(entry.riskLevel ?? "?") }) };
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
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-(--gtc-60)">
      <div className="space-y-1.5">
        <Label>{t("localizationTools.selector411")}</Label>
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
        <Label>{t("localizationTools.effect412")}</Label>
        <Select value={effect} onValueChange={(value) => setEffect(value as ToolProfileEntryEffect)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="include">{t("localizationTools.include413")}</SelectItem>
            <SelectItem value="exclude">{t("pages.decisions.exclude")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {selectorType === "application" ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label>{t("localizationTools.application15")}</Label>
          <Select value={applicationId} onValueChange={setApplicationId}>
            <SelectTrigger>
              <SelectValue placeholder={t("localizationTools.selectAnApplication19")} />
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
          <Label>{t("localizationActivity.connection")}</Label>
          <Select value={connectionId} onValueChange={setConnectionId}>
            <SelectTrigger>
              <SelectValue placeholder={t("localizationTools.selectAConnection414")} />
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
          <Label htmlFor="catalog-entry-id">{t("localizationTools.catalogEntryID402")}</Label>
          <Input id="catalog-entry-id" value={catalogEntryId} onChange={(event) => setCatalogEntryId(event.target.value)} />
        </div>
      ) : null}
      {selectorType === "tool_name" ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="tool-name">{t("localizationTools.toolName400")}</Label>
          <Input id="tool-name" value={toolName} onChange={(event) => setToolName(event.target.value)} placeholder={t("localizationTools.eGSendEmailOrSlackList415")} />
        </div>
      ) : null}
      {selectorType === "risk_level" ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label>{t("localizationTools.riskLevel212")}</Label>
          <Select value={riskLevel} onValueChange={(value) => setRiskLevel(value as ToolRiskLevel)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RISK_LEVELS.map((risk) => (
                <SelectItem key={risk} value={risk}>
                  {toolRiskLabel(risk)}
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
  const { t } = useTranslation();
  const [agentId, setAgentId] = useState("");
  const effective = useQuery({
    queryKey: agentId
      ? queryKeys.tools.effectiveProfilesForAgent(companyId, agentId)
      : ["tools", companyId, "profiles", "effective", "agent", "__none__"],
    queryFn: () => toolsApi.getEffectiveProfilesForAgent(companyId, agentId),
    enabled: Boolean(agentId),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="space-y-1.5">
        <Label>{t("localizationFilters.agent")}</Label>
        <AgentSelect agents={agentOptions} value={agentId} onChange={setAgentId} />
      </div>
      {!agentId ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">{t("localizationTools.pickAnAgentToSeeWhatItCanUseRightNow416")}</div>
      ) : effective.isLoading ? (
        <LoadingState label={t("localizationTools.checkingAccess417")} />
      ) : effective.error ? (
        <ErrorState error={effective.error} onRetry={() => effective.refetch()} />
      ) : (
        <div className="min-h-0 space-y-5 overflow-y-auto pr-1">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">{t("localizationTools.canUse418")}</h3>
              <span className="text-xs text-muted-foreground tabular-nums">
                {t("localizationApps.toolCount", { count: (effective.data?.allowedToolNames ?? []).length })}
              </span>
            </div>
            {(effective.data?.allowedToolNames ?? []).length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">{t("localizationTools.thisAgentCannotUseAnyAppToolsRightNow419")}</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(effective.data?.allowedToolNames ?? []).slice(0, 80).map((tool) => (
                  <Badge key={tool} variant="outline">{tool}</Badge>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{t("localizationTools.accessProfiles62")}</h3>
            {(effective.data?.profiles ?? []).length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">{t("localizationTools.noActiveProfileAppliesToThisAgent420")}</div>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {(effective.data?.profiles ?? []).map((profile) => (
                  <div key={profile.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">{profile.name}</span>
                    {profile.summary.isCompanyDefault ? (
                      <Badge variant="secondary">{t("pages.companySettings.policyOption.companyDefault")}</Badge>
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
  const { t } = useTranslation();
  if (source.kind === "explicit") {
    return <Badge variant="secondary">{t("localizationTools.explicit421")}</Badge>;
  }
  if (source.kind === "default") {
    return <Badge variant="outline">{t("localizationTools.defaultAllow422")}</Badge>;
  }
  return (
    <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400">
      <AlertTriangle className="h-3 w-3" />
      <span className="font-mono text-(length:--text-micro)">{t("localizationTools.pattern423")}{source.label}</span>
    </Badge>
  );
}

function AllowList({ rows, catalogLoading }: { rows: AllowListRow[]; catalogLoading: boolean }) {
  const { t } = useTranslation();
  const patternCount = rows.filter((r) => r.source.kind === "pattern").length;
  const explicitCount = rows.filter((r) => r.source.kind === "explicit").length;
  const defaultCount = rows.filter((r) => r.source.kind === "default").length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground">{t("localizationTools.allowList424")}</h4>
        <p className="text-xs text-muted-foreground">
          {t("localizationApps.toolCount", { count: rows.length })}
          {explicitCount > 0 ? t("localizationTools.explicitToolsSuffix", { count: explicitCount }) : ""}
          {patternCount > 0 ? t("localizationTools.patternToolsSuffix", { count: patternCount }) : ""}
          {defaultCount > 0 ? t("localizationTools.defaultToolsSuffix", { count: defaultCount }) : ""}
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          {catalogLoading
            ? t("localizationTools.resolvingAllowedTools429")
            : t("localizationTools.noToolsResolvedForThisProfileAddAnIncludeSele430")}
        </div>
      ) : (
        <Card>
          <CardContent className="px-0 py-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2.5 font-medium">{t("localizationApps.tool180")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("localizationTools.application15")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("pages.inviteLanding.agentForm.capabilities")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("localizationOperations.ui_Risk")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("localizationRoutines.source")}</th>
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
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
          <Trans i18nKey="localizationTools.patternToolHint" components={{ strong: <span className="font-medium" /> }} />
        </p>
      ) : null}
    </div>
  );
}

export function ProfilesTab({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
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
      pushToast({ title: t("localizationTools.profileCreated433"), tone: "success" });
    },
    onError: (error) => pushToast({
      title: t("localizationTools.couldNotCreateProfile434"),
      body: error instanceof ApiError ? error.message : String(error),
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
      pushToast({ title: t("localizationTools.profileUpdated102"), tone: "success" });
    },
    onError: (error) => pushToast({
      title: t("localizationTools.couldNotUpdateProfile103"),
      body: error instanceof ApiError ? error.message : String(error),
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
      pushToast({ title: t("localizationTools.entryAdded435"), tone: "success" });
    },
    onError: (error) => pushToast({
      title: t("localizationTools.couldNotAddEntry436"),
      body: error instanceof ApiError ? error.message : String(error),
      tone: "error",
    }),
  });

  const deleteEntry = useMutation({
    mutationFn: (entryId: string) => toolsApi.deleteProfileEntry(entryId),
    onSuccess: () => {
      invalidateProfiles();
      pushToast({ title: t("localizationTools.entryRemoved437"), tone: "success" });
    },
    onError: (error) => pushToast({
      title: t("localizationTools.couldNotRemoveEntry438"),
      body: error instanceof ApiError ? error.message : String(error),
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
      pushToast({ title: t("localizationTools.profileBound439"), tone: "success" });
    },
    onError: (error) => pushToast({
      title: t("localizationTools.couldNotBindProfile440"),
      body: error instanceof ApiError ? error.message : String(error),
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
      pushToast({ title: t("localizationTools.bindingRemoved441"), tone: "success" });
    },
    onError: (error) => pushToast({
      title: t("localizationTools.couldNotRemoveBinding442"),
      body: error instanceof ApiError ? error.message : String(error),
      tone: "error",
    }),
  });

  if (profiles.isLoading) return <LoadingState />;
  if (profiles.error) return <ErrorState error={profiles.error} onRetry={() => profiles.refetch()} />;

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
      pushToast({ title: t("localizationTools.entryTargetRequired443"), tone: "error" });
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
      pushToast({ title: t("localizationTools.bindingTargetRequired444"), tone: "error" });
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
        title={t("localizationTools.accessProfiles62")}
        description={t("localizationTools.reusableBundlesOfAllowedApplicationsConnectio445")}
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />{t("localizationTools.newProfile65")}</Button>
        }
      />

      <EffectiveAgentPanel companyId={companyId} agentOptions={agentOptions} />

      {list.length === 0 ? (
        <EmptyState
          icon={Layers}
          message={t("localizationTools.noAccessProfilesYet446")}
          description={t("localizationTools.createAProfileToGroupToolSelectorsThenBindItT447")}
          action={t("localizationTools.newProfile65")}
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
                              {STATUS_LABEL[profile.status]}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t("localizationApps.toolCount", { count: toolCount })} · {bindingsSubtitle(profile.bindings)}
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
            <DialogTitle>{editProfile ? t("account.editProfile") : t("localizationTools.newProfile65")}</DialogTitle>
            <DialogDescription>{t("localizationTools.profileRulesAreEnforcedByTheToolGatewayPolicy448")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="profile-name">{t("pages.apps.connect.nameLabel")}</Label>
                <Input
                  id="profile-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (!editProfile && !profileKey.trim()) setProfileKey(slugifyProfileKey(event.target.value));
                  }}
                  placeholder={t("localizationTools.engineeringWriteTools449")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="profile-key">{t("pages.caseDetail.key")}</Label>
                <Input id="profile-key" value={profileKey} onChange={(event) => setProfileKey(event.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-description">{t("pages.caseDetail.description")}</Label>
              <Textarea
                id="profile-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("localizationTools.optionalContextForReviewers450")}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("localizationTools.defaultAction451")}</Label>
                <Select value={defaultAction} onValueChange={(value) => setDefaultAction(value as ToolProfileDefaultAction)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="deny">{t("localizationTools.denyUnlessIncluded452")}</SelectItem>
                    <SelectItem value="allow">{t("localizationTools.allowUnlessExcluded453")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("pages.apps.connections.columnStatus")}</Label>
                <Select value={status} onValueChange={(value) => setStatus(value as ToolProfileStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">{t("status.active")}</SelectItem>
                    <SelectItem value="disabled">{t("pages.secrets.status.disabled")}</SelectItem>
                    <SelectItem value="archived">{t("status.archived")}</SelectItem>
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
            }}>{t("pages.apps.common.cancel")}</Button>
            <Button disabled={!name.trim() || createProfile.isPending || updateProfile.isPending} onClick={saveProfile}>
              {editProfile ? t("pages.apps.common.save") : createProfile.isPending ? t("pages.routines.creating") : t("common.create")}
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
            <DialogTitle>{t("localizationIssueDetail.mdxeditor.frontmatterEditor.addEntry")}</DialogTitle>
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
            <Button variant="outline" onClick={() => setEntryProfile(null)}>{t("pages.apps.common.cancel")}</Button>
            <Button disabled={addEntry.isPending} onClick={saveEntry}>{t("localizationIssueDetail.mdxeditor.frontmatterEditor.addEntry")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(bindProfileFor)} onOpenChange={(open) => {
        if (!open) setBindProfileFor(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("localizationTools.bindProfile456")}</DialogTitle>
            <DialogDescription>{bindProfileFor?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t("localizationTools.targetType457")}</Label>
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
                <Label>{t("localizationFilters.agent")}</Label>
                <AgentSelect agents={agentOptions} value={targetAgentId} onChange={setTargetAgentId} />
              </div>
            ) : null}
            {targetType === "project" ? (
              <div className="space-y-1.5">
                <Label>{t("pages.routines.project")}</Label>
                <Select value={targetProjectId} onValueChange={setTargetProjectId}>
                  <SelectTrigger><SelectValue placeholder={t("localizationTools.selectAProject458")} /></SelectTrigger>
                  <SelectContent>
                    {projectOptions.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {targetType === "routine" ? (
              <div className="space-y-1.5">
                <Label>{t("localizationActivity.routine")}</Label>
                <Select value={targetRoutineId} onValueChange={setTargetRoutineId}>
                  <SelectTrigger><SelectValue placeholder={t("localizationTools.selectARoutine459")} /></SelectTrigger>
                  <SelectContent>
                    {routineOptions.map((routine) => <SelectItem key={routine.id} value={routine.id}>{routine.title}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {targetType === "issue" ? (
              <div className="space-y-1.5">
                <Label htmlFor="target-issue-id">{t("localizationTools.issueID403")}</Label>
                <Input id="target-issue-id" value={targetIssueId} onChange={(event) => setTargetIssueId(event.target.value)} />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="profile-priority">{t("localizationFilters.priority")}</Label>
              <Input id="profile-priority" type="number" min={0} max={10000} value={priority} onChange={(event) => setPriority(event.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBindProfileFor(null)}>{t("pages.apps.common.cancel")}</Button>
            <Button disabled={bind.isPending} onClick={saveBinding}>{t("localizationTools.bind461")}</Button>
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
  const { t } = useTranslation();
  const rows = useMemo(
    () => resolveAllowList(profile, catalog, maps.applicationsById, maps.connectionsById),
    [profile, catalog, maps.applicationsById, maps.connectionsById, t],
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
              <Badge variant={statusVariant(profile.status)}>{STATUS_LABEL[profile.status]}</Badge>
              <Badge variant={profile.defaultAction === "allow" ? "secondary" : "outline"}>{t("localizationTools.defaultActionLabel", { action: toolEntityLabel(profile.defaultAction) })}
              </Badge>
            </div>
            {profile.description ? (
              <p className="mt-1 text-sm text-muted-foreground">{profile.description}</p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground"><Trans i18nKey="localizationTools.updatedTime" components={{ time: <RelativeTime value={profile.updatedAt} /> }} />
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil className="mr-1 h-3.5 w-3.5" />{t("common.edit")}</Button>
            <Button size="sm" variant="outline" onClick={onAddEntry}>
              <Plus className="mr-1 h-3.5 w-3.5" />{t("localizationTools.entry464")}</Button>
            <Button size="sm" variant="outline" onClick={onBind}>
              <Link2 className="mr-1 h-3.5 w-3.5" />{t("localizationTools.bind461")}</Button>
          </div>
        </div>

        {/* Targets */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-foreground">{t("localizationTools.targets465")}</h4>
          <div className="flex flex-wrap gap-2">
            {profile.bindings.length === 0 ? (
              <span className="text-sm text-muted-foreground">{t("localizationTools.noTargetsBound466")}</span>
            ) : profile.bindings.map((binding) => (
              <span key={binding.id} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                <Badge variant="outline">{toolEntityLabel(binding.targetType)}</Badge>
                <span>{bindingLabel(binding.targetType, binding.targetId, { companyId, ...maps })}</span>
                <span className="text-muted-foreground">p{binding.priority}</span>
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                  onClick={() => onUnbind(binding)}
                  aria-label={t("localizationTools.removeTypedBinding", { type: toolEntityLabel(binding.targetType) })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* Effective scope summary */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-foreground">{t("localizationTools.effectiveScope468")}</h4>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-md border border-border px-2 py-1 text-muted-foreground"><Trans i18nKey="localizationTools.defaultActionMetric" values={{ action: toolEntityLabel(profile.defaultAction) }} components={{ strong: <span className="font-medium text-foreground" /> }} />
            </span>
            <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">
              <Trans i18nKey="localizationTools.toolsAllowedMetric" count={rows.length} components={{ strong: <span className="font-medium text-foreground" /> }} />
            </span>
            <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">
              <Trans i18nKey="localizationTools.includeExcludeMetric" values={{ include: includeCount, exclude: excludeCount }} components={{ include: <span className="font-medium text-foreground" />, exclude: <span className="font-medium text-foreground" /> }} />
            </span>
          </div>
        </div>

        {/* Selectors (entry management) */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-foreground">{t("localizationTools.selectors473")}</h4>
          <div className="flex flex-wrap gap-2">
            {profile.entries.length === 0 ? (
              <span className="text-sm text-muted-foreground">{t("localizationTools.noSelectors474")}</span>
            ) : profile.entries.map((entry) => (
              <span key={entry.id} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                <Badge variant={entry.effect === "include" ? "secondary" : "destructive"}>{toolEntityLabel(entry.effect)}</Badge>
                <span className="font-mono">{toolEntityLabel(entry.selectorType)}</span>
                {entry.selectorType === "risk_level" ? <RiskBadge risk={entry.riskLevel} /> : (
                  <span className="max-w-64 truncate">{entryLabel(entry, maps.applicationsById, maps.connectionsById)}</span>
                )}
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                  onClick={() => onDeleteEntry(entry.id)}
                  aria-label={t("localizationTools.deleteTypedEntry", { type: toolEntityLabel(entry.selectorType) })}
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
