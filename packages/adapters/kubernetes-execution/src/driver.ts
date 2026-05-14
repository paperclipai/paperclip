import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { AdapterKubernetesExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { ensureTenantNamespace, type EnsureTenantInput } from "./orchestrator/ensure-tenant.js";
import { createKubernetesApiClient } from "./client.js";
import type { ResolvedClusterConnection } from "./types.js";

export interface KubernetesDriverDeps {
  resolveConnection: (id: string) => Promise<ResolvedClusterConnection | null>;
}

export type EnsureTenantDriverInput = Omit<EnsureTenantInput, "connection"> & {
  clusterConnectionId: string;
};

export interface KubernetesExecutionDriver {
  type: "kubernetes";
  validateTarget(target: unknown): Promise<void>;
  ensureTenant(input: EnsureTenantDriverInput): Promise<{ namespace: string; ciliumApplied: boolean }>;
  run(input: {
    ctx: AdapterExecutionContext;
    target: AdapterKubernetesExecutionTarget;
  }): Promise<AdapterExecutionResult>;
}

export function createKubernetesExecutionDriver(deps: KubernetesDriverDeps): KubernetesExecutionDriver {
  return {
    type: "kubernetes",

    async validateTarget(target) {
      const t = target as { kind?: string; clusterConnectionId?: string };
      if (t.kind !== "kubernetes") {
        throw new Error(
          `KubernetesExecutionDriver received target with kind=${t.kind ?? "(none)"}, expected "kubernetes"`,
        );
      }
      if (!t.clusterConnectionId) {
        throw new Error(`KubernetesExecutionDriver target is missing clusterConnectionId`);
      }
      const connection = await deps.resolveConnection(t.clusterConnectionId);
      if (!connection) {
        throw new Error(`Cluster connection ${t.clusterConnectionId} not found`);
      }
    },

    async ensureTenant({ clusterConnectionId, ...rest }) {
      const connection = await deps.resolveConnection(clusterConnectionId);
      if (!connection) {
        throw new Error(`Cluster connection ${clusterConnectionId} not found`);
      }
      const client = createKubernetesApiClient(connection);
      return ensureTenantNamespace(client, { connection, ...rest });
    },

    async run() {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorCode: "execution_target_not_yet_supported",
        errorMessage:
          "Kubernetes agent execution lands in M2; M1 covers tenant provisioning only. " +
          "Use the cluster CLI (`paperclipai cluster ensure-tenant`) to provision a namespace.",
      };
    },
  };
}
