import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { webhooksApi } from "../api/webhooks";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import type { WebhookDelivery, WebhookEndpointListItem } from "@paperclipai/shared";
import { WEBHOOK_EVENT_TYPES } from "@paperclipai/shared";

const EVENT_TYPE_LABELS: Record<string, string> = {
  "alert.created": "Alert Created",
  "alert.resolved": "Alert Resolved",
  "alert.escalated": "Alert Escalated",
  "frs.threshold_exceeded": "FRS Threshold Exceeded",
  "frs.threshold_cleared": "FRS Threshold Cleared",
  "annotation.created": "Annotation Created",
  "incident.opened": "Incident Opened",
  "incident.closed": "Incident Closed",
};

const STATUS_STYLES: Record<string, string> = {
  success: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  retrying: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  pending: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
};

function AddWebhookDialog({
  companyId,
  onClose,
}: {
  companyId: string;
  onClose: () => void;
}) {
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(new Set());
  const [testResult, setTestResult] = useState<"idle" | "testing" | "ok" | "error">("idle");

  const createMutation = useMutation({
    mutationFn: () =>
      webhooksApi.create(companyId, {
        name,
        url,
        eventTypes: Array.from(selectedEvents) as never,
        active: true,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.list(companyId) });
      showToast({ title: "Webhook created", variant: "success" });
      onClose();
    },
    onError: () => showToast({ title: "Failed to create webhook", variant: "error" }),
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      if (!url) throw new Error("URL required");
      const tempWebhook = await webhooksApi.create(companyId, {
        name: name || "temp-test",
        url,
        eventTypes: ["ping" as never],
        active: true,
      });
      const result = await webhooksApi.test(tempWebhook.id, companyId);
      await webhooksApi.delete(tempWebhook.id, companyId);
      return result;
    },
    onSuccess: () => {
      setTestResult("ok");
      setTimeout(() => setTestResult("idle"), 3000);
    },
    onError: () => {
      setTestResult("error");
      setTimeout(() => setTestResult("idle"), 3000);
    },
  });

  function toggleEvent(eventType: string) {
    setSelectedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventType)) next.delete(eventType);
      else next.add(eventType);
      return next;
    });
  }

  const canSubmit = name.trim() && url.trim() && selectedEvents.size > 0;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Add Webhook</h2>

          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="My webhook endpoint"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">URL</label>
            <div className="flex gap-2">
              <input
                type="url"
                className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="https://example.com/webhook"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!url || testMutation.isPending}
                onClick={() => {
                  setTestResult("testing");
                  testMutation.mutate();
                }}
              >
                {testMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : testResult === "ok" ? (
                  <Check className="h-3 w-3 text-green-500" />
                ) : testResult === "error" ? (
                  <X className="h-3 w-3 text-red-500" />
                ) : (
                  "Test"
                )}
              </Button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Events</label>
            <div className="grid grid-cols-2 gap-2">
              {WEBHOOK_EVENT_TYPES.map((eventType) => (
                <label key={eventType} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedEvents.has(eventType)}
                    onChange={() => toggleEvent(eventType)}
                    className="rounded"
                  />
                  {EVENT_TYPE_LABELS[eventType] ?? eventType}
                </label>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!canSubmit || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Create Webhook
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeliveryLogDrawer({
  webhook,
  companyId,
  onClose,
}: {
  webhook: WebhookEndpointListItem;
  companyId: string;
  onClose: () => void;
}) {
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [expandedPayload, setExpandedPayload] = useState<string | null>(null);

  const { data: deliveries = [], isLoading } = useQuery({
    queryKey: queryKeys.webhooks.deliveries(webhook.id, companyId),
    queryFn: () => webhooksApi.listDeliveries(webhook.id, companyId),
    refetchInterval: 5_000,
  });

  const retryMutation = useMutation({
    mutationFn: (deliveryId: string) => webhooksApi.retryDelivery(deliveryId, companyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.deliveries(webhook.id, companyId) });
      showToast({ title: "Retry queued", variant: "success" });
    },
    onError: () => showToast({ title: "Retry failed", variant: "error" }),
  });

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-[520px] border-l border-border bg-background shadow-xl flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h3 className="font-semibold text-sm">{webhook.name}</h3>
          <p className="text-xs text-muted-foreground truncate max-w-[350px]">{webhook.url}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No deliveries yet</p>
        ) : (
          deliveries.map((d: WebhookDelivery) => (
            <div key={d.id} className="rounded-md border border-border bg-card p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[d.status] ?? ""}`}>
                  {d.status}
                </span>
                <span className="text-xs text-muted-foreground font-mono">{d.eventType}</span>
                {d.httpStatus && (
                  <span className={`text-xs font-mono ${d.httpStatus >= 200 && d.httpStatus < 300 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                    HTTP {d.httpStatus}
                  </span>
                )}
                {d.latencyMs !== null && (
                  <span className="text-xs text-muted-foreground">{d.latencyMs}ms</span>
                )}
                <span className="text-xs text-muted-foreground ml-auto">
                  attempt {d.attempt}/3
                </span>
              </div>

              {d.error && (
                <p className="text-xs text-red-600 dark:text-red-400 font-mono truncate">{d.error}</p>
              )}

              <div className="flex items-center gap-2">
                <button
                  className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground"
                  onClick={() => setExpandedPayload(expandedPayload === d.id ? null : d.id)}
                >
                  {expandedPayload === d.id ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  Payload
                </button>
                {(d.status === "failed" || d.status === "retrying") && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-xs"
                    disabled={retryMutation.isPending}
                    onClick={() => retryMutation.mutate(d.id)}
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Retry
                  </Button>
                )}
              </div>

              {expandedPayload === d.id && (
                <pre className="text-xs bg-muted/30 rounded p-2 overflow-x-auto max-h-40">
                  {JSON.stringify(d.payload, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function WebhookCard({
  webhook,
  companyId,
  onViewDeliveries,
}: {
  webhook: WebhookEndpointListItem;
  companyId: string;
  onViewDeliveries: () => void;
}) {
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);

  const toggleMutation = useMutation({
    mutationFn: () => webhooksApi.update(webhook.id, companyId, { active: !webhook.active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.list(companyId) }),
    onError: () => showToast({ title: "Failed to update webhook", variant: "error" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => webhooksApi.delete(webhook.id, companyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.list(companyId) });
      showToast({ title: "Webhook deleted", variant: "success" });
    },
    onError: () => showToast({ title: "Failed to delete webhook", variant: "error" }),
  });

  const testMutation = useMutation({
    mutationFn: () => webhooksApi.test(webhook.id, companyId),
    onSuccess: () => showToast({ title: "Test ping sent", variant: "success" }),
    onError: () => showToast({ title: "Test failed", variant: "error" }),
  });

  async function copyUrl() {
    await navigator.clipboard.writeText(webhook.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm">{webhook.name}</h3>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${webhook.active ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" : "bg-muted text-muted-foreground"}`}>
                {webhook.active ? "Active" : "Inactive"}
              </span>
              {webhook.consecutiveFailures > 0 && (
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  {webhook.consecutiveFailures} failure{webhook.consecutiveFailures !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 mt-1">
              <span className="text-xs text-muted-foreground font-mono truncate max-w-[320px]">
                {webhook.url}
              </span>
              <button onClick={copyUrl} className="text-muted-foreground hover:text-foreground shrink-0">
                {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-1">
          {webhook.eventTypes.map((et) => (
            <span key={et} className="text-xs bg-muted px-2 py-0.5 rounded-full">
              {EVENT_TYPE_LABELS[et] ?? et}
            </span>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={onViewDeliveries}>
            <ExternalLink className="h-3 w-3 mr-1" />
            Delivery Log
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={testMutation.isPending}
            onClick={() => testMutation.mutate()}
          >
            {testMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              "Test"
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={toggleMutation.isPending}
            onClick={() => toggleMutation.mutate()}
          >
            {webhook.active ? "Disable" : "Enable"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteMutation.mutate()}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function DeveloperPortal() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [selectedWebhook, setSelectedWebhook] = useState<WebhookEndpointListItem | null>(null);

  setBreadcrumbs([{ label: "Developer Portal" }]);

  const { data: webhooks, isLoading } = useQuery({
    queryKey: queryKeys.webhooks.list(selectedCompanyId!),
    queryFn: () => webhooksApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) return null;

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Developer Portal</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage webhook endpoints for Solaris event delivery
          </p>
        </div>
        <Button onClick={() => setShowAddDialog(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Webhook
        </Button>
      </div>

      {webhooks && webhooks.length === 0 ? (
        <EmptyState
          icon={Webhook}
          title="No webhooks yet"
          description="Add a webhook to receive Solaris events (alerts, incidents, annotations) at your endpoint."
          action={
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Webhook
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {webhooks?.map((webhook) => (
            <WebhookCard
              key={webhook.id}
              webhook={webhook}
              companyId={selectedCompanyId}
              onViewDeliveries={() => setSelectedWebhook(webhook)}
            />
          ))}
        </div>
      )}

      {showAddDialog && (
        <AddWebhookDialog companyId={selectedCompanyId} onClose={() => setShowAddDialog(false)} />
      )}

      {selectedWebhook && (
        <DeliveryLogDrawer
          webhook={selectedWebhook}
          companyId={selectedCompanyId}
          onClose={() => setSelectedWebhook(null)}
        />
      )}
    </div>
  );
}
