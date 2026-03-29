import { useEffect, useMemo, useState, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EventRoutingRule, WebhookEndpoint, WebhookEvent } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { webhooksApi } from "../api/webhooks";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { EntityRow } from "../components/EntityRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Webhook, Plus, Trash2, Radio, ArrowRight, Clock, Zap, Globe, Pencil, X } from "lucide-react";

type Provider = "github" | "slack" | "email" | "generic";
type ActionType = "wake_agent" | "create_issue" | "create_and_assign";
type EndpointStatus = "active" | "paused" | "disabled";

function ruleSummary(rule: EventRoutingRule) {
  const conditionEvent =
    typeof rule.condition?.event === "string" ? String(rule.condition.event) : "any event";
  const actionType = typeof rule.action?.type === "string" ? String(rule.action.type) : "unknown action";
  return `${conditionEvent} -> ${actionType}`;
}

function extractActionType(rule: EventRoutingRule): ActionType {
  const t = typeof rule.action?.type === "string" ? String(rule.action.type) : "";
  if (t === "wake_agent" || t === "create_issue" || t === "create_and_assign") return t;
  return "wake_agent";
}

function createRulePayload(input: {
  name: string;
  eventType: string;
  actionType: ActionType;
  agentId: string;
  reason: string;
  titleTemplate: string;
  descriptionTemplate: string;
  source: "webhook" | "internal";
}) {
  const condition: Record<string, unknown> = { event: input.eventType.trim() };
  if (input.source === "internal") {
    condition.source = "internal";
  }

  if (input.actionType === "wake_agent") {
    return {
      name: input.name.trim(),
      condition,
      action: {
        type: "wake_agent",
        agentId: input.agentId.trim(),
        reason: input.reason.trim() || undefined,
      },
    };
  }

  if (input.actionType === "create_issue") {
    return {
      name: input.name.trim(),
      condition,
      action: {
        type: "create_issue",
        title: input.titleTemplate.trim(),
        description: input.descriptionTemplate.trim() || undefined,
      },
    };
  }

  return {
    name: input.name.trim(),
    condition,
    action: {
      type: "create_and_assign",
      agentId: input.agentId.trim(),
      reason: input.reason.trim() || undefined,
      title: input.titleTemplate.trim(),
      description: input.descriptionTemplate.trim() || undefined,
    },
  };
}

const STATUS_LABELS: Record<EndpointStatus, string> = {
  active: "Active",
  paused: "Paused",
  disabled: "Disabled",
};

const STATUS_COLORS: Record<EndpointStatus, string> = {
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  paused: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  disabled: "bg-red-500/15 text-red-600 dark:text-red-400",
};

