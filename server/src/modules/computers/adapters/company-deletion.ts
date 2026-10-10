import { eq } from "drizzle-orm";
import { computers } from "@paperclipai/db";
import type { CompanyDeletionParticipant } from "../../../lib/company-deletion.js";
import { ComputerError, liveOwners, type Ledger } from "../domain/ledger.js";

export const computerCompanyDeletion: CompanyDeletionParticipant = {
  async deleteCompanyData(tx, companyId) {
    const records = await tx.select().from(computers).where(eq(computers.companyId, companyId)).for("update");
    for (const record of records) {
      const ledger = record.ledger as unknown as Ledger;
      if (ledger.status !== "detached" || ledger.action || liveOwners(ledger).length) {
        throw new ComputerError("conflict", "Detach company computers and wait for their snapshots before deleting the company");
      }
    }
    await tx.delete(computers).where(eq(computers.companyId, companyId));
  },
};
