import type { PluginEntitiesClient, PluginEntityRecord } from "@paperclipai/plugin-sdk";
import { ENTITY_TYPES } from "../constants.js";
import type { InvoiceData } from "../types.js";

export type InvoicesService = ReturnType<typeof createInvoicesService>;

export function createInvoicesService(entities: PluginEntitiesClient) {
  return {
    async upsert(stripeInvoiceId: string, data: InvoiceData): Promise<PluginEntityRecord> {
      return entities.upsert({
        entityType: ENTITY_TYPES.stripeInvoice,
        externalId: stripeInvoiceId,
        scopeKind: "instance",
        title: `Invoice ${stripeInvoiceId}`,
        status: data.status,
        data,
      });
    },

    async listForAccount(billingAccountExternalId: string): Promise<PluginEntityRecord[]> {
      const all = await entities.list({
        entityType: ENTITY_TYPES.stripeInvoice,
        scopeKind: "instance",
        limit: 50,
      });
      return all.filter((e) => (e.data as InvoiceData).billingAccountExternalId === billingAccountExternalId);
    },
  };
}
