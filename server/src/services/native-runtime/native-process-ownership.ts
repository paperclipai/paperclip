import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import type { AdapterProcessSpawnMetadata } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { readProcessStartedAt } from "../hot-restart.js";
import { runtimeServiceRunScopeSchema } from "../runtime-services/run-attachment.js";

type Sink = (metadata: AdapterProcessSpawnMetadata) => Promise<void>;

/** One live session owns this relay; each run supplies its own persistence sink.
 * No process identity is recovered from agent-writable checkpoint files. */
export class NativeProcessOwnership {
  #metadata: AdapterProcessSpawnMetadata | undefined;
  #binding: { token: symbol; sink?: Sink } | null = null;
  #pending: Promise<void> = Promise.resolve();
  #closed = false;
  constructor(private readonly readLocalBirth = readProcessStartedAt) {}

  #enqueue(work: () => Promise<void>) {
    const pending = this.#pending.then(work);
    this.#pending = pending.catch(() => undefined);
    return pending;
  }

  readonly record = (value: AdapterProcessSpawnMetadata): Promise<void> => {
    const metadata = structuredClone(value);
    const binding = this.#binding;
    return this.#enqueue(async () => {
      if (this.#closed) throw new Error("native_process_owner_closed");
      if (metadata.processLocation === "remote") {
        metadata.processGroupId = null;
        this.#metadata = structuredClone(metadata);
      } else {
        // Normalize local birth once so a recycled host PID can never become
        // the next run's owner merely because it occupies the same number.
        const birth = await this.readLocalBirth(metadata.pid);
        if (birth) metadata.startedAt = birth;
        this.#metadata = birth ? structuredClone(metadata) : undefined;
      }
      if (binding && binding === this.#binding) await binding.sink?.(metadata);
    });
  };

  bind(token: symbol, sink?: Sink) {
    if (this.#closed) throw new Error("native_process_owner_closed");
    const binding = { token, sink };
    this.#binding = binding;
    return this.#enqueue(async () => {
      if (binding !== this.#binding || !this.#metadata) return;
      const metadata = structuredClone(this.#metadata);
      if (metadata.processLocation !== "remote") {
        const birth = await this.readLocalBirth(metadata.pid);
        if (!birth || new Date(birth).getTime() !== new Date(metadata.startedAt).getTime()) {
          this.#metadata = undefined;
          return;
        }
      }
      if (binding === this.#binding) await binding.sink?.(metadata);
    });
  }

  async release(token: symbol) {
    if (this.#binding?.token !== token) return;
    this.#binding = null;
    await this.#pending;
  }

  close() {
    this.#closed = true;
    this.#binding = null;
    this.#metadata = undefined;
  }
}

/** Lease-row IDs rotate between runs; physical allocation and connection must
 * remain the same before an in-memory process/session can be reused. */
export async function nativeProcessOwnershipScope(db: Pick<Db, "select">, companyId: string, target?: AdapterExecutionTarget | null): Promise<string | null> {
  if (!target || target.kind === "local") return "local";
  if (target.transport === "ssh") return createHash("sha256").update(JSON.stringify({ transport: "ssh", spec: target.spec, cwd: target.remoteCwd })).digest("hex");
  if (!target.leaseId) return null;
  const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, target.leaseId), eq(environmentLeases.companyId, companyId)));
  if (!lease?.providerLeaseId || lease.environmentId !== target.environmentId || lease.provider !== target.providerKey) return null;
  const scope = runtimeServiceRunScopeSchema.safeParse(lease.metadata?.runtimeServiceRunScope);
  if (target.providerKey === "daytona" && (!scope.success || scope.data.companyId !== companyId || scope.data.environmentId !== lease.environmentId || scope.data.pluginId !== lease.metadata?.pluginId)) return null;
  return createHash("sha256").update(JSON.stringify({ companyId, environmentId: lease.environmentId, provider: lease.provider,
    providerLeaseId: lease.providerLeaseId, cwd: target.remoteCwd, connection: scope.success ? scope.data.connection : null,
  })).digest("hex");
}
