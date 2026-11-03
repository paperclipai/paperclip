import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import type { AgentLifecycleRequest } from "@paperclipai/shared";
import { secretService } from "./secrets.js";
import { persistActivity } from "./activity-log.js";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";

type Scope = { companyId: string; agentId: string; pluginId: string };

export function agentInstanceSecretService(db: Db) {
  return {
    async read(scope: Scope): Promise<Record<string, string>> {
      try { return await secretService(db).agentInstance.read(scope); }
      catch { throw new Error("Agent instance secret unavailable"); }
    },
    async apply(request: AgentLifecycleRequest, pluginId: string, changes: unknown, attemptOwner: string | undefined): Promise<void> {
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("Invalid agent instance secret changes");
      const entries = Object.entries(changes);
      if (entries.length > 16 || entries.some(([key, value]) => !/^[a-z][a-z0-9_]{0,63}$/.test(key) ||
        (value !== null && (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 65_536)))) throw new Error("Invalid agent instance secret changes");
      const scope = { companyId: request.companyId, agentId: request.agentId, pluginId };
      await withAccountHomeSecretMutationLock(undefined, request.companyId, () => db.transaction(async tx => {
        const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, request.companyId), eq(agents.id, request.agentId))).for("update");
        const leaseUntil = Date.parse(agent?.lifecycleOperation?.leaseUntil ?? "");
        if (!agent || agent.lifecycleVersion !== request.version || agent.lifecycleState !== request.phase ||
          agent.lifecycleOperation?.id !== request.operationId || !agent.lifecycleRequiredPluginIds?.includes(pluginId) ||
          !attemptOwner || agent.lifecycleOperation.leaseOwner !== attemptOwner || !Number.isFinite(leaseUntil) || leaseUntil <= Date.now()) {
          throw new Error("Agent instance secret operation is stale or outside scope");
        }
        if (entries.some(([, value]) => value !== null) && !["preparing", "resuming"].includes(request.phase)) throw new Error("Agent instance secrets require preparation or resume");
        for (const [key, value] of entries) {
          try { await secretService(tx).agentInstance.set(scope, key, value as string | null); }
          catch { throw new Error("Agent instance secret storage unavailable"); }
          await persistActivity(tx as unknown as Db, { companyId: request.companyId, actorType: "plugin", actorId: pluginId,
            action: value === null ? "agent.instance_secret.removed" : "agent.instance_secret.saved", entityType: "agent", entityId: request.agentId,
            details: { key } });
        }
      }));
    },
  };
}
