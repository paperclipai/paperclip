import type { Db } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import { secretService } from "../secrets.js";
import { RuntimeServiceFault } from "./fault.js";
import type { createRuntimeServiceManager } from "./manager.js";

type Hooks = Required<Pick<Parameters<typeof createRuntimeServiceManager>[1], "persistEnvironment" | "resolveEnvironment">>;

/** Bind credentials to the durable service, never to its originating run. */
export function createRuntimeServiceCredentials(db: Db): Hooks {
  const secrets = secretService(db);
  return {
    async persistEnvironment(tx, row, actor) {
      if (actor.type !== "board" && Object.values(row.spec.env).some((binding) => binding.type === "secret_ref")) {
        throw forbidden("An operator must authorize secret bindings for this service. Create it without credentials, then ask the operator to configure its environment.");
      }
      const scoped = secretService(tx);
      // Inline text is for ordinary configuration. Known sensitive keys must
      // reference an encrypted company secret rather than live in the spec.
      await scoped.normalizeEnvBindingsForPersistence(row.companyId, row.spec.env, { strictMode: true });
      await scoped.syncEnvBindingsForTarget(row.companyId, { targetType: "runtime_service", targetId: row.id }, row.spec.env, { db: tx });
    },
    async resolveEnvironment(row) {
      try {
        const resolved = await secrets.resolveEnvBindings(row.companyId, row.spec.env, {
          consumerType: "runtime_service", consumerId: row.id,
          actorType: "system", actorId: "runtime-services", issueId: row.issueId,
        });
        return { env: resolved.env, secrets: [...resolved.secretKeys].map((key) => resolved.env[key]!) };
      } catch {
        // Provider errors may contain a value or remote reference. Only the
        // product fault crosses into service events and the ordinary DTO.
        throw new RuntimeServiceFault("credentials_unavailable");
      }
    },
  };
}
