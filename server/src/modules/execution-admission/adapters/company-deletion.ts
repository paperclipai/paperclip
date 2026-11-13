import { executionAdmissions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { CompanyDeletionParticipant } from "../../../lib/company-deletion.js";

/** Removes every admission, settled or not, before the company's runs and projects are deleted. */
export const executionAdmissionCompanyDeletion: CompanyDeletionParticipant = {
  async deleteCompanyData(tx, companyId) {
    if (!("nestedIndex" in tx)) throw new Error("Company deletion requires a database transaction");
    await tx.delete(executionAdmissions).where(eq(executionAdmissions.companyId, companyId));
  },
};
