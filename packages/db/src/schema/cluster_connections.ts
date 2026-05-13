import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const clusterConnections = pgTable(
  "cluster_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
    kind: text("kind").notNull(), // "in-cluster" | "kubeconfig"
    kubeconfigSecretRef: jsonb("kubeconfig_secret_ref").$type<{
      provider: string;
      name: string;
    } | null>(),
    apiServerUrl: text("api_server_url"),
    defaultNamespacePrefix: text("default_namespace_prefix").notNull().default("paperclip-"),
    capabilities: jsonb("capabilities").notNull().$type<{
      cilium: boolean;
      storageClass: string;
      architectures: ("amd64" | "arm64")[];
    }>(),
    paperclipPublicUrl: text("paperclip_public_url"),
    imageRegistry: text("image_registry"),
    allowAgentImageOverride: text("allow_agent_image_override").notNull().default("false"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    labelUq: uniqueIndex("cluster_connections_label_uq").on(table.label),
    kindIdx: index("cluster_connections_kind_idx").on(table.kind),
  }),
);
