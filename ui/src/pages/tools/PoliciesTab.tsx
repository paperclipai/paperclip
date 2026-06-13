import { useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Copy,
  FlaskConical,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Shield,
  Trash2,
} from "lucide-react";
import {
  humanizeConnectionDisplayName,
  type ToolAccessDecision,
  type ToolCatalogEntry,
  type ToolPolicy,
  type ToolPolicyType,
  type ToolRiskLevel,
} from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useToast } from "@/context/ToastContext";
import { EmptyState } from "@/components/EmptyState";
import {
  ToolsPageHeader,
  LoadingState,
  ErrorState,
  DecisionBadge,
  RelativeTime,
} from "./shared";
import { groupCatalogByApp, type AppGroup } from "./profiles/profile-model";

const ANY_VALUE = "__any__";

type BuilderPolicyType = Exclude<ToolPolicyType, "trust_rule">;
type ActorTypeValue = "agent" | "user" | "system" | "plugin";
type RateLimitKeyBy = "company" | "agent" | "application" | "connection" | "tool";
type WhenMode = "everyone" | "agent" | "project";
type UsesMode = "anything" | "app" | "actions" | "capability";

const RISK_LEVELS: ToolRiskLevel[] = ["read", "write", "destructive", "low", "medium", "high", "critical"];
const RATE_LIMIT_KEY_FIELDS: RateLimitKeyBy[] = ["company", "agent", "application", "connection", "tool"];
const CAPABILITY_OPTIONS: Array<{ value: ToolRiskLevel; label: string; sentence: string }> = [
  { value: "read", label: "Read-only", sentence: "read-only actions" },
  { value: "write", label: "Makes changes", sentence: "actions that make changes" },
  { value: "destructive", label: "Destructive", sentence: "destructive actions" },
];
const OUTCOMES: Array<{ value: BuilderPolicyType; label: string }> = [
  { value: "allow", label: "Allow" },
  { value: "block", label: "Block" },
  { value: "require_approval", label: "Ask first" },
  { value: "rate_limit", label: "Limit" },
  { value: "redact", label: "Hide sensitive details" },
];

type PolicyFormState = {
  id: string | null;
  name: string;
  description: string;
  policyType: BuilderPolicyType;
  priority: string;
  enabled: boolean;
  whenMode: WhenMode;
  usesMode: UsesMode;
  actorType: typeof ANY_VALUE | ActorTypeValue;
  agentId: string;
  projectId: string;
  applicationId: string;
  connectionId: string;
  riskLevel: string;
  toolNames: string;
  rateLimitLimit: string;
  rateLimitWindowSeconds: string;
  rateLimitKeyBy: RateLimitKeyBy[];
  redactFields: string;
  conditionsJson: string;
  configJson: string;
};

type ConfirmState =
  | { kind: "delete-rule"; policy: ToolPolicy; hits: number }
  | { kind: "forget-approval"; policy: ToolPolicy }
  | null;

