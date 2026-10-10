import type { Db } from "@paperclipai/db";
import { secretService } from "../../services/secrets.js";
import { computerRepository } from "./adapters/repository.js";
import { boatBackend } from "./adapters/boat.js";
import { createComputerService } from "./application/service.js";
export { ComputerError } from "./domain/ledger.js";
export type {
  OwnerRef as ComputerOwnerRef,
  ProcessClaim as ComputerProcessClaim,
} from "./domain/ledger.js";
export type ComputerService = ReturnType<typeof createComputerService>;
export type ComputerBinding = Awaited<ReturnType<ComputerService["admit"]>>;
const services = new WeakMap<Db, ComputerService>();
export function computerService(db: Db): ComputerService {
  const existing = services.get(db);
  if (existing) return existing;
  const secrets = secretService(db);
  const service = createComputerService(
    computerRepository(db),
    boatBackend((record) =>
      secrets.resolveSecretValue(
        record.companyId,
        record.ledger.secretRef.secretId,
        record.ledger.secretRef.version ?? "latest",
        {
          consumerType: "environment",
          consumerId: record.environmentId,
          configPath: "apiKeySecretRef",
          actorType: "system",
          actorId: null,
        },
      ),
    ),
  );
  services.set(db, service);
  return service;
}
