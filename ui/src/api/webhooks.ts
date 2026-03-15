import type { EventRoutingRule, WebhookEndpoint, WebhookEvent } from "@paperclipai/shared";
import { api } from "./client";

export const webhooksApi = {
  listEndpoints: (companyId: string) =>
    api.get<WebhookEndpoint[]>(`/companies/${encodeURIComponent(companyId)}/webhooks`),
  createEndpoint: (
    companyId: string,
    data: {
      name: string;
      slug: string;
      provider: "github" | "slack" | "email" | "generic";
      secret?: string;
      status?: "active" | "paused" | "disabled";
      metadata?: Record<string, unknown> | null;
    },
  ) => api.post<WebhookEndpoint>(`/companies/${encodeURIComponent(companyId)}/webhooks`, data),
  updateEndpoint: (
    endpointId: string,
    data: Partial<{
      name: string;
      slug: string;
      provider: "github" | "slack" | "email" | "generic";
      secret: string | null;
      status: "active" | "paused" | "disabled";
      metadata: Record<string, unknown> | null;
    }>,
  ) => api.patch<WebhookEndpoint>(`/webhooks/${encodeURIComponent(endpointId)}`, data),
  deleteEndpoint: (endpointId: string) =>
    api.delete<{ ok: true }>(`/webhooks/${encodeURIComponent(endpointId)}`),
  listRulesForEndpoint: (endpointId: string) =>
    api.get<EventRoutingRule[]>(`/webhooks/${encodeURIComponent(endpointId)}/rules`),
  createRuleForEndpoint: (
    endpointId: string,
    data: {
      source?: "webhook" | "internal";
      name: string;
      priority?: number;
      condition: Record<string, unknown>;
      action: Record<string, unknown>;
      cooldownSec?: number;
      enabled?: boolean;
    },
  ) => api.post<EventRoutingRule>(`/webhooks/${encodeURIComponent(endpointId)}/rules`, data),
  listRulesForCompany: (companyId: string) =>
    api.get<EventRoutingRule[]>(`/companies/${encodeURIComponent(companyId)}/webhook-rules`),
  createRuleForCompany: (
    companyId: string,
    data: {
      endpointId?: string | null;
      source?: "webhook" | "internal";
      name: string;
      priority?: number;
      condition: Record<string, unknown>;
      action: Record<string, unknown>;
      cooldownSec?: number;
      enabled?: boolean;
    },
  ) => api.post<EventRoutingRule>(`/companies/${encodeURIComponent(companyId)}/webhook-rules`, data),
  updateRule: (
    ruleId: string,
    data: Partial<{
      endpointId: string | null;
      source: "webhook" | "internal";
      name: string;
      priority: number;
      condition: Record<string, unknown>;
      action: Record<string, unknown>;
      cooldownSec: number;
      enabled: boolean;
    }>,
  ) => api.patch<EventRoutingRule>(`/webhook-rules/${encodeURIComponent(ruleId)}`, data),
  deleteRule: (ruleId: string) =>
    api.delete<{ ok: true }>(`/webhook-rules/${encodeURIComponent(ruleId)}`),
  listEventsForEndpoint: (endpointId: string, limit = 100) =>
    api.get<WebhookEvent[]>(`/webhooks/${encodeURIComponent(endpointId)}/events?limit=${encodeURIComponent(String(limit))}`),
  listEventsForCompany: (companyId: string, opts?: { endpointId?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (opts?.endpointId) search.set("endpointId", opts.endpointId);
    if (opts?.limit) search.set("limit", String(opts.limit));
    const qs = search.toString();
    return api.get<WebhookEvent[]>(
      `/companies/${encodeURIComponent(companyId)}/webhook-events${qs ? `?${qs}` : ""}`,
    );
  },
};