function emptyPolicyForm(template?: Partial<PolicyFormState>): PolicyFormState {
  return {
    id: null,
    name: "",
    description: "",
    policyType: "require_approval",
    priority: "100",
    enabled: true,
    whenMode: "everyone",
    usesMode: "anything",
    actorType: ANY_VALUE,
    agentId: ANY_VALUE,
    projectId: ANY_VALUE,
    applicationId: ANY_VALUE,
    connectionId: ANY_VALUE,
    riskLevel: ANY_VALUE,
    toolNames: "",
    rateLimitLimit: "50",
    rateLimitWindowSeconds: "3600",
    rateLimitKeyBy: ["agent", "tool"],
    redactFields: "",
    conditionsJson: "",
    configJson: "",
    ...template,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function selectValue(selectors: Record<string, unknown>, key: string) {
  const value = selectors[key];
  return typeof value === "string" && value.trim() ? value : ANY_VALUE;
}

function formatJson(value: unknown) {
  return isRecord(value) && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : "";
}

function parseJsonObject(value: string, label: string): Record<string, unknown> | null {
  if (!value.trim()) return null;
  const parsed = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function policyToForm(policy: ToolPolicy): PolicyFormState {
  const selectors = policy.selectors ?? {};
  const toolNames = [
    ...stringList(selectors.toolName),
    ...stringList(selectors.toolNames),
  ].join(", ");
  const config = isRecord(policy.config) ? { ...policy.config } : {};
  const rawRateLimit = isRecord(config.rateLimit) ? config.rateLimit : config;
  const rawRedact = isRecord(config.redact) ? config.redact : {};
  const rateLimitKeyBy = stringList(rawRateLimit.keyBy).filter((item): item is RateLimitKeyBy =>
    RATE_LIMIT_KEY_FIELDS.includes(item as RateLimitKeyBy),
  );
  if (policy.policyType === "rate_limit") delete config.rateLimit;
  if (policy.policyType === "redact") delete config.redact;
  const agentId = selectValue(selectors, "agentId");
  const projectId = selectValue(selectors, "projectId");
  const applicationId = selectValue(selectors, "applicationId");
  const riskLevel = selectValue(selectors, "riskLevel");

  return {
    ...emptyPolicyForm(),
    id: policy.id,
    name: policy.name,
    description: policy.description ?? "",
    policyType: policy.policyType as BuilderPolicyType,
    priority: String(policy.priority),
    enabled: policy.enabled,
    whenMode: agentId !== ANY_VALUE ? "agent" : projectId !== ANY_VALUE ? "project" : "everyone",
    usesMode:
      toolNames.length > 0
        ? "actions"
        : applicationId !== ANY_VALUE
          ? "app"
          : riskLevel !== ANY_VALUE
            ? "capability"
            : "anything",
    actorType: selectValue(selectors, "actorType") as PolicyFormState["actorType"],
    agentId,
    projectId,
    applicationId,
    connectionId: selectValue(selectors, "connectionId"),
    riskLevel,
    toolNames,
    rateLimitLimit: String(rawRateLimit.limit ?? "50"),
    rateLimitWindowSeconds: String(rawRateLimit.windowSeconds ?? "3600"),
    rateLimitKeyBy: rateLimitKeyBy.length > 0 ? rateLimitKeyBy : ["agent", "tool"],
    redactFields: stringList(rawRedact.fields).join(", "),
    conditionsJson: formatJson(policy.conditions),
    configJson: formatJson(config),
  };
}

function buildPolicyPayload(form: PolicyFormState) {
  const priority = Number(form.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 10000) {
    throw new Error("Priority must be an integer from 0 to 10000");
  }
  const selectors: Record<string, unknown> = {};
  if (form.actorType !== ANY_VALUE) selectors.actorType = form.actorType;
  if (form.whenMode === "agent" && form.agentId !== ANY_VALUE) selectors.agentId = form.agentId;
  if (form.whenMode === "project" && form.projectId !== ANY_VALUE) selectors.projectId = form.projectId;
  if (form.usesMode === "app" && form.applicationId !== ANY_VALUE) selectors.applicationId = form.applicationId;
  if (form.connectionId !== ANY_VALUE) selectors.connectionId = form.connectionId;
  if (form.usesMode === "capability" && form.riskLevel !== ANY_VALUE) selectors.riskLevel = form.riskLevel;
  const toolNames = form.usesMode === "actions" ? parseList(form.toolNames) : [];
  if (toolNames.length === 1) selectors.toolName = toolNames[0];
  if (toolNames.length > 1) selectors.toolNames = toolNames;

  const conditions = parseJsonObject(form.conditionsJson, "Conditions JSON");
  const config = parseJsonObject(form.configJson, "Config JSON") ?? {};
  if (form.policyType === "rate_limit") {
    const limit = Number(form.rateLimitLimit);
    const windowSeconds = Number(form.rateLimitWindowSeconds);
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("Limit must be a positive integer");
    if (!Number.isInteger(windowSeconds) || windowSeconds <= 0) {
      throw new Error("Window must be a positive number of seconds");
    }
    config.rateLimit = { limit, windowSeconds, keyBy: form.rateLimitKeyBy };
  }
  if (form.policyType === "redact") {
    const fields = parseList(form.redactFields);
    if (fields.length > 0) config.redact = { fields };
  }

  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    policyType: form.policyType,
    priority,
    enabled: form.enabled,
    selectors,
    conditions,
    config: Object.keys(config).length > 0 ? config : null,
  };
}

function windowLabel(seconds: string | number | null | undefined) {
  const value = Number(seconds);
  if (value === 3600) return "hour";
  if (value === 86400) return "day";
  if (value === 60) return "minute";
  return `${Number.isFinite(value) && value > 0 ? value : 3600}s`;
}

function outcomeLabel(policy: Pick<ToolPolicy, "policyType" | "config"> | PolicyFormState) {
  const policyType = policy.policyType;
  if (policyType === "allow") return "Allow";
  if (policyType === "block") return "Block";
  if (policyType === "require_approval") return "Ask first";
  if (policyType === "redact") return "Hide sensitive details";
  if (policyType === "trust_rule") return "Allow";
  if (policyType === "validate") return "Custom check";
  const config = "config" in policy && isRecord(policy.config) ? policy.config : {};
  const rateLimit = isRecord(config.rateLimit) ? config.rateLimit : config;
  const limit = "rateLimitLimit" in policy ? policy.rateLimitLimit : rateLimit.limit;
  const seconds = "rateLimitWindowSeconds" in policy ? policy.rateLimitWindowSeconds : rateLimit.windowSeconds;
  return `Limit to ${limit ?? 50}/${windowLabel(seconds as string | number | null | undefined)}`;
}

function capabilitySentence(value: string | null | undefined) {
  return CAPABILITY_OPTIONS.find((item) => item.value === value)?.sentence ?? `${value} actions`;
}

function toolDisplayName(toolName: string, catalogByToolName: Map<string, ToolCatalogEntry>) {
  const tool = catalogByToolName.get(toolName);
  return humanizeConnectionDisplayName(toolName, { title: tool?.title || undefined });
}

function policySentence(
  policy: Pick<ToolPolicy, "policyType" | "selectors" | "config">,
  maps: LookupMaps,
  catalogByToolName: Map<string, ToolCatalogEntry>,
) {
  const selectors = policy.selectors ?? {};
  const agentIds = [...stringList(selectors.agentId), ...stringList(selectors.agentIds)];
  const projectIds = [...stringList(selectors.projectId), ...stringList(selectors.projectIds)];
  const appIds = [...stringList(selectors.applicationId), ...stringList(selectors.applicationIds)];
  const connectionIds = [...stringList(selectors.connectionId), ...stringList(selectors.connectionIds)];
  const catalogEntryIds = [...stringList(selectors.catalogEntryId), ...stringList(selectors.catalogEntryIds)];
  const tools = [...stringList(selectors.toolName), ...stringList(selectors.toolNames)];
  const risk = selectValue(selectors, "riskLevel");
  const actorType = selectValue(selectors, "actorType");
  const catalogById = new Map([...catalogByToolName.values()].map((tool) => [tool.id, tool]));

  let who = "any agent";
  if (agentIds.length === 1) who = maps.agent.get(agentIds[0]!) ?? "one agent";
  else if (agentIds.length > 1) who = `${agentIds.length} agents`;
  else if (projectIds.length === 1) who = `agents in ${maps.project.get(projectIds[0]!) ?? "one project"}`;
  else if (projectIds.length > 1) who = `agents in ${projectIds.length} projects`;
  else if (actorType !== ANY_VALUE && actorType !== "agent") who = `${actorType}s`;

  let uses = "anything";
  if (tools.length === 1) uses = toolDisplayName(tools[0]!, catalogByToolName);
  else if (tools.length > 1) uses = `${tools.length} specific actions`;
  else if (catalogEntryIds.length === 1) {
    const tool = catalogById.get(catalogEntryIds[0]!);
    uses = tool ? tool.title || toolDisplayName(tool.toolName, catalogByToolName) : "one action";
  }
  else if (catalogEntryIds.length > 1) uses = `${catalogEntryIds.length} specific actions`;
  else if (appIds.length === 1) uses = maps.application.get(appIds[0]!) ?? "one app";
  else if (appIds.length > 1) uses = `${appIds.length} apps`;
  else if (connectionIds.length === 1) uses = maps.connection.get(connectionIds[0]!) ?? "one app";
  else if (risk !== ANY_VALUE) uses = capabilitySentence(risk);

  return { who, uses, outcome: outcomeLabel(policy) };
}

function formSentence(form: PolicyFormState, maps: LookupMaps, catalogByToolName: Map<string, ToolCatalogEntry>) {
  const payload = buildPreviewSelectors(form);
  return policySentence(
    { policyType: form.policyType, selectors: payload, config: buildPreviewConfig(form) },
    maps,
    catalogByToolName,
  );
}

function buildPreviewSelectors(form: PolicyFormState) {
  const selectors: Record<string, unknown> = {};
  if (form.actorType !== ANY_VALUE) selectors.actorType = form.actorType;
  if (form.whenMode === "agent" && form.agentId !== ANY_VALUE) selectors.agentId = form.agentId;
  if (form.whenMode === "project" && form.projectId !== ANY_VALUE) selectors.projectId = form.projectId;
  if (form.usesMode === "app" && form.applicationId !== ANY_VALUE) selectors.applicationId = form.applicationId;
  if (form.usesMode === "capability" && form.riskLevel !== ANY_VALUE) selectors.riskLevel = form.riskLevel;
  const toolNames = form.usesMode === "actions" ? parseList(form.toolNames) : [];
  if (toolNames.length === 1) selectors.toolName = toolNames[0];
  if (toolNames.length > 1) selectors.toolNames = toolNames;
  return selectors;
}

function buildPreviewConfig(form: PolicyFormState) {
  if (form.policyType === "rate_limit") {
    return { rateLimit: { limit: form.rateLimitLimit, windowSeconds: form.rateLimitWindowSeconds } };
  }
  return null;
}

function sentenceText(sentence: ReturnType<typeof policySentence>) {
  return `When ${sentence.who} uses ${sentence.uses} -> ${sentence.outcome}`;
}

function OutcomeChip({ type, config }: { type: BuilderPolicyType | ToolPolicyType; config?: Record<string, unknown> | null }) {
  const label = outcomeLabel({ policyType: type, config: config ?? null });
  const variant =
    type === "block"
      ? "destructive"
      : type === "require_approval" || type === "rate_limit"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{label}</Badge>;
}

type LookupMaps = {
  agent: Map<string, string>;
  project: Map<string, string>;
  application: Map<string, string>;
  connection: Map<string, string>;
};

function RuleSentence({ sentence }: { sentence: ReturnType<typeof policySentence> }) {
  return (
    <span>
      When <strong>{sentence.who}</strong> uses <strong>{sentence.uses}</strong> -&gt;{" "}
      <strong>{sentence.outcome}</strong>
    </span>
  );
}

function PolicySimulator({
  companyId,
  agents,
  policies,
  maps,
  catalogByToolName,
  open,
  onOpenChange,
  onEditPolicy,
}: {
  companyId: string;
  agents: Array<{ id: string; name: string }>;
  policies: ToolPolicy[];
  maps: LookupMaps;
  catalogByToolName: Map<string, ToolCatalogEntry>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEditPolicy: (policy: ToolPolicy) => void;
}) {
  const { pushToast } = useToast();
  const [agentId, setAgentId] = useState<string>("");
  const [toolName, setToolName] = useState("");
  const [result, setResult] = useState<ToolAccessDecision | null>(null);

  const test = useMutation({
    mutationFn: () =>
      toolsApi.testPolicy(companyId, {
        actor: { actorType: "agent", actorId: agentId, agentId },
        request: { toolName: toolName.trim() },
      }),
    onSuccess: (res) => setResult(res.decision),
    onError: (err) => {
      setResult(null);
      pushToast({
        title: "Rule test failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      });
    },
  });

  const decidingPolicy = result?.matchedPolicyIds[0]
    ? policies.find((policy) => policy.id === result.matchedPolicyIds[0])
    : null;
  const verdict = result
    ? `${outcomeLabel({ policyType: result.decision as ToolPolicyType, config: null })} - ${
        decidingPolicy ? `rule ${policies.findIndex((policy) => policy.id === decidingPolicy.id) + 1}` : result.explanation
      }`
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border">
          <SheetTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="h-4 w-4" />
            Test a rule
          </SheetTitle>
          <SheetDescription>Pick an agent and an action to see what Paperclip would do.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Agent</Label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="test-action">Action</Label>
              <Input
                id="test-action"
                value={toolName}
                onChange={(e) => setToolName(e.target.value)}
                placeholder="e.g. gmail.send_email"
              />
            </div>
          </div>
          <Button size="sm" disabled={!agentId || !toolName.trim() || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? "Checking..." : "Check rule"}
          </Button>

          {result ? (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{verdict}</p>
                {decidingPolicy ? (
                  <button
                    type="button"
                    className="text-left text-sm text-muted-foreground hover:text-foreground"
                    onClick={() => onEditPolicy(decidingPolicy)}
                  >
                    <RuleSentence sentence={policySentence(decidingPolicy, maps, catalogByToolName)} />
                  </button>
                ) : (
                  <p className="text-sm text-muted-foreground">{result.explanation}</p>
                )}
              </div>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer text-foreground">Details</summary>
                <div className="mt-2 space-y-1 font-mono">
                  <div>reason: {result.reasonCode}</div>
                  <div>matched rule ids: {result.matchedPolicyIds.length ? result.matchedPolicyIds.join(", ") : "none"}</div>
                  <div>effective profiles: {result.effectiveProfileIds.length ? result.effectiveProfileIds.join(", ") : "none"}</div>
                </div>
              </details>
            </div>
          ) : null}
        </div>
        <SheetFooter className="border-t border-border">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function RuleBuilder({
  form,
  setForm,
  maps,
  agents,
  projects,
  applications,
  appGroups,
  catalogByToolName,
  saving,
  onCancel,
  onSave,
}: {
  form: PolicyFormState;
  setForm: (form: PolicyFormState) => void;
  maps: LookupMaps;
  agents: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
  applications: Array<{ id: string; name: string }>;
  appGroups: AppGroup[];
  catalogByToolName: Map<string, ToolCatalogEntry>;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const sentence = formSentence(form, maps, catalogByToolName);
  const selectedTools = new Set(parseList(form.toolNames));
  const setToolNames = (next: Set<string>) => setForm({ ...form, usesMode: "actions", toolNames: [...next].sort().join(", ") });
  const toggleTool = (toolName: string) => {
    const next = new Set(selectedTools);
    if (next.has(toolName)) next.delete(toolName);
    else next.add(toolName);
    setToolNames(next);
  };
  const toggleGroup = (group: AppGroup) => {
    const next = new Set(selectedTools);
    const allSelected = group.tools.every((tool) => next.has(tool.toolName));
    for (const tool of group.tools) {
      if (allSelected) next.delete(tool.toolName);
      else next.add(tool.toolName);
    }
    setToolNames(next);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Button variant="ghost" size="sm" className="px-0" onClick={onCancel}>
            Back to rules
          </Button>
          <h2 className="text-lg font-semibold text-foreground">{form.id ? "Edit rule" : "New rule"}</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={onSave} disabled={saving}>
            {saving ? "Saving..." : "Save rule"}
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm">
        <RuleSentence sentence={sentence} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr]">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">When</h3>
          <div className="grid gap-2">
            {[
              ["everyone", "Everyone"],
              ["agent", "Specific agent"],
              ["project", "Agents in a project"],
            ].map(([value, label]) => (
              <Button
                key={value}
                variant={form.whenMode === value ? "secondary" : "outline"}
                size="sm"
                className="justify-start"
                onClick={() => setForm({ ...form, whenMode: value as WhenMode })}
              >
                {label}
              </Button>
            ))}
          </div>
          {form.whenMode === "agent" ? (
            <Select value={form.agentId} onValueChange={(agentId) => setForm({ ...form, agentId })}>
              <SelectTrigger><SelectValue placeholder="Choose agent" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_VALUE}>Choose agent</SelectItem>
                {agents.map((agent) => <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
          {form.whenMode === "project" ? (
            <Select value={form.projectId} onValueChange={(projectId) => setForm({ ...form, projectId })}>
              <SelectTrigger><SelectValue placeholder="Choose project" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_VALUE}>Choose project</SelectItem>
                {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Uses</h3>
          <div className="grid gap-2">
            {[
              ["anything", "Anything"],
              ["app", "A specific app"],
              ["actions", "Specific actions"],
              ["capability", "Actions by capability"],
            ].map(([value, label]) => (
              <Button
                key={value}
                variant={form.usesMode === value ? "secondary" : "outline"}
                size="sm"
                className="justify-start"
                onClick={() => setForm({ ...form, usesMode: value as UsesMode })}
              >
                {label}
              </Button>
            ))}
          </div>
          {form.usesMode === "app" ? (
            <Select value={form.applicationId} onValueChange={(applicationId) => setForm({ ...form, applicationId })}>
              <SelectTrigger><SelectValue placeholder="Choose app" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_VALUE}>Choose app</SelectItem>
                {applications.map((app) => <SelectItem key={app.id} value={app.id}>{app.name}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
          {form.usesMode === "capability" ? (
            <Select value={form.riskLevel} onValueChange={(riskLevel) => setForm({ ...form, riskLevel })}>
              <SelectTrigger><SelectValue placeholder="Choose capability" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_VALUE}>Choose capability</SelectItem>
                {CAPABILITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {form.usesMode === "actions" ? (
            <div className="max-h-80 overflow-y-auto rounded-md border border-border">
              {appGroups.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground">No app actions discovered yet.</div>
              ) : (
                appGroups.map((group) => {
                  const selectedCount = group.tools.filter((tool) => selectedTools.has(tool.toolName)).length;
                  return (
                    <div key={group.appKey} className="border-b border-border last:border-b-0">
                      <label className="flex items-center gap-2 px-3 py-2 text-sm font-medium">
                        <Checkbox
                          checked={selectedCount === group.tools.length ? true : selectedCount > 0 ? "indeterminate" : false}
                          onCheckedChange={() => toggleGroup(group)}
                        />
                        <span className="flex-1">{group.name}</span>
                        <span className="text-xs text-muted-foreground">{selectedCount} of {group.tools.length}</span>
                      </label>
                      <div className="pb-2 pl-8 pr-3">
                        {group.tools.map((tool) => (
                          <label key={tool.id} className="flex items-center gap-2 py-1 text-sm">
                            <Checkbox checked={selectedTools.has(tool.toolName)} onCheckedChange={() => toggleTool(tool.toolName)} />
                            <span className="min-w-0 flex-1 truncate">{tool.title || toolDisplayName(tool.toolName, catalogByToolName)}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : null}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Then</h3>
          <div className="grid gap-2">
            {OUTCOMES.map((outcome) => (
              <Button
                key={outcome.value}
                variant={form.policyType === outcome.value ? "secondary" : "outline"}
                size="sm"
                className="justify-start"
                onClick={() => setForm({ ...form, policyType: outcome.value })}
              >
                {outcome.label}
              </Button>
            ))}
          </div>
          {form.policyType === "rate_limit" ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="limit-count">Times</Label>
                <Input id="limit-count" inputMode="numeric" value={form.rateLimitLimit} onChange={(e) => setForm({ ...form, rateLimitLimit: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Per</Label>
                <Select value={form.rateLimitWindowSeconds} onValueChange={(rateLimitWindowSeconds) => setForm({ ...form, rateLimitWindowSeconds })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3600">Hour</SelectItem>
                    <SelectItem value="86400">Day</SelectItem>
                    <SelectItem value="60">Minute</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}
          {form.policyType === "redact" ? (
            <div className="space-y-1.5">
              <Label htmlFor="redact-fields">Details to hide</Label>
              <Input id="redact-fields" value={form.redactFields} onChange={(e) => setForm({ ...form, redactFields: e.target.value })} placeholder="email, phone, apiKey" />
            </div>
          ) : null}
        </section>
      </div>

      <details className="rounded-md border border-border p-3">
        <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-foreground">
          <ChevronDown className="h-4 w-4" />
          Advanced
        </summary>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="rule-name">Rule name</Label>
            <Input id="rule-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={sentenceText(sentence)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-priority">Priority</Label>
            <Input id="rule-priority" inputMode="numeric" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Custom check</Label>
            <Button
              type="button"
              variant={form.policyType === "validate" ? "secondary" : "outline"}
              size="sm"
              className="w-full justify-start"
              onClick={() => setForm({ ...form, policyType: "validate" })}
            >
              Use a custom check
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label>Raw connection</Label>
            <Select value={form.connectionId} onValueChange={(connectionId) => setForm({ ...form, connectionId })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_VALUE}>Any connection</SelectItem>
                {[...maps.connection.entries()].map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 lg:col-span-2">
            <Label htmlFor="tool-patterns">Wildcard action names</Label>
            <Input id="tool-patterns" value={form.toolNames} onChange={(e) => setForm({ ...form, usesMode: "actions", toolNames: e.target.value })} placeholder="gmail.*, slack.post_message" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="conditions-json">Conditions JSON</Label>
            <Textarea id="conditions-json" value={form.conditionsJson} onChange={(e) => setForm({ ...form, conditionsJson: e.target.value })} className="min-h-28 font-mono text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="config-json">Config JSON</Label>
            <Textarea id="config-json" value={form.configJson} onChange={(e) => setForm({ ...form, configJson: e.target.value })} className="min-h-28 font-mono text-xs" />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 lg:col-span-2">
            <div>
              <p className="text-sm font-medium text-foreground">On</p>
              <p className="text-xs text-muted-foreground">Turn this off to keep the rule saved without matching.</p>
            </div>
            <ToggleSwitch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
          </div>
        </div>
      </details>
    </div>
  );
}

function StarterCards({ onStart }: { onStart: (form: PolicyFormState) => void }) {
  const starters = [
    {
      title: "Block destructive actions everywhere",
      form: emptyPolicyForm({ policyType: "block", usesMode: "capability", riskLevel: "destructive", name: "Block destructive actions everywhere" }),
    },
    {
      title: "Ask first before anything sends or deletes",
      form: emptyPolicyForm({ policyType: "require_approval", usesMode: "actions", toolNames: "*send*, *delete*", name: "Ask first before sends or deletes" }),
    },
    {
      title: "Limit a noisy action",
      form: emptyPolicyForm({ policyType: "rate_limit", usesMode: "actions", rateLimitLimit: "50", name: "Limit a noisy action" }),
    },
    { title: "Start from scratch", form: emptyPolicyForm() },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {starters.map((starter) => (
        <button
          key={starter.title}
          type="button"
          className="rounded-md border border-border p-4 text-left text-sm hover:bg-muted/50"
          onClick={() => onStart(starter.form)}
        >
          <span className="font-medium text-foreground">{starter.title}</span>
        </button>
      ))}
    </div>
  );
}

export function PoliciesTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [form, setForm] = useState<PolicyFormState | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [draggingPolicyId, setDraggingPolicyId] = useState<string | null>(null);
  const draggingPolicyIdRef = useRef<string | null>(null);

  const policies = useQuery({
    queryKey: queryKeys.tools.policies(companyId),
    queryFn: () => toolsApi.listPolicies(companyId),
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const projects = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const applications = useQuery({
    queryKey: queryKeys.tools.applications(companyId),
    queryFn: () => toolsApi.listApplications(companyId),
  });
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });
  const connectionList = connections.data?.connections ?? [];
  const catalogQueries = useQueries({
    queries: connectionList.map((connection) => ({
      queryKey: queryKeys.tools.catalog(connection.id),
      queryFn: () => toolsApi.listCatalog(connection.id),
      staleTime: 60_000,
    })),
  });
  const trustRules = useQuery({
    queryKey: queryKeys.tools.trustRules(companyId),
    queryFn: () => toolsApi.listTrustRules(companyId),
  });
  const audit = useQuery({
    queryKey: queryKeys.tools.audit(companyId, 250),
    queryFn: () => toolsApi.listAudit(companyId, 250),
  });

  const catalog = useMemo(() => catalogQueries.flatMap((query) => query.data?.catalog ?? []), [catalogQueries]);
  const maps = useMemo<LookupMaps>(() => ({
    agent: new Map((agents.data ?? []).map((item) => [item.id, item.name])),
    project: new Map((projects.data ?? []).map((item) => [item.id, item.name])),
    application: new Map((applications.data?.applications ?? []).map((item) => [item.id, humanizeConnectionDisplayName(item.name)])),
    connection: new Map(connectionList.map((item) => [item.id, humanizeConnectionDisplayName(item)])),
  }), [agents.data, applications.data, connectionList, projects.data]);
  const appGroups = useMemo(
    () => groupCatalogByApp(catalog, maps.application, maps.connection),
    [catalog, maps.application, maps.connection],
  );
  const catalogByToolName = useMemo(
    () => new Map(catalog.map((tool) => [tool.toolName, tool])),
    [catalog],
  );

  const hitsByPolicy = useMemo(() => {
    const counts = new Map<string, number>();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const row of audit.data ?? []) {
      const ts = new Date(row.createdAt).getTime();
      if (Number.isFinite(ts) && ts < cutoff) continue;
      const matched = row.details?.matchedPolicyIds;
      if (Array.isArray(matched)) {
        for (const id of matched) {
          if (typeof id === "string") counts.set(id, (counts.get(id) ?? 0) + 1);
        }
      }
    }
    return counts;
  }, [audit.data]);

  const policyList = policies.data?.policies ?? [];
  const invalidatePolicies = () => qc.invalidateQueries({ queryKey: queryKeys.tools.policies(companyId) });
  const invalidateTrustRules = () => qc.invalidateQueries({ queryKey: queryKeys.tools.trustRules(companyId) });

  const createPolicy = useMutation({
    mutationFn: (input: ReturnType<typeof buildPolicyPayload>) => toolsApi.createPolicy(companyId, input),
    onSuccess: () => {
      invalidatePolicies();
      setForm(null);
      pushToast({ title: "Rule created", tone: "success" });
    },
    onError: (err) => pushToast({ title: "Could not save rule", body: err instanceof ApiError ? err.message : String(err), tone: "error" }),
  });
  const updatePolicy = useMutation({
    mutationFn: (input: { policyId: string; body: Partial<ReturnType<typeof buildPolicyPayload>> }) =>
      toolsApi.updatePolicy(companyId, input.policyId, input.body),
    onSuccess: () => {
      invalidatePolicies();
      setForm(null);
      pushToast({ title: "Rule updated", tone: "success" });
    },
    onError: (err) => pushToast({ title: "Could not save rule", body: err instanceof ApiError ? err.message : String(err), tone: "error" }),
  });
  const reorder = useMutation({
    mutationFn: (policyIds: string[]) => toolsApi.reorderPolicies(companyId, { policyIds }),
    onSuccess: () => {
      invalidatePolicies();
      pushToast({ title: "Rules reordered", tone: "success" });
    },
    onError: (err) => pushToast({ title: "Could not reorder rules", body: err instanceof ApiError ? err.message : String(err), tone: "error" }),
  });
  const duplicate = useMutation({
    mutationFn: (policy: ToolPolicy) => toolsApi.duplicatePolicy(companyId, policy.id),
    onSuccess: () => {
      invalidatePolicies();
      pushToast({ title: "Rule duplicated", body: "The copy is off until you turn it on.", tone: "success" });
    },
    onError: (err) => pushToast({ title: "Duplicate failed", body: err instanceof ApiError ? err.message : String(err), tone: "error" }),
  });
  const deletePolicy = useMutation({
    mutationFn: (policyId: string) => toolsApi.deletePolicy(companyId, policyId),
    onSuccess: () => {
      invalidatePolicies();
      setConfirm(null);
      pushToast({ title: "Rule deleted", tone: "success" });
    },
    onError: (err) => pushToast({ title: "Delete failed", body: err instanceof ApiError ? err.message : String(err), tone: "error" }),
  });
  const revoke = useMutation({
    mutationFn: (policyId: string) => toolsApi.revokeTrustRule(companyId, policyId),
    onSuccess: () => {
      invalidateTrustRules();
      setConfirm(null);
      pushToast({ title: "Remembered approval forgotten", tone: "success" });
    },
    onError: (err) => pushToast({ title: "Forget failed", body: err instanceof ApiError ? err.message : String(err), tone: "error" }),
  });

  function submitPolicy() {
    if (!form) return;
    try {
      const body = buildPolicyPayload(form);
      if (!body.name) body.name = sentenceText(formSentence(form, maps, catalogByToolName));
      if (form.id) updatePolicy.mutate({ policyId: form.id, body });
      else createPolicy.mutate(body);
    } catch (err) {
      pushToast({ title: "Invalid rule", body: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  function reorderTo(targetPolicyId: string) {
    const draggedPolicyId = draggingPolicyIdRef.current ?? draggingPolicyId;
    if (!draggedPolicyId || draggedPolicyId === targetPolicyId) return;
    const ids = policyList.map((policy) => policy.id);
    const from = ids.indexOf(draggedPolicyId);
    const to = ids.indexOf(targetPolicyId);
    if (from < 0 || to < 0) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    reorder.mutate(ids);
    draggingPolicyIdRef.current = null;
    setDraggingPolicyId(null);
  }

  const saving = createPolicy.isPending || updatePolicy.isPending;
  const agentsList = agents.data ?? [];
  const projectsList = projects.data ?? [];
  const applicationList = applications.data?.applications ?? [];

  if (form) {
    return (
      <RuleBuilder
        form={form}
        setForm={setForm}
        maps={maps}
        agents={agentsList}
        projects={projectsList}
        applications={applicationList}
        appGroups={appGroups}
        catalogByToolName={catalogByToolName}
        saving={saving}
        onCancel={() => setForm(null)}
        onSave={submitPolicy}
      />
    );
  }

  return (
    <div className="space-y-5">
      <ToolsPageHeader
        title="Rules"
        description="Rules are checked top to bottom -- the first one that matches decides."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setTestOpen(true)}>
              <FlaskConical className="mr-1 h-4 w-4" />
              Test a rule
            </Button>
            <Button size="sm" onClick={() => setForm(emptyPolicyForm())}>
              <Plus className="mr-1 h-4 w-4" />
              New rule
            </Button>
          </>
        }
      />

      <div className="space-y-2">
        {policies.isLoading ? (
          <LoadingState />
        ) : policies.error ? (
          <ErrorState error={policies.error} onRetry={() => policies.refetch()} />
        ) : policyList.length === 0 ? (
          <div className="space-y-3">
            <EmptyState
              icon={Shield}
              message="No rules yet"
              description="Start with a template or create a rule from scratch."
              action="New rule"
              onAction={() => setForm(emptyPolicyForm())}
            />
            <StarterCards onStart={setForm} />
          </div>
        ) : (
          <Card>
            <CardContent className="px-0 py-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="w-8 px-2 py-2.5 font-medium" />
                    <th className="px-2 py-2.5 font-medium">Rule</th>
                    <th className="px-2 py-2.5 font-medium">Outcome</th>
                    <th className="px-2 py-2.5 text-right font-medium">Last 24h</th>
                    <th className="px-2 py-2.5 text-center font-medium">On</th>
                    <th className="w-10 px-2 py-2.5 text-right font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {policyList.map((policy) => {
                    const sentence = policySentence(policy, maps, catalogByToolName);
                    const hits = hitsByPolicy.get(policy.id) ?? 0;
                    return (
                      <tr
                        key={policy.id}
                        className="align-middle hover:bg-muted/30"
                        draggable
                        onDragStart={() => {
                          draggingPolicyIdRef.current = policy.id;
                          setDraggingPolicyId(policy.id);
                        }}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => reorderTo(policy.id)}
                      >
                        <td className="px-2 py-2 text-muted-foreground">
                          <GripVertical className="h-4 w-4" />
                        </td>
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            className="block min-w-0 text-left font-medium text-foreground"
                            onClick={() => setForm(policyToForm(policy))}
                          >
                            <RuleSentence sentence={sentence} />
                          </button>
                          {policy.description ? (
                            <div className="truncate text-xs text-muted-foreground">{policy.description}</div>
                          ) : null}
                        </td>
                        <td className="px-2 py-2"><OutcomeChip type={policy.policyType} config={policy.config} /></td>
                        <td className="px-2 py-2 text-right text-xs text-muted-foreground">{hits} {hits === 1 ? "time" : "times"}</td>
                        <td className="px-2 py-2 text-center">
                          <ToggleSwitch
                            checked={policy.enabled}
                            disabled={updatePolicy.isPending}
                            onCheckedChange={(enabled) => updatePolicy.mutate({ policyId: policy.id, body: { enabled } })}
                          />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="icon" variant="ghost" aria-label="Rule actions">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => setForm(policyToForm(policy))}>
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => duplicate.mutate(policy)}>
                                <Copy className="mr-2 h-4 w-4" />
                                Duplicate
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => updatePolicy.mutate({ policyId: policy.id, body: { enabled: false } })}>
                                <RotateCcw className="mr-2 h-4 w-4" />
                                Turn off
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onSelect={() => setConfirm({ kind: "delete-rule", policy, hits })}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Remembered approvals</h3>
        <p className="text-sm text-muted-foreground">When you approve an Ask-first request, Paperclip can remember the decision.</p>
        {trustRules.isLoading ? (
          <LoadingState />
        ) : trustRules.error ? (
          <ErrorState error={trustRules.error} onRetry={() => trustRules.refetch()} />
        ) : (trustRules.data?.trustRules ?? []).length === 0 ? (
          <div className="rounded-md border border-border px-4 py-6 text-sm text-muted-foreground">
            No remembered approvals yet.
          </div>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {(trustRules.data?.trustRules ?? []).map((rule) => (
              <div key={rule.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground">
                    <RuleSentence sentence={policySentence(rule, maps, catalogByToolName)} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Remembered <RelativeTime value={rule.updatedAt} />
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!rule.enabled || revoke.isPending}
                  onClick={() => setConfirm({ kind: "forget-approval", policy: rule })}
                >
                  Forget
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <PolicySimulator
        companyId={companyId}
        agents={agentsList}
        policies={policyList}
        maps={maps}
        catalogByToolName={catalogByToolName}
        open={testOpen}
        onOpenChange={setTestOpen}
        onEditPolicy={(policy) => {
          setTestOpen(false);
          setForm(policyToForm(policy));
        }}
      />

      <Dialog open={Boolean(confirm)} onOpenChange={(open) => !open && setConfirm(null)}>
        {confirm ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{confirm.kind === "delete-rule" ? "Delete rule?" : "Forget remembered approval?"}</DialogTitle>
              <DialogDescription>
                {confirm.kind === "delete-rule"
                  ? `This rule matched ${confirm.hits} ${confirm.hits === 1 ? "time" : "times"} in the last 24 hours. Deleting it may change what agents can do.`
                  : "Paperclip will ask again the next time this action needs approval."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={deletePolicy.isPending || revoke.isPending}
                onClick={() => {
                  if (confirm.kind === "delete-rule") deletePolicy.mutate(confirm.policy.id);
                  else revoke.mutate(confirm.policy.id);
                }}
              >
                {confirm.kind === "delete-rule" ? "Delete" : "Forget"}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
