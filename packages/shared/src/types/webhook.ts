export type WebhookEventType =
  | "alert.created"
  | "alert.resolved"
  | "alert.escalated"
  | "frs.threshold_exceeded"
  | "frs.threshold_cleared"
  | "annotation.created"
  | "incident.opened"
  | "incident.closed"
  | "ping";

export type WebhookDeliveryStatus = "pending" | "success" | "failed" | "retrying";

export interface WebhookEndpoint {
  id: string;
  companyId: string;
  name: string;
  url: string;
  secret: string;
  eventTypes: WebhookEventType[];
  active: boolean;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookEndpointListItem {
  id: string;
  companyId: string;
  name: string;
  url: string;
  eventTypes: WebhookEventType[];
  active: boolean;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventType: WebhookEventType;
  status: WebhookDeliveryStatus;
  attempt: number;
  nextAttemptAt: Date | null;
  httpStatus: number | null;
  latencyMs: number | null;
  payloadHash: string;
  payload: Record<string, unknown>;
  responseBody: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  org_id: string;
  data: Record<string, unknown>;
}
