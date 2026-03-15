import { useEffect, useMemo, useState } from "react";
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
import { Webhook, Plus, Trash2 } from "lucide-react";

type Provider = "github" | "slack" | "email" | "generic";
type ActionType = "wake_agent" | "create_issue" | "create_and_assign";

function ruleSummary(rule: EventRoutingRule) {
  const conditionEvent =
    typeof rule.condition?.event === "string" ? String(rule.condition.event) : "any event";
  const actionType = typeof rule.action?.type === "string" ? String(rule.action.type) : "unknown action";
  return `${conditionEvent} -> ${actionType}`;
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

export function Webhooks() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  const [showEndpointForm, setShowEndpointForm] = useState(false);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [showInternalRuleForm, setShowInternalRuleForm] = useState(false);

  const [endpointName, setEndpointName] = useState("");
  const [endpointSlug, setEndpointSlug] = useState("");
  const [endpointProvider, setEndpointProvider] = useState<Provider>("github");
  const [endpointSecret, setEndpointSecret] = useState("");

  const [ruleName, setRuleName] = useState("");
  const [ruleEventType, setRuleEventType] = useState("pull_request.opened");
  const [ruleActionType, setRuleActionType] = useState<ActionType>("wake_agent");
  const [ruleAgentId, setRuleAgentId] = useState("");
  const [ruleReason, setRuleReason] = useState("");
  const [ruleTitleTemplate, setRuleTitleTemplate] = useState("Automation task: {{eventType}}");
  const [ruleDescriptionTemplate, setRuleDescriptionTemplate] = useState(
    "Triggered by {{provider}} event {{eventType}}.",
  );

  const [internalRuleName, setInternalRuleName] = useState("");
  const [internalEventType, setInternalEventType] = useState("paperclip.issue.status_changed");
  const [internalActionType, setInternalActionType] = useState<ActionType>("wake_agent");
  const [internalAgentId, setInternalAgentId] = useState("");
  const [internalReason, setInternalReason] = useState("");
  const [internalTitleTemplate, setInternalTitleTemplate] = useState("Internal automation: {{eventType}}");
  const [internalDescriptionTemplate, setInternalDescriptionTemplate] = useState(
    "Triggered by internal event {{eventType}}.",
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Webhooks" }]);
  }, [setBreadcrumbs]);

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
      setRuleName("");
      setRuleReason("");
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
      setInternalRuleName("");
      setInternalReason("");
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: (ruleId: string) => webhooksApi.deleteRule(ruleId),
    onSuccess: () => invalidateWebhookQueries(),
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Webhook} message="Select a company to manage webhook automation." />;
  }

  if (endpointsQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const endpointRules = rulesQuery.data ?? [];
  const endpointEvents = eventsQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <section className="space-y-3 xl:col-span-1">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Endpoints</h2>
            <Button size="sm" variant="outline" onClick={() => setShowEndpointForm((v) => !v)}>
              <Plus className="h-4 w-4 mr-1" />
              New
            </Button>
          </div>

          {showEndpointForm && (
            <div className="border border-border rounded-md p-3 space-y-2 bg-muted/30">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={endpointName} onChange={(e) => setEndpointName(e.target.value)} placeholder="GitHub Main" />
              </div>
              <div className="space-y-1">
                <Label>Slug</Label>
                <Input value={endpointSlug} onChange={(e) => setEndpointSlug(e.target.value)} placeholder="github-main" />
              </div>
              <div className="space-y-1">
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
              <div className="space-y-1">
                <Label>Secret (optional)</Label>
                <Input value={endpointSecret} onChange={(e) => setEndpointSecret(e.target.value)} placeholder="autogenerated when empty" />
              </div>
              <div className="flex gap-2">
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
            <EmptyState icon={Webhook} message="No webhook endpoints yet." />
          ) : (
            <div className="border border-border divide-y divide-border">
              {endpoints.map((endpoint: WebhookEndpoint) => (
                <EntityRow
                  key={endpoint.id}
                  title={endpoint.name}
                  subtitle={`/${endpoint.slug}/receive`}
                  onClick={() => setSelectedEndpointId(endpoint.id)}
                  className={selectedEndpointId === endpoint.id ? "bg-accent/40" : undefined}
                  trailing={
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="capitalize">
                        {endpoint.provider}
                      </Badge>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!window.confirm(`Delete endpoint "${endpoint.name}"?`)) return;
                          deleteEndpointMutation.mutate(endpoint.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  }
                />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3 xl:col-span-2">
          {!selectedEndpoint ? (
            <EmptyState icon={Webhook} message="Select an endpoint to view rules and events." />
          ) : (
            <>
              <div className="border border-border rounded-md p-4 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">{selectedEndpoint.name}</h3>
                    <p className="text-xs text-muted-foreground font-mono">
                      /api/webhooks/{selectedEndpoint.slug}/receive
                    </p>
                  </div>
                  <Badge variant="outline" className="capitalize">
                    {selectedEndpoint.provider}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <span>Events received: {selectedEndpoint.eventCount}</span>
                  <span>
                    Last event: {selectedEndpoint.lastEventAt ? new Date(selectedEndpoint.lastEventAt).toLocaleString() : "never"}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Routing Rules</h4>
                    <Button size="sm" variant="outline" onClick={() => setShowRuleForm((v) => !v)}>
                      <Plus className="h-4 w-4 mr-1" />
                      Add Rule
                    </Button>
                  </div>

                  {showRuleForm && (
                    <div className="border border-border rounded-md p-3 space-y-2 bg-muted/30">
                      <div className="space-y-1">
                        <Label>Rule name</Label>
                        <Input value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder="PR opened -> reviewer" />
                      </div>
                      <div className="space-y-1">
                        <Label>Match event</Label>
                        <Input value={ruleEventType} onChange={(e) => setRuleEventType(e.target.value)} placeholder="pull_request.opened" />
                      </div>
                      <div className="space-y-1">
                        <Label>Action</Label>
                        <Select value={ruleActionType} onValueChange={(value) => setRuleActionType(value as ActionType)}>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select action" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="wake_agent">Wake Agent</SelectItem>
                            <SelectItem value="create_issue">Create Issue</SelectItem>
                            <SelectItem value="create_and_assign">Create + Assign + Wake</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {(ruleActionType === "wake_agent" || ruleActionType === "create_and_assign") && (
                        <div className="space-y-1">
                          <Label>Agent</Label>
                          <Select value={ruleAgentId || undefined} onValueChange={setRuleAgentId}>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select an agent" />
                            </SelectTrigger>
                            <SelectContent>
                              {agents.map((agent) => (
                                <SelectItem key={agent.id} value={agent.id}>
                                  {agent.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      <div className="space-y-1">
                        <Label>Reason (optional)</Label>
                        <Input value={ruleReason} onChange={(e) => setRuleReason(e.target.value)} placeholder="pr_review_requested" />
                      </div>
                      {(ruleActionType === "create_issue" || ruleActionType === "create_and_assign") && (
                        <>
                          <div className="space-y-1">
                            <Label>Issue title template</Label>
                            <Input value={ruleTitleTemplate} onChange={(e) => setRuleTitleTemplate(e.target.value)} />
                          </div>
                          <div className="space-y-1">
                            <Label>Issue description template</Label>
                            <Textarea value={ruleDescriptionTemplate} onChange={(e) => setRuleDescriptionTemplate(e.target.value)} rows={3} />
                          </div>
                        </>
                      )}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => createEndpointRuleMutation.mutate()}
                          disabled={
                            !ruleName.trim() ||
                            !ruleEventType.trim() ||
                            ((ruleActionType === "wake_agent" || ruleActionType === "create_and_assign") && !ruleAgentId) ||
                            createEndpointRuleMutation.isPending
                          }
                        >
                          {createEndpointRuleMutation.isPending ? "Saving..." : "Save Rule"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setShowRuleForm(false)}>Cancel</Button>
                      </div>
                    </div>
                  )}

                  {rulesQuery.isLoading ? (
                    <PageSkeleton variant="list" />
                  ) : endpointRules.length === 0 ? (
                    <div className="border border-border p-3 text-sm text-muted-foreground">No rules for this endpoint.</div>
                  ) : (
                    <div className="border border-border divide-y divide-border">
                      {endpointRules.map((rule) => (
                        <EntityRow
                          key={rule.id}
                          title={rule.name}
                          subtitle={ruleSummary(rule)}
                          trailing={
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">P{rule.priority}</span>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                className="text-destructive hover:text-destructive"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (!window.confirm(`Delete rule "${rule.name}"?`)) return;
                                  deleteRuleMutation.mutate(rule.id);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Event Log</h4>
                  {eventsQuery.isLoading ? (
                    <PageSkeleton variant="list" />
                  ) : endpointEvents.length === 0 ? (
                    <div className="border border-border p-3 text-sm text-muted-foreground">No events yet.</div>
                  ) : (
                    <div className="border border-border divide-y divide-border max-h-[520px] overflow-y-auto">
                      {endpointEvents.map((event: WebhookEvent) => (
                        <div key={event.id} className="px-3 py-2 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="truncate">
                              <p className="text-sm font-medium truncate">{event.eventType}</p>
                              <p className="text-[11px] text-muted-foreground">
                                {new Date(event.createdAt).toLocaleString()}
                              </p>
                            </div>
                            <StatusBadge status={event.status} />
                          </div>
                          {event.matchedRuleId && (
                            <p className="text-[11px] text-muted-foreground font-mono">rule: {event.matchedRuleId}</p>
                          )}
                          {event.error && (
                            <p className="text-xs text-destructive">{event.error}</p>
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

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Internal Rules</h2>
          <Button size="sm" variant="outline" onClick={() => setShowInternalRuleForm((v) => !v)}>
            <Plus className="h-4 w-4 mr-1" />
            New Internal Rule
          </Button>
        </div>

        {showInternalRuleForm && (
          <div className="border border-border rounded-md p-3 space-y-2 bg-muted/30">
            <div className="grid md:grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>Rule name</Label>
                <Input value={internalRuleName} onChange={(e) => setInternalRuleName(e.target.value)} placeholder="Done issue -> wake QA" />
              </div>
              <div className="space-y-1">
                <Label>Internal event</Label>
                <Input value={internalEventType} onChange={(e) => setInternalEventType(e.target.value)} placeholder="paperclip.issue.status_changed" />
              </div>
            </div>
            <div className="grid md:grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>Action</Label>
                <Select
                  value={internalActionType}
                  onValueChange={(value) => setInternalActionType(value as ActionType)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select action" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="wake_agent">Wake Agent</SelectItem>
                    <SelectItem value="create_issue">Create Issue</SelectItem>
                    <SelectItem value="create_and_assign">Create + Assign + Wake</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(internalActionType === "wake_agent" || internalActionType === "create_and_assign") && (
                <div className="space-y-1">
                  <Label>Agent</Label>
                  <Select value={internalAgentId || undefined} onValueChange={setInternalAgentId}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select an agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label>Reason (optional)</Label>
              <Input value={internalReason} onChange={(e) => setInternalReason(e.target.value)} placeholder="qa_followup" />
            </div>
            {(internalActionType === "create_issue" || internalActionType === "create_and_assign") && (
              <>
                <div className="space-y-1">
                  <Label>Issue title template</Label>
                  <Input value={internalTitleTemplate} onChange={(e) => setInternalTitleTemplate(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Issue description template</Label>
                  <Textarea value={internalDescriptionTemplate} onChange={(e) => setInternalDescriptionTemplate(e.target.value)} rows={3} />
                </div>
              </>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => createInternalRuleMutation.mutate()}
                disabled={
                  !internalRuleName.trim() ||
                  !internalEventType.trim() ||
                  ((internalActionType === "wake_agent" || internalActionType === "create_and_assign") && !internalAgentId) ||
                  createInternalRuleMutation.isPending
                }
              >
                {createInternalRuleMutation.isPending ? "Saving..." : "Save Internal Rule"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowInternalRuleForm(false)}>Cancel</Button>
            </div>
          </div>
        )}

        {internalRules.length === 0 ? (
          <div className="border border-border p-3 text-sm text-muted-foreground">No internal rules yet.</div>
        ) : (
          <div className="border border-border divide-y divide-border">
            {internalRules.map((rule) => (
              <EntityRow
                key={rule.id}
                title={rule.name}
                subtitle={`${ruleSummary(rule)}${typeof rule.action?.agentId === "string" ? ` · ${agentMap.get(String(rule.action.agentId)) ?? rule.action.agentId}` : ""}`}
                trailing={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!window.confirm(`Delete internal rule "${rule.name}"?`)) return;
                      deleteRuleMutation.mutate(rule.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                }
              />
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
