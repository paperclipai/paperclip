import type {
  WebhookEndpoint,
  WebhookEndpointListItem,
  WebhookDelivery,
} from "@paperclipai/shared";
import { api } from "./client";

export const webhooksApi = {
  list: (companyId: string) =>
    api.get<WebhookEndpointListItem[]>(`/companies/${companyId}/webhooks`),

  create: (companyId: string, data: { name: string; url: string; eventTypes: string[]; active?: boolean }) =>
    api.post<WebhookEndpoint>(`/companies/${companyId}/webhooks`, data),

  get: (id: string, companyId: string) =>
    api.get<WebhookEndpoint>(`/webhooks/${id}?companyId=${encodeURIComponent(companyId)}`),

  update: (id: string, companyId: string, data: { name?: string; url?: string; eventTypes?: string[]; active?: boolean }) =>
    api.patch<WebhookEndpoint>(`/webhooks/${id}?companyId=${encodeURIComponent(companyId)}`, data),

  delete: (id: string, companyId: string) =>
    api.delete<void>(`/webhooks/${id}?companyId=${encodeURIComponent(companyId)}`),

  test: (id: string, companyId: string) =>
    api.post<{ deliveryId: string }>(`/webhooks/${id}/test?companyId=${encodeURIComponent(companyId)}`, {}),

  listDeliveries: (webhookId: string, companyId: string) =>
    api.get<WebhookDelivery[]>(`/webhooks/${webhookId}/deliveries?companyId=${encodeURIComponent(companyId)}`),

  retryDelivery: (deliveryId: string, companyId: string) =>
    api.post<{ deliveryId: string }>(`/webhook-deliveries/${deliveryId}/retry?companyId=${encodeURIComponent(companyId)}`, {}),
};
