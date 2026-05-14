/**
 * CLI wiring for `paperclipai cluster <subcommand>`.
 *
 * Bridges Commander with the pure createClusterCommand() factory,
 * constructing real service deps from DB + Kubernetes lazily on demand.
 *
 * Service-access pattern: direct DB (no HTTP routes exist yet for cluster ops).
 */

import type { Command } from "commander";
import { eq } from "drizzle-orm";
import { createDb, companies } from "@paperclipai/db";
import { clusterConnectionsService } from "@paperclipai/server/services/cluster-connections";
import { clusterTenantPoliciesService } from "@paperclipai/server/services/cluster-tenant-policies";
import { clusterNamespaceBindingsService } from "@paperclipai/server/services/cluster-namespace-bindings";
import { createKubernetesExecutionDriver } from "@paperclipai/execution-target-kubernetes";
import { getSecretProvider } from "@paperclipai/server/secrets/provider-registry";
import { readConfig } from "../config/store.js";
import { createClusterCommand, deriveCompanySlug } from "./cluster.js";

function resolveDbUrl(configPath?: string): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString) {
    return config.database.connectionString;
  }
  const port = config?.database.embeddedPostgresPort ?? 54329;
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

function buildDeps(opts: { config?: string }) {
  const db = createDb(resolveDbUrl(opts.config));

  const connsSvc = clusterConnectionsService(db, {
    resolveSecret: async (ref) => {
      const provider = getSecretProvider(ref.provider as Parameters<typeof getSecretProvider>[0]);
      return provider.resolveVersion({ material: {}, externalRef: ref.name });
    },
  });

  const driver = createKubernetesExecutionDriver({
    resolveConnection: (id: string) => connsSvc.resolve(id),
  });

  return {
    clusterConnections: connsSvc,
    tenantPolicies: clusterTenantPoliciesService(db),
    driver,
    companies: {
      async getById(id: string) {
        const [row] = await db.select().from(companies).where(eq(companies.id, id));
        if (!row) return null;
        return {
          id: row.id,
          name: row.name,
          slug: deriveCompanySlug(row.name),
        };
      },
    },
    namespaceBindings: clusterNamespaceBindingsService(db),
    print: (line: string) => console.log(line),
  };
}

export function registerClusterCommands(program: Command): void {
  const clusterCmd = program
    .command("cluster")
    .description("Manage Kubernetes cluster connections and tenant provisioning")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", "Paperclip data directory root");

  clusterCmd
    .command("add")
    .description("Register a new cluster connection")
    .requiredOption("--label <name>", "Human-readable label")
    .requiredOption("--kind <kind>", "Connection kind: in-cluster | kubeconfig")
    .option("--kubeconfig-secret <ref>", "Secret reference in <provider>:<name> format")
    .option("--paperclip-public-url <url>", "Public URL of this Paperclip instance")
    .option("--image-registry <url>", "Container image registry URL")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.parent?.parent?.opts() as { config?: string };
      const deps = buildDeps(globalOpts);
      const args = [
        "add",
        "--label", opts.label,
        "--kind", opts.kind,
        ...(opts.kubeconfigSecret ? ["--kubeconfig-secret", opts.kubeconfigSecret] : []),
        ...(opts.paperclipPublicUrl ? ["--paperclip-public-url", opts.paperclipPublicUrl] : []),
        ...(opts.imageRegistry ? ["--image-registry", opts.imageRegistry] : []),
      ];
      const code = await createClusterCommand(deps).run(args);
      if (code !== 0) process.exit(code);
    });

  clusterCmd
    .command("list")
    .description("List all cluster connections")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.parent?.parent?.opts() as { config?: string };
      const deps = buildDeps(globalOpts);
      const code = await createClusterCommand(deps).run(["list"]);
      if (code !== 0) process.exit(code);
    });

  clusterCmd
    .command("test <id>")
    .description("Connect to a cluster and probe its capabilities")
    .action(async (id, _opts, cmd) => {
      const globalOpts = cmd.parent?.parent?.opts() as { config?: string };
      const deps = buildDeps(globalOpts);
      const code = await createClusterCommand(deps).run(["test", id]);
      if (code !== 0) process.exit(code);
    });

  clusterCmd
    .command("remove <id>")
    .description("Remove a cluster connection")
    .action(async (id, _opts, cmd) => {
      const globalOpts = cmd.parent?.parent?.opts() as { config?: string };
      const deps = buildDeps(globalOpts);
      const code = await createClusterCommand(deps).run(["remove", id]);
      if (code !== 0) process.exit(code);
    });

  clusterCmd
    .command("ensure-tenant <clusterId> <companyId>")
    .description("Provision a tenant namespace for a company on the given cluster")
    .action(async (clusterId, companyId, _opts, cmd) => {
      const globalOpts = cmd.parent?.parent?.opts() as { config?: string };
      const deps = buildDeps(globalOpts);
      const code = await createClusterCommand(deps).run(["ensure-tenant", clusterId, companyId]);
      if (code !== 0) process.exit(code);
    });

  clusterCmd
    .command("doctor <id>")
    .description("Run M1 health checks on a cluster connection")
    .action(async (id, _opts, cmd) => {
      const globalOpts = cmd.parent?.parent?.opts() as { config?: string };
      const deps = buildDeps(globalOpts);
      const code = await createClusterCommand(deps).run(["doctor", id]);
      if (code !== 0) process.exit(code);
    });
}
