import type { PluginEntitiesClient, PluginStateClient, PluginEntityRecord } from "@paperclipai/plugin-sdk";
import { ENTITY_TYPES, STATE_KEYS, BILLING_NAMESPACE } from "../constants.js";
import type { BillingAccountData } from "../types.js";

export type AccountsService = ReturnType<typeof createAccountsService>;

export function createAccountsService(entities: PluginEntitiesClient, state: PluginStateClient) {
  return {
    async create(stripeCustomerId: string, data: BillingAccountData): Promise<PluginEntityRecord> {
      return entities.upsert({
        entityType: ENTITY_TYPES.billingAccount,
        externalId: stripeCustomerId,
        scopeKind: "instance",
        title: data.name,
        status: data.status,
        data,
      });
    },

    async update(stripeCustomerId: string, data: Partial<BillingAccountData>): Promise<PluginEntityRecord> {
      const existing = await this.getByCustomerId(stripeCustomerId);
      if (!existing) throw new Error(`Billing account not found for customer ${stripeCustomerId}`);
      const merged = { ...existing.data, ...data };
      return entities.upsert({
        entityType: ENTITY_TYPES.billingAccount,
        externalId: stripeCustomerId,
        scopeKind: "instance",
        title: (merged as BillingAccountData).name,
        status: (merged as BillingAccountData).status,
        data: merged,
      });
    },

    async getByCustomerId(stripeCustomerId: string): Promise<PluginEntityRecord | null> {
      const results = await entities.list({
        entityType: ENTITY_TYPES.billingAccount,
        scopeKind: "instance",
        externalId: stripeCustomerId,
        limit: 1,
      });
      return results[0] ?? null;
    },

    async findByCompanyId(companyId: string): Promise<PluginEntityRecord | null> {
      const customerId = await state.get({
        scopeKind: "company",
        scopeId: companyId,
        namespace: BILLING_NAMESPACE,
        stateKey: STATE_KEYS.stripeCustomerId,
      }) as string | null;
      if (!customerId) return null;

      const results = await entities.list({
        entityType: ENTITY_TYPES.billingAccount,
        scopeKind: "instance",
        externalId: customerId,
        limit: 1,
      });
      return results[0] ?? null;
    },

    async listAll(): Promise<PluginEntityRecord[]> {
      return entities.list({
        entityType: ENTITY_TYPES.billingAccount,
        scopeKind: "instance",
        limit: 100,
      });
    },

    async linkCompany(companyId: string, billingAccountId: string, stripeCustomerId: string): Promise<void> {
      await state.set(
        { scopeKind: "company", scopeId: companyId, namespace: BILLING_NAMESPACE, stateKey: STATE_KEYS.billingAccountId },
        billingAccountId,
      );
      await state.set(
        { scopeKind: "company", scopeId: companyId, namespace: BILLING_NAMESPACE, stateKey: STATE_KEYS.stripeCustomerId },
        stripeCustomerId,
      );
    },

    async unlinkCompany(companyId: string): Promise<void> {
      await state.set(
        { scopeKind: "company", scopeId: companyId, namespace: BILLING_NAMESPACE, stateKey: STATE_KEYS.billingAccountId },
        null,
      );
      await state.set(
        { scopeKind: "company", scopeId: companyId, namespace: BILLING_NAMESPACE, stateKey: STATE_KEYS.stripeCustomerId },
        null,
      );
    },
  };
}
