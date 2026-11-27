import {eq,sql} from "drizzle-orm";
import {mcpOauthDeviceRequests as devices,mcpOauthGrants as grants,type Db} from "@paperclipai/db";
import type {CompanyDeletionParticipant} from "../../lib/company-deletion.js";
import {prepareMcpClientMutation} from "./client-mirror-mutations.js";

export const mcpCompanyDeletion:CompanyDeletionParticipant={async deleteCompanyData(runner,companyId){
  const tx=runner as unknown as Db;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(736721042)`);
  const [affected]=await tx.select({id:devices.id}).from(devices).innerJoin(grants,eq(devices.grantId,grants.id)).where(eq(grants.companyId,companyId)).limit(1);
  if(affected)await prepareMcpClientMutation(tx);
}};
