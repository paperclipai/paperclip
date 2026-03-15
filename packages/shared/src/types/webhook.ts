export type WebhookEndpointProvider = "github" | "slack" | "email" | "generic";
export type WebhookEndpointStatus = "active" | "paused" | "disabled";
export type EventRoutingSource = "webhook" | "internal";
export type WebhookEventStatus = "received" | "matched" | "dispatched" | "ignored" | "error";

export interface WebhookEndpoint {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  provider: WebhookEndpointProvider;
  secret: string;
  status: WebhookEndpointStatus;
  metadata: Record<string, unknown> | null;
  eventCount: number;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventRoutingRule {
  id: string;
  companyId: string;
  endpointId: string | null;
  source: EventRoutingSource;
  name: string;
  priority: number;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  cooldownSec: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEvent {
  id: string;
  companyId: string;
  endpointId: string | null;
  matchedRuleId: string | null;
  source: EventRoutingSource;
  provider: string;
  eventType: string;
  payload: Record<string, unknown>;
  headers: Record<string, unknown> | null;
  resultAction: Record<string, unknown> | null;
  status: WebhookEventStatus;
  error: string | null;
  createdAt: string;
}
