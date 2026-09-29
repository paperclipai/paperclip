import { api } from "./client";
import type {
  EmailConnectionInput,
  ToolConnection,
  EmailEndpointSummary,
  EmailPublicationSummary,
  EmailThreadSummary,
  EmailSendInput,
  EmailEndpointSetupInput,
} from "@paperclipai/shared";
export const emailApi = {
  connect: (companyId: string, input: EmailConnectionInput) =>
    api.post<ToolConnection>(
      `/companies/${companyId}/email/connections`,
      input,
    ),
  inspectSaved: (companyId: string, connectionId: string) =>
    api.post<{
      scope: { scope_type: string };
      inboxes: { inbox_id: string }[];
      domains: { domain_id: string; domain: string; status: string }[];
    }>(`/companies/${companyId}/email/connections/${connectionId}/inspect`, {}),
  list: (companyId: string) =>
    api.get<EmailEndpointSummary[]>(`/companies/${companyId}/email/inboxes`),
  setup: (companyId: string, input: EmailEndpointSetupInput) =>
    api.post<EmailEndpointSummary>(
      `/companies/${companyId}/email/inboxes`,
      input,
    ),
  inspect: (companyId: string, apiKey: string) =>
    api.post<{
      inboxes: { inbox_id: string }[];
      domains: { domain_id: string; domain: string; status: string }[];
    }>(`/companies/${companyId}/email/inspect`, { apiKey }),
  control: (id: string, action: "pause" | "resume" | "remove") =>
    api.post<EmailEndpointSummary>(`/email/inboxes/${id}/control`, { action }),
  reconnect: (
    id: string,
    apiKey: string,
    receiveMode: "websocket" | "webhook",
  ) =>
    api.post<EmailEndpointSummary>(`/email/inboxes/${id}/reconnect`, {
      apiKey,
      receiveMode,
    }),
  resolve: (
    companyId: string,
    id: string,
    outcome: "sent" | "failed",
    providerMessageId?: string,
  ) =>
    api.post<EmailPublicationSummary>(
      `/companies/${companyId}/email/deliveries/${id}/resolve`,
      { outcome, providerMessageId },
    ),
  thread: (companyId: string, issueId: string) =>
    api.get<EmailThreadSummary | null>(
      `/companies/${companyId}/email/tasks/${issueId}`,
    ),
  send: (companyId: string, input: EmailSendInput) =>
    api.post<EmailPublicationSummary>(
      `/companies/${companyId}/email/send`,
      input,
    ),
};
