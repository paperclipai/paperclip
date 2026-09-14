import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { activityLog, builtInManagedResources, environmentLeases, environments, runtimeServiceAllocations, runtimeServiceEvents, runtimeServices, type Db } from "@paperclipai/db";
import type { CreateRuntimeService } from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { parseEnvironmentDriverConfig, resolveEnvironmentDriverConfigForRuntime, stripSandboxProviderEnvelope } from "../environment-config.js";
import { resolveActiveEnvironmentCustomImageTemplateForRuntime } from "../environment-custom-image-runtime.js";
import { collectSecretRefPaths, isUuidSecretRef } from "../json-schema-secret-refs.js";
import { resolvePluginSandboxProviderDriverByKey } from "../plugin-environment-driver.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import type { RuntimeServicePlacement } from "./manager.js";
import { lockRuntimeServiceEnvironment } from "./retention.js";
import { RuntimeServiceFault } from "./fault.js";

type Reader = Pick<Db, "select">;
const hasResourceRequest = (config: Record<string, unknown>) => ["cpu", "memory", "disk", "gpu"].some((key) => config[key] !== undefined && config[key] !== null && config[key] !== "");
export const runtimeServiceAllocationRequestSchema = z.object({
  version: z.literal(1), environmentId: z.string().guid(), pluginId: z.string().guid(), pluginKey: z.string(),
  baseConfig: z.record(z.string(), z.unknown()), launchConfig: z.record(z.string(), z.unknown()), requestedCwd: z.string(),
});
export type RuntimeServiceAllocationRequest = z.infer<typeof runtimeServiceAllocationRequestSchema>;

/** Use inside the environment lock too: a stale catalog response cannot cross companies. */
export async function assertServiceEnvironmentCompany(db: Reader, companyId: string, environmentId: string) {
  const bindings = await db.select({ companyId: builtInManagedResources.companyId }).from(builtInManagedResources)
    .where(and(eq(builtInManagedResources.resourceKind, "environment"), eq(builtInManagedResources.resourceId, environmentId)));
  if (bindings.length && !bindings.some((binding) => binding.companyId === companyId)) throw forbidden("The selected environment belongs to another company");
}

