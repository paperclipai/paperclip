import type {
  CloudflareConnection,
  CloudflareZone,
  MailAddress,
  MailDomain,
  MailReverseDnsStatus,
} from "@paperclipai/shared";
import { api } from "./client";

export interface CreateMailAddressInput {
  domainId: string;
  localPart: string;
  kind?: "mailbox" | "alias" | "catch_all";
  agentId?: string | null;
}

/** Embedded mail: Cloudflare connection + attached mail domains (phase 0). */
export const mailApi = {
  getCloudflareConnection: (companyId: string) =>
    api.get<CloudflareConnection | null>(`/companies/${companyId}/integrations/cloudflare`),
  connectCloudflare: (companyId: string, apiToken: string, cfAccountId?: string) =>
    api.post<CloudflareConnection>(`/companies/${companyId}/integrations/cloudflare`, {
      apiToken,
      ...(cfAccountId ? { cfAccountId } : {}),
    }),
  disconnectCloudflare: (companyId: string) =>
    api.delete<void>(`/companies/${companyId}/integrations/cloudflare`),
  listZones: (companyId: string) =>
    api.get<CloudflareZone[]>(`/companies/${companyId}/integrations/cloudflare/zones`),

  listDomains: (companyId: string) =>
    api.get<MailDomain[]>(`/companies/${companyId}/mail/domains`),
  attachDomain: (companyId: string, domain: string) =>
    api.post<MailDomain>(`/companies/${companyId}/mail/domains`, { domain }),
  verifyDomain: (companyId: string, id: string) =>
    api.post<MailDomain>(`/companies/${companyId}/mail/domains/${id}/verify`, {}),
  removeDomain: (companyId: string, id: string) =>
    api.delete<void>(`/companies/${companyId}/mail/domains/${id}`),

  getReverseDns: (companyId: string, refresh = false) =>
    api.get<MailReverseDnsStatus>(
      `/companies/${companyId}/mail/reverse-dns${refresh ? "?refresh=true" : ""}`,
    ),

  listAddresses: (companyId: string) =>
    api.get<MailAddress[]>(`/companies/${companyId}/mail/addresses`),
  createAddress: (companyId: string, input: CreateMailAddressInput) =>
    api.post<MailAddress>(`/companies/${companyId}/mail/addresses`, input),
  removeAddress: (companyId: string, id: string) =>
    api.delete<void>(`/companies/${companyId}/mail/addresses/${id}`),
};
