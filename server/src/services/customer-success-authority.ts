import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import type { RunAuthority } from "@paperclipai/shared";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { agentRunWritesRevoked } from "../agent-run-cancellation.js";
import { forbidden } from "../errors.js";
import { agentIdentityService, supportsManagedAgentIdentity } from "./agent-identity.js";

/** No actor/session resolution, key provisioning, or run identity capture. */
export async function customerSuccessRunAuthority(db: Db, bearer: string): Promise<RunAuthority> {
  const claims = verifyLocalAgentJwt(bearer, { strictRunAuthority: true });
  if (!claims) throw forbidden("A current managed-run credential is required");
  return db.transaction(
    async (tx) => {
      const [agent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, claims.sub), eq(agents.companyId, claims.company_id)));
      const [run] = await tx
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, claims.run_id),
            eq(heartbeatRuns.agentId, claims.sub),
            eq(heartbeatRuns.companyId, claims.company_id),
          ),
        );
      if (
        !agent ||
        !supportsManagedAgentIdentity(agent.adapterType, agent.adapterConfig, run?.driverKind) ||
        !["idle", "running", "active"].includes(agent.status) ||
        !run ||
        run.status !== "running" ||
        run.finishedAt ||
        agentRunWritesRevoked(run)
      )
        throw forbidden("The managed run is not active");
      const identity = await agentIdentityService(tx as unknown as Db).getPublicIdentity(
        agent.companyId,
        agent.id,
      );
      if (!identity) throw forbidden("The agent identity is unprovisioned");
      return {
        version: 1,
        instanceId: claims.instance_id!,
        companyId: agent.companyId,
        agentId: agent.id,
        runId: run.id,
        keyId: identity.keyId,
        active: true,
      };
    },
    { accessMode: "read only" },
  );
}
