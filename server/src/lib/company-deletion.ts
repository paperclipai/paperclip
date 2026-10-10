import type { Db } from "@paperclipai/db";

type CompanyDeletionTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface CompanyDeletionParticipant {
  // The caller holds the company lock and removes dependent records first.
  // Use this transaction only. Throw on failure. Do not call external systems.
  deleteCompanyData(tx: CompanyDeletionTransaction, companyId: string): Promise<void>;
}