export function Webhooks() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  const [showEndpointForm, setShowEndpointForm] = useState(false);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [showInternalRuleForm, setShowInternalRuleForm] = useState(false);

  // Editing state
  const [editingEndpoint, setEditingEndpoint] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editingInternalRuleId, setEditingInternalRuleId] = useState<string | null>(null);

  // Endpoint form fields (shared for create + edit)
  const [endpointName, setEndpointName] = useState("");
  const [endpointSlug, setEndpointSlug] = useState("");
  const [endpointProvider, setEndpointProvider] = useState<Provider>("github");
  const [endpointSecret, setEndpointSecret] = useState("");
  const [endpointStatus, setEndpointStatus] = useState<EndpointStatus>("active");

  // Rule form fields (shared for create + edit, endpoint rules)
  const [ruleName, setRuleName] = useState("");
  const [ruleEventType, setRuleEventType] = useState("pull_request.opened");
  const [ruleActionType, setRuleActionType] = useState<ActionType>("wake_agent");
  const [ruleAgentId, setRuleAgentId] = useState("");
  const [ruleReason, setRuleReason] = useState("");
  const [ruleTitleTemplate, setRuleTitleTemplate] = useState("Automation task: {{eventType}}");
  const [ruleDescriptionTemplate, setRuleDescriptionTemplate] = useState(
    "Triggered by {{provider}} event {{eventType}}.",
  );
  const [ruleEnabled, setRuleEnabled] = useState(true);

  // Internal rule form fields (shared for create + edit)
  const [internalRuleName, setInternalRuleName] = useState("");
  const [internalEventType, setInternalEventType] = useState("paperclip.issue.status_changed");
  const [internalActionType, setInternalActionType] = useState<ActionType>("wake_agent");
  const [internalAgentId, setInternalAgentId] = useState("");
  const [internalReason, setInternalReason] = useState("");
  const [internalTitleTemplate, setInternalTitleTemplate] = useState("Internal automation: {{eventType}}");
  const [internalDescriptionTemplate, setInternalDescriptionTemplate] = useState(
    "Triggered by internal event {{eventType}}.",
  );
  const [internalRuleEnabled, setInternalRuleEnabled] = useState(true);

  useEffect(() => {
    setBreadcrumbs([{ label: "Webhooks" }]);
  }, [setBreadcrumbs]);

  // --- Queries ---

  const endpointsQuery = useQuery({
    queryKey: queryKeys.webhooks.endpoints(selectedCompanyId!),
    queryFn: () => webhooksApi.listEndpoints(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const endpoints = endpointsQuery.data ?? [];

  useEffect(() => {
    if (endpoints.length === 0) {
      setSelectedEndpointId(null);
      return;
    }
    if (!selectedEndpointId || !endpoints.some((row) => row.id === selectedEndpointId)) {
      setSelectedEndpointId(endpoints[0]!.id);
    }
  }, [endpoints, selectedEndpointId]);

  const selectedEndpoint = useMemo(
    () => endpoints.find((row) => row.id === selectedEndpointId) ?? null,
    [endpoints, selectedEndpointId],
  );

  const rulesQuery = useQuery({
    queryKey: queryKeys.webhooks.rules(selectedEndpointId ?? "__none__"),
    queryFn: () => webhooksApi.listRulesForEndpoint(selectedEndpointId!),
    enabled: !!selectedEndpointId,
  });
  const eventsQuery = useQuery({
    queryKey: queryKeys.webhooks.endpointEvents(selectedEndpointId ?? "__none__"),
    queryFn: () => webhooksApi.listEventsForEndpoint(selectedEndpointId!, 150),
    enabled: !!selectedEndpointId,
    refetchInterval: 10_000,
  });

  const companyRulesQuery = useQuery({
    queryKey: queryKeys.webhooks.companyRules(selectedCompanyId ?? "__none__"),
    queryFn: () => webhooksApi.listRulesForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const internalRules = useMemo(
    () => (companyRulesQuery.data ?? []).filter((rule) => rule.source === "internal"),
    [companyRulesQuery.data],
  );

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const agents = agentsQuery.data ?? [];
  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);

  // --- Invalidation ---

  const invalidateWebhookQueries = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.endpoints(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.companyRules(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.companyEvents(selectedCompanyId) });
    if (selectedEndpointId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.rules(selectedEndpointId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.endpointEvents(selectedEndpointId) });
    }
  };

  // --- Edit helpers ---

  const resetRuleForm = useCallback(() => {
    setRuleName("");
    setRuleEventType("pull_request.opened");
    setRuleActionType("wake_agent");
    setRuleAgentId("");
    setRuleReason("");
    setRuleTitleTemplate("Automation task: {{eventType}}");
    setRuleDescriptionTemplate("Triggered by {{provider}} event {{eventType}}.");
    setRuleEnabled(true);
  }, []);

  const resetInternalRuleForm = useCallback(() => {
    setInternalRuleName("");
    setInternalEventType("paperclip.issue.status_changed");
    setInternalActionType("wake_agent");
    setInternalAgentId("");
    setInternalReason("");
    setInternalTitleTemplate("Internal automation: {{eventType}}");
    setInternalDescriptionTemplate("Triggered by internal event {{eventType}}.");
    setInternalRuleEnabled(true);
  }, []);

  const startEditEndpoint = useCallback((ep: WebhookEndpoint) => {
    setEndpointName(ep.name);
    setEndpointSlug(ep.slug);
    setEndpointProvider(ep.provider);
    setEndpointSecret("");
    setEndpointStatus(ep.status);
    setEditingEndpoint(true);
    setShowEndpointForm(false);
  }, []);

  const cancelEditEndpoint = useCallback(() => {
    setEditingEndpoint(false);
    setEndpointName("");
    setEndpointSlug("");
    setEndpointSecret("");
  }, []);

  const startEditRule = useCallback((rule: EventRoutingRule) => {
    setRuleName(rule.name);
    setRuleEventType(typeof rule.condition?.event === "string" ? String(rule.condition.event) : "");
    setRuleActionType(extractActionType(rule));
    setRuleAgentId(typeof rule.action?.agentId === "string" ? String(rule.action.agentId) : "");
    setRuleReason(typeof rule.action?.reason === "string" ? String(rule.action.reason) : "");
    setRuleTitleTemplate(typeof rule.action?.title === "string" ? String(rule.action.title) : "");
    setRuleDescriptionTemplate(typeof rule.action?.description === "string" ? String(rule.action.description) : "");
    setRuleEnabled(rule.enabled);
    setEditingRuleId(rule.id);
    setShowRuleForm(false);
  }, []);

  const cancelEditRule = useCallback(() => {
    setEditingRuleId(null);
    resetRuleForm();
  }, [resetRuleForm]);

  const startEditInternalRule = useCallback((rule: EventRoutingRule) => {
    setInternalRuleName(rule.name);
    setInternalEventType(typeof rule.condition?.event === "string" ? String(rule.condition.event) : "");
    setInternalActionType(extractActionType(rule));
    setInternalAgentId(typeof rule.action?.agentId === "string" ? String(rule.action.agentId) : "");
    setInternalReason(typeof rule.action?.reason === "string" ? String(rule.action.reason) : "");
    setInternalTitleTemplate(typeof rule.action?.title === "string" ? String(rule.action.title) : "");
    setInternalDescriptionTemplate(typeof rule.action?.description === "string" ? String(rule.action.description) : "");
    setInternalRuleEnabled(rule.enabled);
    setEditingInternalRuleId(rule.id);
    setShowInternalRuleForm(false);
  }, []);

  const cancelEditInternalRule = useCallback(() => {
    setEditingInternalRuleId(null);
    resetInternalRuleForm();
  }, [resetInternalRuleForm]);

  // --- Mutations ---

  const createEndpointMutation = useMutation({
    mutationFn: () =>
      webhooksApi.createEndpoint(selectedCompanyId!, {
        name: endpointName.trim(),
        slug: endpointSlug.trim(),
        provider: endpointProvider,
        secret: endpointSecret.trim() || undefined,
      }),
    onSuccess: (created) => {
      invalidateWebhookQueries();
      setShowEndpointForm(false);
      setEndpointName("");
      setEndpointSlug("");
      setEndpointSecret("");
      setSelectedEndpointId(created.id);
    },
  });

  const updateEndpointMutation = useMutation({
    mutationFn: () => {
      if (!selectedEndpointId) throw new Error("No endpoint selected");
      const data: Record<string, unknown> = {
        name: endpointName.trim(),
        slug: endpointSlug.trim(),
        provider: endpointProvider,
        status: endpointStatus,
      };
      if (endpointSecret.trim()) {
        data.secret = endpointSecret.trim();
      }
      return webhooksApi.updateEndpoint(selectedEndpointId, data as Parameters<typeof webhooksApi.updateEndpoint>[1]);
    },
    onSuccess: () => {
      invalidateWebhookQueries();
      cancelEditEndpoint();
    },
  });

  const deleteEndpointMutation = useMutation({
    mutationFn: (endpointId: string) => webhooksApi.deleteEndpoint(endpointId),
    onSuccess: () => invalidateWebhookQueries(),
  });

  const createEndpointRuleMutation = useMutation({
    mutationFn: () => {
      if (!selectedEndpointId) throw new Error("Select an endpoint first");
      return webhooksApi.createRuleForEndpoint(
        selectedEndpointId,
        createRulePayload({
          name: ruleName,
          eventType: ruleEventType,
          actionType: ruleActionType,
          agentId: ruleAgentId,
          reason: ruleReason,
          titleTemplate: ruleTitleTemplate,
          descriptionTemplate: ruleDescriptionTemplate,
          source: "webhook",
        }),
      );
    },
    onSuccess: () => {
      invalidateWebhookQueries();
      setShowRuleForm(false);
      resetRuleForm();
    },
  });

  const updateRuleMutation = useMutation({
    mutationFn: (ruleId: string) => {
      const source: "webhook" | "internal" = editingInternalRuleId === ruleId ? "internal" : "webhook";
      const isInternal = source === "internal";
      const payload = createRulePayload({
        name: isInternal ? internalRuleName : ruleName,
        eventType: isInternal ? internalEventType : ruleEventType,
        actionType: isInternal ? internalActionType : ruleActionType,
        agentId: isInternal ? internalAgentId : ruleAgentId,
        reason: isInternal ? internalReason : ruleReason,
        titleTemplate: isInternal ? internalTitleTemplate : ruleTitleTemplate,
        descriptionTemplate: isInternal ? internalDescriptionTemplate : ruleDescriptionTemplate,
        source,
      });
      return webhooksApi.updateRule(ruleId, {
        ...payload,
        enabled: isInternal ? internalRuleEnabled : ruleEnabled,
      });
    },
    onSuccess: (_data, ruleId) => {
      invalidateWebhookQueries();
      if (editingInternalRuleId === ruleId) {
        cancelEditInternalRule();
      } else {
        cancelEditRule();
      }
    },
  });

  const createInternalRuleMutation = useMutation({
    mutationFn: () =>
      webhooksApi.createRuleForCompany(selectedCompanyId!, {
        source: "internal",
        endpointId: null,
        ...createRulePayload({
          name: internalRuleName,
          eventType: internalEventType,
          actionType: internalActionType,
          agentId: internalAgentId,
          reason: internalReason,
          titleTemplate: internalTitleTemplate,
          descriptionTemplate: internalDescriptionTemplate,
          source: "internal",
        }),
      }),
    onSuccess: () => {
      invalidateWebhookQueries();
      setShowInternalRuleForm(false);
      resetInternalRuleForm();
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: (ruleId: string) => webhooksApi.deleteRule(ruleId),
    onSuccess: () => invalidateWebhookQueries(),
  });

  // --- Render ---

  if (!selectedCompanyId) {
    return <EmptyState icon={Webhook} message="Select a company to manage webhook automation." />;
  }

  if (endpointsQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const endpointRules = rulesQuery.data ?? [];
  const endpointEvents = eventsQuery.data ?? [];

  return (
    <div className="space-y-6 animate-page-enter">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* ── Left column: Endpoint list ── */}
        <section className="space-y-3 xl:col-span-1">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Endpoints</h2>
            <Button size="sm" variant="outline" onClick={() => { setShowEndpointForm((v) => !v); setEditingEndpoint(false); }}>
              <Plus className="h-4 w-4 mr-1" />
              New
            </Button>
          </div>

          {showEndpointForm && (
            <div className="border border-border/60 rounded-md p-4 space-y-3 bg-muted/30">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={endpointName} onChange={(e) => setEndpointName(e.target.value)} placeholder="GitHub Main" />
              </div>
              <div className="space-y-1.5">
                <Label>Slug</Label>
                <Input value={endpointSlug} onChange={(e) => setEndpointSlug(e.target.value)} placeholder="github-main" />
              </div>
              <div className="space-y-1.5">
                <Label>Provider</Label>
                <Select value={endpointProvider} onValueChange={(value) => setEndpointProvider(value as Provider)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="slack">Slack</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="generic">Generic</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Secret (optional)</Label>
                <Input value={endpointSecret} onChange={(e) => setEndpointSecret(e.target.value)} placeholder="autogenerated when empty" />
              </div>
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={() => createEndpointMutation.mutate()}
                  disabled={!endpointName.trim() || !endpointSlug.trim() || createEndpointMutation.isPending}
                >
                  {createEndpointMutation.isPending ? "Creating..." : "Create"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowEndpointForm(false)}>Cancel</Button>
              </div>
            </div>
          )}

          {endpoints.length === 0 ? (
            <EmptyState
              icon={Webhook}
              message="No webhook endpoints yet."
              description="Webhooks let external services trigger agent work automatically — like starting a task when a PR is opened or a form is submitted."
            />
          ) : (
            <div className="border border-border/60 rounded-md overflow-hidden divide-y divide-border/60">
              {endpoints.map((endpoint: WebhookEndpoint) => (
                <EntityRow
                  key={endpoint.id}
                  title={endpoint.name}
                  subtitle={`/${endpoint.slug}/receive`}
                  onClick={() => { setSelectedEndpointId(endpoint.id); setEditingEndpoint(false); }}
                  leading={<Globe className="h-4 w-4 text-muted-foreground/60" />}
                  className={selectedEndpointId === endpoint.id
                    ? "bg-primary/5 border-l-2 border-l-primary"
                    : "border-l-2 border-l-transparent"}
                  trailing={
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLORS[endpoint.status]}`}>
                        {STATUS_LABELS[endpoint.status]}
                      </span>
                      <Badge variant="outline" className="capitalize text-[11px]">
                        {endpoint.provider}
                      </Badge>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive/70 hover:text-destructive"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!window.confirm(`Delete endpoint "${endpoint.name}"?`)) return;
                          deleteEndpointMutation.mutate(endpoint.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  }
                />
              ))}
            </div>
          )}
        </section>

        {/* ── Right column: Endpoint detail + rules + events ── */}
        <section className="space-y-4 xl:col-span-2">
          {!selectedEndpoint ? (
            <EmptyState
              icon={Webhook}
              message="Select an endpoint to view rules and events."
              description="Each endpoint can have routing rules that determine which agent handles incoming events."
            />
          ) : (
            <>
              {/* Endpoint detail / edit card */}
              {editingEndpoint ? (
                <div className="border border-primary/30 rounded-md p-5 space-y-3 bg-primary/[0.02]">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Edit Endpoint</h3>
                    <Button size="icon-sm" variant="ghost" onClick={cancelEditEndpoint}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Name</Label>
                      <Input value={endpointName} onChange={(e) => setEndpointName(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Slug</Label>
                      <Input value={endpointSlug} onChange={(e) => setEndpointSlug(e.target.value)} />
                    </div>
                  </div>
                  <div className="grid sm:grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <Label>Provider</Label>
                      <Select value={endpointProvider} onValueChange={(value) => setEndpointProvider(value as Provider)}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="github">GitHub</SelectItem>
                          <SelectItem value="slack">Slack</SelectItem>
                          <SelectItem value="email">Email</SelectItem>
                          <SelectItem value="generic">Generic</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Status</Label>
                      <Select value={endpointStatus} onValueChange={(value) => setEndpointStatus(value as EndpointStatus)}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="paused">Paused</SelectItem>
                          <SelectItem value="disabled">Disabled</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Secret (leave blank to keep)</Label>
                      <Input value={endpointSecret} onChange={(e) => setEndpointSecret(e.target.value)} placeholder="••••••••" />
                    </div>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      onClick={() => updateEndpointMutation.mutate()}
                      disabled={!endpointName.trim() || !endpointSlug.trim() || updateEndpointMutation.isPending}
                    >
                      {updateEndpointMutation.isPending ? "Saving..." : "Save Changes"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={cancelEditEndpoint}>Cancel</Button>
                  </div>
                  {updateEndpointMutation.isError && (
                    <p className="text-xs text-destructive">{(updateEndpointMutation.error as Error)?.message}</p>
                  )}
                </div>
              ) : (
                <div className="border border-border/60 rounded-md p-5 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold" style={{ fontFamily: "var(--font-family-display)" }}>{selectedEndpoint.name}</h3>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">
                        /api/webhooks/{selectedEndpoint.slug}/receive
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_COLORS[selectedEndpoint.status]}`}>
                        {STATUS_LABELS[selectedEndpoint.status]}
                      </span>
                      <Badge variant="outline" className="capitalize text-[11px]">
                        {selectedEndpoint.provider}
                      </Badge>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => startEditEndpoint(selectedEndpoint)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1 border-t border-border/40">
                    <span className="flex items-center gap-1.5 pt-2">
                      <Radio className="h-3 w-3 text-primary/60" />
                      {selectedEndpoint.eventCount} events received
                    </span>
                    <span className="flex items-center gap-1.5 pt-2">
                      <Clock className="h-3 w-3 text-muted-foreground/60" />
                      {selectedEndpoint.lastEventAt ? new Date(selectedEndpoint.lastEventAt).toLocaleString() : "No events yet"}
                    </span>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* ── Routing Rules ── */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Routing Rules</h4>
                    <Button size="sm" variant="outline" onClick={() => { setShowRuleForm((v) => !v); cancelEditRule(); }}>
                      <Plus className="h-4 w-4 mr-1" />
                      Add Rule
                    </Button>
                  </div>

                  {showRuleForm && (
                    <RuleFormCard
                      mode="create"
                      name={ruleName} setName={setRuleName}
                      eventType={ruleEventType} setEventType={setRuleEventType}
                      actionType={ruleActionType} setActionType={setRuleActionType}
                      agentId={ruleAgentId} setAgentId={setRuleAgentId}
                      reason={ruleReason} setReason={setRuleReason}
                      titleTemplate={ruleTitleTemplate} setTitleTemplate={setRuleTitleTemplate}
                      descriptionTemplate={ruleDescriptionTemplate} setDescriptionTemplate={setRuleDescriptionTemplate}
                      enabled={ruleEnabled} setEnabled={setRuleEnabled}
                      agents={agents}
                      isPending={createEndpointRuleMutation.isPending}
                      isError={createEndpointRuleMutation.isError}
                      error={createEndpointRuleMutation.error as Error | null}
                      onSave={() => createEndpointRuleMutation.mutate()}
                      onCancel={() => { setShowRuleForm(false); resetRuleForm(); }}
                      disableSave={!ruleName.trim() || !ruleEventType.trim() || ((ruleActionType === "wake_agent" || ruleActionType === "create_and_assign") && !ruleAgentId)}
                    />
                  )}

                  {rulesQuery.isLoading ? (
                    <PageSkeleton variant="list" />
                  ) : endpointRules.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 border border-dashed border-border/60 rounded-md text-center">
                      <ArrowRight className="h-5 w-5 text-muted-foreground/40 mb-2" />
                      <p className="text-sm text-muted-foreground">No routing rules yet</p>
                    </div>
                  ) : (
                    <div className="border border-border/60 rounded-md overflow-hidden divide-y divide-border/60">
                      {endpointRules.map((rule) => (
                        <div key={rule.id}>
                          {editingRuleId === rule.id ? (
                            <RuleFormCard
                              mode="edit"
                              name={ruleName} setName={setRuleName}
                              eventType={ruleEventType} setEventType={setRuleEventType}
                              actionType={ruleActionType} setActionType={setRuleActionType}
                              agentId={ruleAgentId} setAgentId={setRuleAgentId}
                              reason={ruleReason} setReason={setRuleReason}
                              titleTemplate={ruleTitleTemplate} setTitleTemplate={setRuleTitleTemplate}
                              descriptionTemplate={ruleDescriptionTemplate} setDescriptionTemplate={setRuleDescriptionTemplate}
                              enabled={ruleEnabled} setEnabled={setRuleEnabled}
                              agents={agents}
                              isPending={updateRuleMutation.isPending}
                              isError={updateRuleMutation.isError}
                              error={updateRuleMutation.error as Error | null}
                              onSave={() => updateRuleMutation.mutate(rule.id)}
                              onCancel={cancelEditRule}
                              disableSave={!ruleName.trim() || !ruleEventType.trim() || ((ruleActionType === "wake_agent" || ruleActionType === "create_and_assign") && !ruleAgentId)}
                            />
                          ) : (
                            <EntityRow
                              title={rule.name}
                              subtitle={ruleSummary(rule)}
                              leading={<Zap className="h-3.5 w-3.5 text-primary/50" />}
                              onClick={() => startEditRule(rule)}
                              trailing={
                                <div className="flex items-center gap-2">
                                  {!rule.enabled && (
                                    <Badge variant="outline" className="text-[10px] text-muted-foreground">Off</Badge>
                                  )}
                                  <Badge variant="outline" className="text-[11px] font-mono">P{rule.priority}</Badge>
                                  <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    className="text-muted-foreground hover:text-foreground"
                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); startEditRule(rule); }}
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    className="text-destructive/70 hover:text-destructive"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      if (!window.confirm(`Delete rule "${rule.name}"?`)) return;
                                      deleteRuleMutation.mutate(rule.id);
                                    }}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              }
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── Event Log ── */}
                <div className="space-y-3">
                  <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Event Log</h4>
                  {eventsQuery.isLoading ? (
                    <PageSkeleton variant="list" />
                  ) : endpointEvents.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 border border-dashed border-border/60 rounded-md text-center">
                      <Radio className="h-5 w-5 text-muted-foreground/40 mb-2" />
                      <p className="text-sm text-muted-foreground">No events yet</p>
                    </div>
                  ) : (
                    <div className="border border-border/60 rounded-md overflow-hidden divide-y divide-border/40 max-h-[520px] overflow-y-auto">
                      {endpointEvents.map((event: WebhookEvent) => (
                        <div key={event.id} className="px-3.5 py-2.5 space-y-1 hover:bg-accent/30 transition-colors">
                          <div className="flex items-center justify-between gap-2">
                            <div className="truncate">
                              <p className="text-sm font-medium truncate font-mono">{event.eventType}</p>
                              <p className="text-[11px] text-muted-foreground mt-0.5">
                                {new Date(event.createdAt).toLocaleString()}
                              </p>
                            </div>
                            <StatusBadge status={event.status} />
                          </div>
                          {event.matchedRuleId && (
                            <p className="text-[11px] text-muted-foreground/70 font-mono flex items-center gap-1">
                              <ArrowRight className="h-2.5 w-2.5" />
                              {event.matchedRuleId}
                            </p>
                          )}
                          {event.error && (
                            <p className="text-xs text-destructive mt-0.5">{event.error}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {/* ── Internal Rules ── */}
      <section className="space-y-3 border-t border-border/40 pt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Internal Rules</h2>
          <Button size="sm" variant="outline" onClick={() => { setShowInternalRuleForm((v) => !v); cancelEditInternalRule(); }}>
            <Plus className="h-4 w-4 mr-1" />
            New Internal Rule
          </Button>
        </div>

        {showInternalRuleForm && (
          <RuleFormCard
            mode="create"
            name={internalRuleName} setName={setInternalRuleName}
            eventType={internalEventType} setEventType={setInternalEventType}
            actionType={internalActionType} setActionType={setInternalActionType}
            agentId={internalAgentId} setAgentId={setInternalAgentId}
            reason={internalReason} setReason={setInternalReason}
            titleTemplate={internalTitleTemplate} setTitleTemplate={setInternalTitleTemplate}
            descriptionTemplate={internalDescriptionTemplate} setDescriptionTemplate={setInternalDescriptionTemplate}
            enabled={internalRuleEnabled} setEnabled={setInternalRuleEnabled}
            agents={agents}
            isPending={createInternalRuleMutation.isPending}
            isError={createInternalRuleMutation.isError}
            error={createInternalRuleMutation.error as Error | null}
            onSave={() => createInternalRuleMutation.mutate()}
            onCancel={() => { setShowInternalRuleForm(false); resetInternalRuleForm(); }}
            disableSave={!internalRuleName.trim() || !internalEventType.trim() || ((internalActionType === "wake_agent" || internalActionType === "create_and_assign") && !internalAgentId)}
            eventPlaceholder="paperclip.issue.status_changed"
          />
        )}

        {internalRules.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 border border-dashed border-border/60 rounded-md text-center">
            <Zap className="h-5 w-5 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">No internal rules yet</p>
          </div>
        ) : (
          <div className="border border-border/60 rounded-md overflow-hidden divide-y divide-border/60">
            {internalRules.map((rule) => (
              <div key={rule.id}>
                {editingInternalRuleId === rule.id ? (
                  <RuleFormCard
                    mode="edit"
                    name={internalRuleName} setName={setInternalRuleName}
                    eventType={internalEventType} setEventType={setInternalEventType}
                    actionType={internalActionType} setActionType={setInternalActionType}
                    agentId={internalAgentId} setAgentId={setInternalAgentId}
                    reason={internalReason} setReason={setInternalReason}
                    titleTemplate={internalTitleTemplate} setTitleTemplate={setInternalTitleTemplate}
                    descriptionTemplate={internalDescriptionTemplate} setDescriptionTemplate={setInternalDescriptionTemplate}
                    enabled={internalRuleEnabled} setEnabled={setInternalRuleEnabled}
                    agents={agents}
                    isPending={updateRuleMutation.isPending}
                    isError={updateRuleMutation.isError}
                    error={updateRuleMutation.error as Error | null}
                    onSave={() => updateRuleMutation.mutate(rule.id)}
                    onCancel={cancelEditInternalRule}
                    disableSave={!internalRuleName.trim() || !internalEventType.trim() || ((internalActionType === "wake_agent" || internalActionType === "create_and_assign") && !internalAgentId)}
                    eventPlaceholder="paperclip.issue.status_changed"
                  />
                ) : (
                  <EntityRow
                    title={rule.name}
                    leading={<Zap className="h-3.5 w-3.5 text-primary/50" />}
                    subtitle={`${ruleSummary(rule)}${typeof rule.action?.agentId === "string" ? ` · ${agentMap.get(String(rule.action.agentId)) ?? rule.action.agentId}` : ""}`}
                    onClick={() => startEditInternalRule(rule)}
                    trailing={
                      <div className="flex items-center gap-2">
                        {!rule.enabled && (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">Off</Badge>
                        )}
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); startEditInternalRule(rule); }}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="text-destructive/70 hover:text-destructive"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!window.confirm(`Delete internal rule "${rule.name}"?`)) return;
                            deleteRuleMutation.mutate(rule.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    }
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {(endpointsQuery.error || rulesQuery.error || eventsQuery.error || companyRulesQuery.error) && (
        <p className="text-sm text-destructive">
          {(endpointsQuery.error as Error)?.message ||
            (rulesQuery.error as Error)?.message ||
            (eventsQuery.error as Error)?.message ||
            (companyRulesQuery.error as Error)?.message}
        </p>
      )}
    </div>
  );
}

// ── Shared rule form component ──

interface RuleFormCardProps {
  mode: "create" | "edit";
  name: string; setName: (v: string) => void;
  eventType: string; setEventType: (v: string) => void;
  actionType: ActionType; setActionType: (v: ActionType) => void;
  agentId: string; setAgentId: (v: string) => void;
  reason: string; setReason: (v: string) => void;
  titleTemplate: string; setTitleTemplate: (v: string) => void;
  descriptionTemplate: string; setDescriptionTemplate: (v: string) => void;
  enabled: boolean; setEnabled: (v: boolean) => void;
  agents: { id: string; name: string }[];
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  onSave: () => void;
  onCancel: () => void;
  disableSave: boolean;
  eventPlaceholder?: string;
}

function RuleFormCard({
  mode, name, setName, eventType, setEventType, actionType, setActionType,
  agentId, setAgentId, reason, setReason, titleTemplate, setTitleTemplate,
  descriptionTemplate, setDescriptionTemplate, enabled, setEnabled,
  agents, isPending, isError, error, onSave, onCancel, disableSave,
  eventPlaceholder = "pull_request.opened",
}: RuleFormCardProps) {
  const isEdit = mode === "edit";

  return (
    <div className={`border rounded-md p-4 space-y-3 ${isEdit ? "border-primary/30 bg-primary/[0.02]" : "border-border/60 bg-muted/30"}`}>
      {isEdit && (
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Editing Rule</span>
          <Button size="icon-sm" variant="ghost" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>
      )}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Rule name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="PR opened -> reviewer" />
        </div>
        <div className="space-y-1.5">
          <Label>Match event</Label>
          <Input value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder={eventPlaceholder} />
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Action</Label>
          <Select value={actionType} onValueChange={(value) => setActionType(value as ActionType)}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Select action" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="wake_agent">Wake Agent</SelectItem>
              <SelectItem value="create_issue">Create Issue</SelectItem>
              <SelectItem value="create_and_assign">Create + Assign + Wake</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {(actionType === "wake_agent" || actionType === "create_and_assign") && (
          <div className="space-y-1.5">
            <Label>Agent</Label>
            <Select value={agentId || undefined} onValueChange={setAgentId}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select an agent" /></SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        <Label>Reason (optional)</Label>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="pr_review_requested" />
      </div>
      {(actionType === "create_issue" || actionType === "create_and_assign") && (
        <>
          <div className="space-y-1.5">
            <Label>Issue title template</Label>
            <Input value={titleTemplate} onChange={(e) => setTitleTemplate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Issue description template</Label>
            <Textarea value={descriptionTemplate} onChange={(e) => setDescriptionTemplate(e.target.value)} rows={3} />
          </div>
        </>
      )}
      {isEdit && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${enabled ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
          </button>
          <Label className="text-sm cursor-pointer" onClick={() => setEnabled(!enabled)}>
            {enabled ? "Enabled" : "Disabled"}
          </Label>
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <Button size="sm" onClick={onSave} disabled={disableSave || isPending}>
          {isPending ? "Saving..." : isEdit ? "Update Rule" : "Save Rule"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      {isError && error && (
        <p className="text-xs text-destructive">{error.message}</p>
      )}
    </div>
  );
}
