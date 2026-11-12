import { assertVoiceInboundCleanupSettled } from "../voice/voice-inbound-cleanup.js";
import { chatEndpoints } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { CompanyDeletionParticipant } from "../../lib/company-deletion.js";

export const chatCompanyDeletion: CompanyDeletionParticipant = {
  async deleteCompanyData(tx, companyId) {
    // Ingress locks the endpoint before admitting a provider call. Hold that
    // lock through the cleanup proof and delete so a new call cannot slip in.
    await tx.select({ id: chatEndpoints.id }).from(chatEndpoints).where(eq(chatEndpoints.companyId, companyId)).for("update");
    await assertVoiceInboundCleanupSettled(tx, companyId);
    await tx.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId));
  },
};
