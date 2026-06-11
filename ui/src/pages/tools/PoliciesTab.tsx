import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FlaskConical,
  Pencil,
  Plus,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Trash2,
} from "lucide-react";
import type { ToolAccessDecision, ToolPolicy, ToolPolicyType, ToolRiskLevel } from "@paperclipai/shared";
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

const ANY_VALUE = "__any__";

type BuilderPolicyType = Exclude<ToolPolicyType, "trust_rule">;
type ActorTypeValue = "agent" | "user" | "system" | "plugin";
type RateLimitKeyBy = "company" | "agent" | "application" | "connection" | "tool";

const POLICY_TYPES: Array<{ value: BuilderPolicyType; label: string }> = [
  { value: "allow", label: "Allow" },
  { value: "block", label: "Block" },
  { value: "require_approval", label: "Require approval" },
  { value: "rate_limit", label: "Rate limit" },
  { value: "redact", label: "Redact" },
  { value: "validate", label: "Validate" },
];

const RISK_LEVELS: ToolRiskLevel[] = ["read", "write", "destructive", "low", "medium", "high", "critical"];
const RATE_LIMIT_KEY_FIELDS: RateLimitKeyBy[] = ["company", "agent", "application", "connection", "tool"];

type PolicyFormState = {
  id: string | null;
  name: string;
  description: string;
  policyType: BuilderPolicyType;
  priority: string;
  enabled: boolean;
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

function emptyPolicyForm(): PolicyFormState {
  return {
    id: null,
    name: "",
    description: "",
    policyType: "allow",
    priority: "100",
    enabled: true,
    actorType: ANY_VALUE,
    agentId: ANY_VALUE,
    projectId: ANY_VALUE,
    applicationId: ANY_VALUE,
    connectionId: ANY_VALUE,
    riskLevel: ANY_VALUE,
    toolNames: "",
    rateLimitLimit: "60",
    rateLimitWindowSeconds: "3600",
    rateLimitKeyBy: ["agent", "tool"],
    redactFields: "",
    conditionsJson: "",
    configJson: "",
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

/** Map a policy's effect type onto the canonical DecisionBadge palette. */
function effectDecision(type: ToolPolicyType | string): string {
  return type === "rate_limit" ? "rate_limited" : String(type);
}

function policyIcon(type: ToolPolicyType) {
  if (type === "allow") return <ShieldCheck className="h-5 w-5 text-emerald-600" />;
  if (type === "block") return <ShieldX className="h-5 w-5 text-destructive" />;
  if (type === "require_approval") return <ShieldAlert className="h-5 w-5 text-amber-500" />;
  return <Shield className="h-5 w-5 text-muted-foreground" />;
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

  return {
    ...emptyPolicyForm(),
    id: policy.id,
    name: policy.name,
    description: policy.description ?? "",
    policyType: policy.policyType as BuilderPolicyType,
    priority: String(policy.priority),
    enabled: policy.enabled,
    actorType: selectValue(selectors, "actorType") as PolicyFormState["actorType"],
    agentId: selectValue(selectors, "agentId"),
    projectId: selectValue(selectors, "projectId"),
    applicationId: selectValue(selectors, "applicationId"),
    connectionId: selectValue(selectors, "connectionId"),
    riskLevel: selectValue(selectors, "riskLevel"),
    toolNames,
    rateLimitLimit: String(rawRateLimit.limit ?? "60"),
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
  if (form.agentId !== ANY_VALUE) selectors.agentId = form.agentId;
  if (form.projectId !== ANY_VALUE) selectors.projectId = form.projectId;
  if (form.applicationId !== ANY_VALUE) selectors.applicationId = form.applicationId;
  if (form.connectionId !== ANY_VALUE) selectors.connectionId = form.connectionId;
  if (form.riskLevel !== ANY_VALUE) selectors.riskLevel = form.riskLevel;
  const toolNames = parseList(form.toolNames);
  if (toolNames.length === 1) selectors.toolName = toolNames[0];
  if (toolNames.length > 1) selectors.toolNames = toolNames;

  const conditions = parseJsonObject(form.conditionsJson, "Conditions JSON");
  const config = parseJsonObject(form.configJson, "Config JSON") ?? {};
  if (form.policyType === "rate_limit") {
    const limit = Number(form.rateLimitLimit);
    const windowSeconds = Number(form.rateLimitWindowSeconds);
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("Rate limit must be a positive integer");
    if (!Number.isInteger(windowSeconds) || windowSeconds <= 0) {
      throw new Error("Rate limit window must be a positive number of seconds");
    }
    config.rateLimit = {
      limit,
      windowSeconds,
      keyBy: form.rateLimitKeyBy,
    };
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

function PolicySimulator({ companyId }: { companyId: string }) {
  const { pushToast } = useToast();
  const [agentId, setAgentId] = useState<string>("");
  const [toolName, setToolName] = useState("");
  const [result, setResult] = useState<ToolAccessDecision | null>(null);

  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

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
        title: "Policy test failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      });
    },
  });

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <FlaskConical className="h-4 w-4" />
          Decision simulator
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Agent</Label>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger>
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent>
                {(agents.data ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sim-tool">Tool name</Label>
            <Input
              id="sim-tool"
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              placeholder="e.g. echo"
            />
          </div>
        </div>
        <Button
          size="sm"
          disabled={!agentId || !toolName.trim() || test.isPending}
          onClick={() => test.mutate()}
        >
          {test.isPending ? "Evaluating..." : "Evaluate decision"}
        </Button>

        {result ? (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            <div className="flex items-center gap-2">
              <DecisionBadge decision={result.decision} />
              <span className="font-mono text-xs text-muted-foreground">{result.reasonCode}</span>
            </div>
            <p className="mt-1.5 text-foreground">{result.explanation}</p>
            {result.matchedPolicyIds.length > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                matched {result.matchedPolicyIds.length} policy/policies · {result.effectiveProfileIds.length}{" "}
                effective profile(s)
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function PoliciesTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [form, setForm] = useState<PolicyFormState | null>(null);

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
  const trustRules = useQuery({
    queryKey: queryKeys.tools.trustRules(companyId),
    queryFn: () => toolsApi.listTrustRules(companyId),
  });
  const audit = useQuery({
    queryKey: queryKeys.tools.audit(companyId, 250),
    queryFn: () => toolsApi.listAudit(companyId, 250),
  });

  // 24h hit count per policy, derived from the recent audit sample's
  // `matchedPolicyIds`. This is a best-effort signal until the gateway exposes
  // a server-side per-policy counter; it under-counts if traffic exceeds the
  // 250-event sample window.
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

  const nameMaps = useMemo(() => ({
    agent: new Map((agents.data ?? []).map((item) => [item.id, item.name])),
    project: new Map((projects.data ?? []).map((item) => [item.id, item.name])),
    application: new Map((applications.data?.applications ?? []).map((item) => [item.id, item.name])),
    connection: new Map((connections.data?.connections ?? []).map((item) => [item.id, item.name])),
  }), [agents.data, applications.data, connections.data, projects.data]);

  const invalidatePolicies = () => qc.invalidateQueries({ queryKey: queryKeys.tools.policies(companyId) });

  const createPolicy = useMutation({
    mutationFn: (input: ReturnType<typeof buildPolicyPayload>) => toolsApi.createPolicy(companyId, input),
    onSuccess: () => {
      invalidatePolicies();
      setForm(null);
      pushToast({ title: "Policy created", tone: "success" });
    },
    onError: (err) =>
      pushToast({
        title: "Could not save policy",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  const updatePolicy = useMutation({
    mutationFn: (input: { policyId: string; body: ReturnType<typeof buildPolicyPayload> }) =>
      toolsApi.updatePolicy(companyId, input.policyId, input.body),
    onSuccess: () => {
      invalidatePolicies();
      setForm(null);
      pushToast({ title: "Policy updated", tone: "success" });
    },
    onError: (err) =>
      pushToast({
        title: "Could not save policy",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  const deletePolicy = useMutation({
    mutationFn: (policyId: string) => toolsApi.deletePolicy(companyId, policyId),
    onSuccess: () => {
      invalidatePolicies();
      pushToast({ title: "Policy deleted", tone: "success" });
    },
    onError: (err) =>
      pushToast({
        title: "Delete failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  const revoke = useMutation({
    mutationFn: (policyId: string) => toolsApi.revokeTrustRule(companyId, policyId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tools.trustRules(companyId) });
      pushToast({ title: "Trust rule revoked", tone: "success" });
    },
    onError: (err) =>
      pushToast({
        title: "Revoke failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  /** Match predicates as discrete `label:value` chips (vs the comma-soup summary). */
  function selectorChips(policy: ToolPolicy): string[] {
    const selectors = policy.selectors ?? {};
    const chips: string[] = [];
    const add = (label: string, key: string, names?: Map<string, string>) => {
      const values = [...stringList(selectors[key]), ...stringList(selectors[`${key}s`])];
      for (const value of values) chips.push(`${label}:${names?.get(value) ?? value}`);
    };
    add("actor", "actorType");
    add("agent", "agentId", nameMaps.agent);
    add("project", "projectId", nameMaps.project);
    add("app", "applicationId", nameMaps.application);
    add("conn", "connectionId", nameMaps.connection);
    add("risk", "riskLevel");
    add("tool", "toolName");
    return chips;
  }

  function submitPolicy() {
    if (!form) return;
    try {
      const body = buildPolicyPayload(form);
      if (!body.name) throw new Error("Name is required");
      if (form.id) {
        updatePolicy.mutate({ policyId: form.id, body });
      } else {
        createPolicy.mutate(body);
      }
    } catch (err) {
      pushToast({
        title: "Invalid policy",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    }
  }

  const policyList = policies.data?.policies ?? [];
  const saving = createPolicy.isPending || updatePolicy.isPending;

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title="Policies"
        description="Server-evaluated rules that allow, block, redact, rate-limit, or require approval for tool calls. Default posture is deny."
        actions={
          <Button size="sm" onClick={() => setForm(emptyPolicyForm())}>
            <Plus className="mr-1 h-4 w-4" />
            New policy
          </Button>
        }
      />

      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Shield className="h-4 w-4" />
          Policy rules
        </h3>
        {policies.isLoading ? (
          <LoadingState />
        ) : policies.error ? (
          <ErrorState error={policies.error} onRetry={() => policies.refetch()} />
        ) : policyList.length === 0 ? (
          <EmptyState
            icon={Shield}
            message="No policies"
            description="Create an allow, block, approval, redaction, or rate-limit rule."
            action="New policy"
            onAction={() => setForm(emptyPolicyForm())}
          />
        ) : (
          <Card>
            <CardContent className="px-0 py-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2.5 text-right font-medium">#</th>
                    <th className="px-3 py-2.5 font-medium">Policy</th>
                    <th className="px-3 py-2.5 font-medium">Effect</th>
                    <th className="px-3 py-2.5 font-medium">Match</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 text-right font-medium">24h hits</th>
                    <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {policyList.map((policy, index) => {
                    const chips = selectorChips(policy);
                    return (
                      <tr key={policy.id} className="align-top">
                        <td className="px-3 py-3 text-right font-mono text-xs text-muted-foreground">{index + 1}</td>
                        <td className="px-3 py-3">
                          <div className="flex items-start gap-2">
                            {policyIcon(policy.policyType)}
                            <div className="min-w-0">
                              <div className="font-medium text-foreground">{policy.name}</div>
                              {policy.description ? (
                                <div className="truncate text-xs text-muted-foreground">{policy.description}</div>
                              ) : null}
                              <div className="text-[11px] text-muted-foreground">priority {policy.priority}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <DecisionBadge decision={effectDecision(policy.policyType)} />
                        </td>
                        <td className="px-3 py-3">
                          {chips.length === 0 ? (
                            <span className="text-xs text-muted-foreground">company-wide</span>
                          ) : (
                            <div className="flex max-w-xs flex-wrap gap-1">
                              {chips.map((chip) => (
                                <Badge key={chip} variant="outline" className="font-mono text-[11px]">
                                  {chip}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <Badge variant={policy.enabled ? "secondary" : "outline"}>
                            {policy.enabled ? "enabled" : "disabled"}
                          </Badge>
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-xs text-foreground">
                          {hitsByPolicy.get(policy.id) ?? 0}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1.5">
                            <Button size="sm" variant="outline" onClick={() => setForm(policyToForm(policy))}>
                              <Pencil className="mr-1 h-3.5 w-3.5" />
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={deletePolicy.isPending}
                              onClick={() => deletePolicy.mutate(policy.id)}
                            >
                              <Trash2 className="mr-1 h-3.5 w-3.5" />
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
        <p className="text-xs text-muted-foreground">
          Rows are shown in evaluation order (#). 24h hits are derived from the recent audit sample's matched
          policies and may under-count high-traffic rules until a server-side counter ships.
        </p>
      </div>

      <PolicySimulator companyId={companyId} />

      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Shield className="h-4 w-4" />
          Trust rules
        </h3>
        {trustRules.isLoading ? (
          <LoadingState />
        ) : trustRules.error ? (
          <ErrorState error={trustRules.error} onRetry={() => trustRules.refetch()} />
        ) : (trustRules.data?.trustRules ?? []).length === 0 ? (
          <EmptyState
            icon={Shield}
            message="No trust rules"
            description="Trust rules are created by promoting a repeated approved action into a scoped auto-allow."
          />
        ) : (
          <div className="grid gap-2">
            {(trustRules.data?.trustRules ?? []).map((rule) => (
              <Card key={rule.id}>
                <CardContent className="flex flex-wrap items-center gap-3 py-3">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{rule.name}</span>
                      <Badge variant="outline">priority {rule.priority}</Badge>
                      {!rule.enabled ? <Badge variant="outline">disabled</Badge> : null}
                    </div>
                    {rule.description ? (
                      <p className="truncate text-xs text-muted-foreground">{rule.description}</p>
                    ) : null}
                  </div>
                  <span className="text-xs">
                    <RelativeTime value={rule.updatedAt} />
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!rule.enabled || revoke.isPending}
                    onClick={() => revoke.mutate(rule.id)}
                  >
                    <ShieldX className="mr-1 h-3.5 w-3.5" />
                    Revoke
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={Boolean(form)} onOpenChange={(open) => !open && setForm(null)}>
        {form ? (
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>{form.id ? "Edit policy" : "New policy"}</DialogTitle>
              <DialogDescription>Define the server-side rule and the selectors it applies to.</DialogDescription>
            </DialogHeader>
            <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
              <div className="grid gap-3 sm:grid-cols-[1fr_180px_120px]">
                <div className="space-y-1.5">
                  <Label htmlFor="policy-name">Name</Label>
                  <Input
                    id="policy-name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. Block destructive shell tools"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <Select
                    value={form.policyType}
                    onValueChange={(value) => setForm({ ...form, policyType: value as BuilderPolicyType })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {POLICY_TYPES.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="policy-priority">Priority</Label>
                  <Input
                    id="policy-priority"
                    inputMode="numeric"
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: e.target.value })}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Enabled</p>
                  <p className="text-xs text-muted-foreground">Disabled policies stay saved but do not match.</p>
                </div>
                <ToggleSwitch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="policy-description">Description</Label>
                <Textarea
                  id="policy-description"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Optional reviewer-facing reason"
                  className="min-h-20"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Actor type</Label>
                  <Select
                    value={form.actorType}
                    onValueChange={(actorType) => setForm({ ...form, actorType: actorType as PolicyFormState["actorType"] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY_VALUE}>Any actor</SelectItem>
                      <SelectItem value="agent">Agent</SelectItem>
                      <SelectItem value="user">User</SelectItem>
                      <SelectItem value="system">System</SelectItem>
                      <SelectItem value="plugin">Plugin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Agent</Label>
                  <Select value={form.agentId} onValueChange={(agentId) => setForm({ ...form, agentId })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY_VALUE}>Any agent</SelectItem>
                      {(agents.data ?? []).map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Project</Label>
                  <Select value={form.projectId} onValueChange={(projectId) => setForm({ ...form, projectId })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY_VALUE}>Any project</SelectItem>
                      {(projects.data ?? []).map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Application</Label>
                  <Select
                    value={form.applicationId}
                    onValueChange={(applicationId) => setForm({ ...form, applicationId })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY_VALUE}>Any application</SelectItem>
                      {(applications.data?.applications ?? []).map((app) => (
                        <SelectItem key={app.id} value={app.id}>
                          {app.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Connection</Label>
                  <Select
                    value={form.connectionId}
                    onValueChange={(connectionId) => setForm({ ...form, connectionId })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY_VALUE}>Any connection</SelectItem>
                      {(connections.data?.connections ?? []).map((connection) => (
                        <SelectItem key={connection.id} value={connection.id}>
                          {connection.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Risk level</Label>
                  <Select value={form.riskLevel} onValueChange={(riskLevel) => setForm({ ...form, riskLevel })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY_VALUE}>Any risk</SelectItem>
                      {RISK_LEVELS.map((risk) => (
                        <SelectItem key={risk} value={risk}>
                          {risk}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="policy-tools">Tool names</Label>
                <Input
                  id="policy-tools"
                  value={form.toolNames}
                  onChange={(e) => setForm({ ...form, toolNames: e.target.value })}
                  placeholder="echo, add, mcp-server:tool_name"
                />
              </div>

              {form.policyType === "rate_limit" ? (
                <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="policy-rate-limit">Limit</Label>
                    <Input
                      id="policy-rate-limit"
                      inputMode="numeric"
                      value={form.rateLimitLimit}
                      onChange={(e) => setForm({ ...form, rateLimitLimit: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="policy-rate-window">Window seconds</Label>
                    <Input
                      id="policy-rate-window"
                      inputMode="numeric"
                      value={form.rateLimitWindowSeconds}
                      onChange={(e) => setForm({ ...form, rateLimitWindowSeconds: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label>Bucket key</Label>
                    <div className="flex flex-wrap gap-3">
                      {RATE_LIMIT_KEY_FIELDS.map((key) => (
                        <label key={key} className="flex items-center gap-2 text-sm text-foreground">
                          <Checkbox
                            checked={form.rateLimitKeyBy.includes(key)}
                            onCheckedChange={(checked) => {
                              const next = checked === true
                                ? [...new Set([...form.rateLimitKeyBy, key])]
                                : form.rateLimitKeyBy.filter((item) => item !== key);
                              setForm({ ...form, rateLimitKeyBy: next });
                            }}
                          />
                          {key}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {form.policyType === "redact" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="policy-redact-fields">Redacted fields</Label>
                  <Input
                    id="policy-redact-fields"
                    value={form.redactFields}
                    onChange={(e) => setForm({ ...form, redactFields: e.target.value })}
                    placeholder="token, password, response.secret"
                  />
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="policy-conditions">Conditions JSON</Label>
                  <Textarea
                    id="policy-conditions"
                    value={form.conditionsJson}
                    onChange={(e) => setForm({ ...form, conditionsJson: e.target.value })}
                    placeholder='{"sideEffecting": true}'
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="policy-config">Config JSON</Label>
                  <Textarea
                    id="policy-config"
                    value={form.configJson}
                    onChange={(e) => setForm({ ...form, configJson: e.target.value })}
                    placeholder='{"note": "optional"}'
                  />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button disabled={!form.name.trim() || saving} onClick={submitPolicy}>
                {saving ? "Saving..." : "Save policy"}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
