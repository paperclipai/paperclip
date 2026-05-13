import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clusterConnections } from "@paperclipai/db";
import type { ResolvedClusterConnection, ClusterCapabilities } from "@paperclipai/execution-target-kubernetes";

export interface ClusterConnectionRow {
  id: string;
  label: string;
  kind: "in-cluster" | "kubeconfig";
  kubeconfigSecretRef: { provider: string; name: string } | null;
  apiServerUrl: string | null;
  defaultNamespacePrefix: string;
  capabilities: ClusterCapabilities;
  paperclipPublicUrl: string | null;
  imageRegistry: string | null;
  allowAgentImageOverride: boolean;
  imageAllowlist: string[];
  createdAt: Date;
  createdBy: string;
}

export interface CreateClusterConnectionInput {
  label: string;
  kind: "in-cluster" | "kubeconfig";
  kubeconfigSecretRef?: { provider: string; name: string };
  apiServerUrl?: string;
  defaultNamespacePrefix?: string;
  capabilities: ClusterCapabilities;
  paperclipPublicUrl?: string;
  imageRegistry?: string;
  allowAgentImageOverride?: boolean;
  createdBy: string;
}

export interface ClusterConnectionsServiceDeps {
  resolveSecret: (ref: { provider: string; name: string }) => Promise<string>;
}

export interface UpdateClusterConnectionInput {
  label?: string;
  kubeconfigSecretRef?: { provider: string; name: string } | null;
  apiServerUrl?: string | null;
  defaultNamespacePrefix?: string;
  capabilities?: ClusterCapabilities;
  paperclipPublicUrl?: string | null;
  imageRegistry?: string | null;
  allowAgentImageOverride?: boolean;
  imageAllowlist?: string[];
}

export interface ClusterConnectionsService {
  create(input: CreateClusterConnectionInput): Promise<ClusterConnectionRow>;
  list(): Promise<ClusterConnectionRow[]>;
  get(id: string): Promise<ClusterConnectionRow | null>;
  update(id: string, input: UpdateClusterConnectionInput): Promise<ClusterConnectionRow | null>;
  delete(id: string): Promise<void>;
  resolve(id: string): Promise<ResolvedClusterConnection | null>;
}

export function clusterConnectionsService(db: Db, deps: ClusterConnectionsServiceDeps): ClusterConnectionsService {
  return {
    async create(input) {
      try {
        const [row] = await db.insert(clusterConnections).values({
          label: input.label,
          kind: input.kind,
          kubeconfigSecretRef: input.kubeconfigSecretRef ?? null,
          apiServerUrl: input.apiServerUrl ?? null,
          defaultNamespacePrefix: input.defaultNamespacePrefix ?? "paperclip-",
          capabilities: input.capabilities,
          paperclipPublicUrl: input.paperclipPublicUrl ?? null,
          imageRegistry: input.imageRegistry ?? null,
          allowAgentImageOverride: input.allowAgentImageOverride ? "true" : "false",
          createdBy: input.createdBy,
        }).returning();
        return mapRow(row);
      } catch (err) {
        if (/cluster_connections_label_uq/.test(String(err))) {
          throw new Error(`A cluster connection with label "${input.label}" already exists`);
        }
        throw err;
      }
    },

    async list() {
      const rows = await db.select().from(clusterConnections);
      return rows.map(mapRow);
    },

    async get(id) {
      const [row] = await db.select().from(clusterConnections).where(eq(clusterConnections.id, id));
      return row ? mapRow(row) : null;
    },

    async update(id, input) {
      const [row] = await db.update(clusterConnections).set({
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.kubeconfigSecretRef !== undefined ? { kubeconfigSecretRef: input.kubeconfigSecretRef } : {}),
        ...(input.apiServerUrl !== undefined ? { apiServerUrl: input.apiServerUrl } : {}),
        ...(input.defaultNamespacePrefix !== undefined ? { defaultNamespacePrefix: input.defaultNamespacePrefix } : {}),
        ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
        ...(input.paperclipPublicUrl !== undefined ? { paperclipPublicUrl: input.paperclipPublicUrl } : {}),
        ...(input.imageRegistry !== undefined ? { imageRegistry: input.imageRegistry } : {}),
        ...(input.allowAgentImageOverride !== undefined ? { allowAgentImageOverride: input.allowAgentImageOverride ? "true" : "false" } : {}),
        ...(input.imageAllowlist !== undefined ? { imageAllowlist: input.imageAllowlist } : {}),
      }).where(eq(clusterConnections.id, id)).returning();
      return row ? mapRow(row) : null;
    },

    async delete(id) {
      await db.delete(clusterConnections).where(eq(clusterConnections.id, id));
    },

    async resolve(id) {
      const row = await this.get(id);
      if (!row) return null;
      let kubeconfigYaml: string | undefined;
      if (row.kind === "kubeconfig" && row.kubeconfigSecretRef) {
        kubeconfigYaml = await deps.resolveSecret(row.kubeconfigSecretRef);
      }
      return {
        id: row.id,
        label: row.label,
        kind: row.kind,
        kubeconfigYaml,
        apiServerUrl: row.apiServerUrl,
        defaultNamespacePrefix: row.defaultNamespacePrefix,
        paperclipPublicUrl: row.paperclipPublicUrl,
        imageRegistry: row.imageRegistry,
        allowAgentImageOverride: row.allowAgentImageOverride,
        imageAllowlist: row.imageAllowlist ?? [],
        capabilities: row.capabilities,
      };
    },
  };
}

function mapRow(row: typeof clusterConnections.$inferSelect): ClusterConnectionRow {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind as "in-cluster" | "kubeconfig",
    kubeconfigSecretRef: row.kubeconfigSecretRef ?? null,
    apiServerUrl: row.apiServerUrl ?? null,
    defaultNamespacePrefix: row.defaultNamespacePrefix,
    capabilities: row.capabilities as ClusterCapabilities,
    paperclipPublicUrl: row.paperclipPublicUrl ?? null,
    imageRegistry: row.imageRegistry ?? null,
    allowAgentImageOverride: row.allowAgentImageOverride === "true",
    imageAllowlist: row.imageAllowlist ?? [],
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}