export function createRuntimeServiceProvisioning(db: Db, worker: PluginWorkerManager | undefined) {
  function requireWorker(pluginId: string) {
    const methods = new Set(worker?.getWorker(pluginId)?.supportedMethods ?? []);
    if (!worker?.isRunning(pluginId) || !["environmentGetServiceConnection", "environmentAcquireServiceLease", "environmentService"].every((method) => methods.has(method))) {
      throw unprocessable("The environment provider must support durable service allocation before creating this service");
    }
    return worker;
  }

  return {
    async placement(companyId: string, input: CreateRuntimeService, actorId: string): Promise<RuntimeServicePlacement> {
      if (!input.environmentId) throw unprocessable("Choose an environment for this service");
      const [environment] = await db.select().from(environments).where(eq(environments.id, input.environmentId));
      if (!environment) throw notFound("Environment not found");
      await assertServiceEnvironmentCompany(db, companyId, environment.id);
      if (environment.status !== "active") throw unprocessable("The selected environment is not active");
      if (environment.driver !== "sandbox") throw unprocessable("This environment cannot allocate managed services");
      const parsed = parseEnvironmentDriverConfig({ driver: "sandbox", config: environment.config });
      if (parsed.driver !== "sandbox" || parsed.config.provider !== "daytona") throw unprocessable("This environment cannot allocate managed services");
      const providerConfig: Record<string, unknown> = { ...parsed.config };
      if (typeof providerConfig.apiKey === "string" && providerConfig.apiKey && !isUuidSecretRef(providerConfig.apiKey)) throw unprocessable("Store the environment's provider credential as a secret reference before allocating a service");
      if (providerConfig.networkBlockAll === true || providerConfig.networkAllowList || providerConfig.domainAllowList) throw unprocessable("This service allocation path cannot yet preserve the environment's network restrictions");
      const provider = await resolvePluginSandboxProviderDriverByKey({ db, driverKey: "daytona", workerManager: worker, requireRunning: true });
      if (!provider) throw unprocessable("The Daytona provider is unavailable");
      requireWorker(provider.plugin.id);
      // Apply the operator's custom image to references, before resolving any
      // credentials. Only references/configuration are persisted in the claim.
      const launchConfig = await resolveActiveEnvironmentCustomImageTemplateForRuntime(db, {
        environmentId: environment.id, baseConfig: parsed.config, runtimeConfig: parsed.config,
        secretRefExcludePaths: collectSecretRefPaths(provider.driver.configSchema),
      });
      const hasAcceptedRequest = async () => Boolean((await db.select({ id: runtimeServices.id }).from(runtimeServices)
        .where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.creationKey, `board:${actorId}:${input.requestId}`))).limit(1))[0]);
      if (hasResourceRequest({ ...launchConfig }) && !await hasAcceptedRequest()) {
        const runtime = await resolveEnvironmentDriverConfigForRuntime(db, companyId, { id: environment.id, driver: "sandbox", config: { ...launchConfig } });
        if (runtime.driver !== "sandbox") throw unprocessable("Service provider configuration is unavailable");
        // No allocation exists yet. The request UUID scopes this read-only
        // preflight; its connection fingerprint is not used for acquisition.
        try {
          const result = await requireWorker(provider.plugin.id).call(provider.plugin.id, "environmentGetServiceConnection", {
            driverKey: "daytona", companyId, environmentId: environment.id, serviceAllocationId: input.requestId,
            checkResources: true, config: stripSandboxProviderEnvelope(runtime.config),
          }, 15_000);
          if (result.resourcesVerified !== true) throw new RuntimeServiceFault("resource_configuration_mismatch");
        } catch {
          // An accepted response may have been lost, or a concurrent copy may
          // have committed during preflight. The manager still compares the
          // complete input/placement hash before returning that original record.
          if (!await hasAcceptedRequest()) throw unprocessable(new RuntimeServiceFault("resource_configuration_mismatch").message);
        }
      }
      const request: RuntimeServiceAllocationRequest = {
        version: 1, environmentId: environment.id, pluginId: provider.plugin.id, pluginKey: provider.plugin.pluginKey,
        baseConfig: environment.config, launchConfig: { ...launchConfig }, requestedCwd: input.cwd ?? ".",
      };
      return { provider: "daytona", cwd: input.cwd ?? ".", reuseKey: `service:${companyId}:${actorId}:${input.requestId}`,
        ownedEnvironment: request, metadata: { allocationRequest: request } };
    },

    async ensure(companyId: string, allocationId: string) {
      const [snapshot] = await db.select().from(runtimeServiceAllocations)
        .where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.id, allocationId)));
      if (!snapshot?.metadata.allocationRequest || snapshot.dataDeletionId || snapshot.metadata.provisionedAt) return;
      if (!snapshot.metadata.acquisitionStarted) {
        const [consumer] = await db.select({ id: runtimeServices.id }).from(runtimeServices)
          .where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.allocationId, allocationId), eq(runtimeServices.desiredState, "running"))).limit(1);
        if (!consumer) return;
      }
      const request = runtimeServiceAllocationRequestSchema.parse(snapshot.metadata.allocationRequest);
      const activeWorker = requireWorker(request.pluginId);
      // Resolve credentials and query the provider without holding a database
      // connection or preventing Stop/environment controls from making progress.
      await assertServiceEnvironmentCompany(db, companyId, request.environmentId);
      const runtime = await resolveEnvironmentDriverConfigForRuntime(db, companyId, { id: request.environmentId, driver: "sandbox", config: request.launchConfig });
      if (runtime.driver !== "sandbox" || runtime.config.provider !== "daytona") throw unprocessable("Service provider configuration is unavailable");
      const config = stripSandboxProviderEnvelope(runtime.config);
      const connection = await activeWorker.call(request.pluginId, "environmentGetServiceConnection", {
        driverKey: "daytona", companyId, environmentId: request.environmentId, serviceAllocationId: allocationId, config,
        ...(!snapshot.metadata.acquisitionStarted && hasResourceRequest(request.launchConfig) ? { checkResources: true } : {}),
      }, 15_000);
      const fingerprint = z.string().regex(/^[a-f0-9]{64}$/).parse(connection.fingerprint);
      const prepared = await db.transaction(async (tx) => {
        const [allocation] = await tx.select().from(runtimeServiceAllocations).where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.id, allocationId))).for("update");
        if (!allocation?.metadata.allocationRequest || allocation.dataDeletionId || allocation.metadata.provisionedAt) return null;
        if (JSON.stringify(allocation.metadata.allocationRequest) !== JSON.stringify(snapshot.metadata.allocationRequest)) throw conflict("Service allocation configuration changed");
        await lockRuntimeServiceEnvironment(tx, request.environmentId);
        const [environment] = await tx.select().from(environments).where(eq(environments.id, request.environmentId)).for("update");
        if (!environment || environment.status !== "active") throw unprocessable("The service environment is unavailable");
        await assertServiceEnvironmentCompany(tx, companyId, request.environmentId);
        if (!allocation.metadata.acquisitionStarted) {
          const [consumer] = await tx.select({ id: runtimeServices.id }).from(runtimeServices)
            .where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.allocationId, allocationId), eq(runtimeServices.desiredState, "running"))).limit(1);
          if (!consumer) return null;
          if (hasResourceRequest(request.launchConfig) && connection.resourcesVerified !== true) throw new RuntimeServiceFault("resource_configuration_mismatch");
        } else if (allocation.metadata.serviceConnectionFingerprint !== fingerprint) throw new RuntimeServiceFault("provider_connection_changed");
        const [lease] = allocation.environmentLeaseId ? await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, allocation.environmentLeaseId), eq(environmentLeases.companyId, companyId))).for("update") : [];
        if (!lease || lease.providerLeaseId) throw conflict("Service allocation identity changed");
        if (!allocation.metadata.acquisitionStarted) await tx.update(runtimeServiceAllocations)
          .set({ metadata: { ...allocation.metadata, acquisitionStarted: true, serviceConnectionFingerprint: fingerprint } }).where(eq(runtimeServiceAllocations.id, allocationId));
        return { allocation, lease };
      });
      if (!prepared) return;
      // Intent, connection identity and the provider's idempotent allocation UUID
      // are committed. A crash/lost response recovers this same named resource.
      const result = await activeWorker.call(request.pluginId, "environmentAcquireServiceLease", {
        driverKey: "daytona", companyId, environmentId: request.environmentId, runId: allocationId,
        serviceAllocationId: allocationId, serviceConnectionFingerprint: fingerprint, config,
      }, 90_000);
      if (!result.providerLeaseId && result.metadata?.resourceConfigurationMismatch === true) throw new RuntimeServiceFault("resource_configuration_mismatch");
      if (!result.providerLeaseId) throw new Error("The provider did not return the service allocation identity");
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(runtimeServiceAllocations).where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.id, allocationId))).for("update");
        if (!current || current.dataDeletionId || current.environmentLeaseId !== prepared.lease.id || current.metadata.serviceConnectionFingerprint !== fingerprint
          || JSON.stringify(current.metadata.allocationRequest) !== JSON.stringify(snapshot.metadata.allocationRequest)) throw conflict("Service allocation identity changed before its receipt was saved");
        const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, prepared.lease.id), eq(environmentLeases.companyId, companyId))).for("update");
        if (!lease || (lease.providerLeaseId && lease.providerLeaseId !== result.providerLeaseId)) throw conflict("Service allocation provider identity changed");
        // A concurrent recovery may already have stored this exact receipt.
        if (current.metadata.provisionedAt) return;
        const allocation = current;
        const services = await tx.select().from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.allocationId, allocationId)));
        const remoteRoot = typeof result.metadata?.remoteCwd === "string" ? result.metadata.remoteCwd : "";
        let provisioningError = result.expiresAt ? "retention_unavailable" : !path.posix.isAbsolute(remoteRoot) ? "launch_unavailable" : null;
        const cwd = path.posix.isAbsolute(remoteRoot) ? path.posix.resolve(remoteRoot, request.requestedCwd) : request.requestedCwd;
        const relative = path.posix.relative(remoteRoot, cwd);
        if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) provisioningError = "launch_unavailable";
        // Only the small provider identity receipt is persisted, never arbitrary
        // worker metadata (which can contain resolved connection credentials).
        const workspaceSentinel = z.object({ path: z.string().max(4096), token: z.string().max(128), result: z.enum(["written", "matched"]) })
          .safeParse(result.metadata?.workspaceSentinel);
        if (!workspaceSentinel.success) provisioningError = "supervisor_lost";
        const boundary = { version: 1, provider: "daytona", workspaceRoot: remoteRoot, executionWorkspaceId: allocation.executionWorkspaceId, network: "enabled" };
        const now = new Date();
        await tx.update(environmentLeases).set({ providerLeaseId: result.providerLeaseId, status: "retained", acquiredAt: now, updatedAt: now,
          metadata: { ...request.launchConfig, driver: "sandbox", provider: "daytona", sandboxProviderPlugin: true, pluginId: request.pluginId,
            pluginKey: request.pluginKey, serviceAllocationId: allocation.id, remoteCwd: remoteRoot,
            shellCommand: result.metadata?.shellCommand === "sh" ? "sh" : "bash", workspaceSentinel: workspaceSentinel.success ? workspaceSentinel.data : null,
            runtimeServiceBoundary: boundary },
        }).where(eq(environmentLeases.id, lease.id));
        await tx.update(runtimeServiceAllocations).set({ cwd, metadata: { ...current.metadata, executionBoundary: boundary, provisioningError, provisionedAt: now.toISOString() }, updatedAt: now }).where(eq(runtimeServiceAllocations.id, allocation.id));
        if (!provisioningError) await tx.update(runtimeServices).set({ spec: sql`jsonb_set(${runtimeServices.spec}, '{cwd}', to_jsonb(${cwd}::text))` })
          .where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.allocationId, allocation.id)));
        for (const service of services) await tx.insert(runtimeServiceEvents).values({ companyId, serviceId: service.id, kind: "allocation_ready",
          actor: { type: "system", id: "runtime-services" }, revision: service.revision, details: { allocationId } });
        await tx.insert(activityLog).values({ companyId, actorType: "system", actorId: "runtime-services", action: "runtime_service.allocation_ready",
          entityType: "runtime_service_allocation", entityId: allocationId, details: { serviceIds: services.map((service) => service.id), verified: !provisioningError } });
      });
    },
  };
}
