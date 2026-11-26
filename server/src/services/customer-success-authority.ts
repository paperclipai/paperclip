import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import type { RunAuthority } from "@paperclipai/shared";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { agentRunWritesRevoked } from "../agent-run-cancellation.js";
import { forbidden } from "../errors.js";
import { agentIdentityService, supportsManagedAgentIdentity } from "./agent-identity.js";

/**
 * The one rule for "this agent's run is live", shared by run authority and
 * the Cloud run liveness check so the two can never disagree.
 */
function isActiveAgentRun(
  agent: { status: string } | undefined,
  run: (typeof heartbeatRuns.$inferSelect) | undefined,
): run is typeof heartbeatRuns.$inferSelect {
  return Boolean(
    agent &&
      ["idle", "running", "active"].includes(agent.status) &&
      run &&
      run.status === "running" &&
      !run.finishedAt &&
      !agentRunWritesRevoked(run),
  );
}

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
        !isActiveAgentRun(agent, run)
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

/**
 * Cloud run liveness check for inspection authority: is this run of this
 * agent in this company active right now? It uses the run rules of
 * `customerSuccessRunAuthority` but needs no agent credential or managed
 * identity key, because Cloud asks with its own signed question. Read-only;
 * it creates no actor, session, activity or key.
 */
export async function customerSuccessRunLiveness(
  db: Db,
  question: { companyId: string; agentId: string; runId: string },
): Promise<boolean> {
  return db.transaction(
    async (tx) => {
      const [agent] = await tx
        .select({ status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, question.agentId), eq(agents.companyId, question.companyId)));
      const [run] = await tx
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, question.runId),
            eq(heartbeatRuns.agentId, question.agentId),
            eq(heartbeatRuns.companyId, question.companyId),
          ),
        );
      return isActiveAgentRun(agent, run);
    },
    { accessMode: "read only" },
  );
}
