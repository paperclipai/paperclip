/**
 * paperclipai cluster <subcommand>
 *
 * Subcommands:
 *   add           --label <name> --kind <in-cluster|kubeconfig>
 *                 [--kubeconfig-secret <provider:name>]
 *                 [--paperclip-public-url <url>]
 *                 [--image-registry <url>]
 *   list
 *   test          <id>
 *   remove        <id>
 *   ensure-tenant <clusterId> <companyId>
 *   doctor        <id>
 *
 * Service-access pattern: direct DB (no HTTP server routes exist yet for cluster operations).
 *
 * The ClusterCommandDeps interface is injected so all logic is fully unit-testable
 * without real DB or Kubernetes connectivity.
 */

import type {
  ClusterCapabilities,
  KubernetesExecutionDriver as KubernetesDriver,
  ResolvedClusterConnection,
  TenantPolicy,
} from "@paperclipai/execution-target-kubernetes";

// ---------------------------------------------------------------------------
// Dependency interfaces (mirroring the real service shapes without importing
// from server sub-paths that don't exist in the package exports map)
// ---------------------------------------------------------------------------

export type ClusterKind = "in-cluster" | "kubeconfig";
export type ClusterArch = ClusterCapabilities["architectures"][number];

export interface ClusterConnectionRow {
  id: string;
  label: string;
  kind: ClusterKind;
  kubeconfigSecretRef: { provider: string; name: string } | null;
  apiServerUrl: string | null;
  defaultNamespacePrefix: string;
  capabilities: ClusterCapabilities;
  paperclipPublicUrl: string | null;
  imageRegistry: string | null;
  allowAgentImageOverride: boolean;
  createdAt: Date;
  createdBy: string;
}

export interface CreateClusterConnectionInput {
  label: string;
  kind: ClusterKind;
  kubeconfigSecretRef?: { provider: string; name: string };
  apiServerUrl?: string;
  defaultNamespacePrefix?: string;
  capabilities: ClusterCapabilities;
  paperclipPublicUrl?: string;
  imageRegistry?: string;
  allowAgentImageOverride?: boolean;
  createdBy: string;
}

export interface ClusterConnectionsService {
  create(input: CreateClusterConnectionInput): Promise<ClusterConnectionRow>;
  list(): Promise<ClusterConnectionRow[]>;
  get(id: string): Promise<ClusterConnectionRow | null>;
  delete(id: string): Promise<void>;
  resolve(id: string): Promise<ResolvedClusterConnection | null>;
}

export interface TenantPolicyRow extends TenantPolicy {
  clusterConnectionId: string;
  companyId: string;
}

export interface ClusterTenantPoliciesService {
  get(clusterConnectionId: string, companyId: string): Promise<TenantPolicyRow | null>;
}

export interface EnsureTenantResult {
  namespace: string;
  ciliumApplied: boolean;
}

export interface CompaniesLookup {
  getById(id: string): Promise<{ id: string; name: string; slug: string } | null>;
}

export interface NamespaceBindingsService {
  record(input: {
    clusterConnectionId: string;
    companyId: string;
    namespaceName: string;
  }): Promise<void>;
}

export interface ClusterCommandDeps {
  clusterConnections: ClusterConnectionsService;
  tenantPolicies: ClusterTenantPoliciesService;
  driver: KubernetesDriver;
  companies: CompaniesLookup;
  namespaceBindings: NamespaceBindingsService;
  print: (line: string) => void;
}

export interface ClusterCommand {
  run(argv: string[]): Promise<number>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createClusterCommand(deps: ClusterCommandDeps): ClusterCommand {
  return {
    async run(argv) {
      const [sub, ...rest] = argv;
      switch (sub) {
        case "add":           return cmdAdd(rest, deps);
        case "list":          return cmdList(rest, deps);
        case "test":          return cmdTest(rest, deps);
        case "remove":        return cmdRemove(rest, deps);
        case "ensure-tenant": return cmdEnsureTenant(rest, deps);
        case "doctor":        return cmdDoctor(rest, deps);
        default:
          deps.print(
            `Unknown subcommand: ${sub ?? "(none)"}\n` +
            `Usage: cluster <add|list|test|remove|ensure-tenant|doctor>`,
          );
          return 2;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal flag parser (keeps this module free of commander/yargs deps)
// ---------------------------------------------------------------------------

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        flags[key] = val;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Derive a DNS-safe slug from company name (companies table has no slug col)
// ---------------------------------------------------------------------------

export function deriveCompanySlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "company"
  );
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function cmdAdd(argv: string[], deps: ClusterCommandDeps): Promise<number> {
  const { flags } = parseFlags(argv);
  const label = flags["label"];
  const kind = flags["kind"] as ClusterKind;
  if (!label || !kind || (kind !== "in-cluster" && kind !== "kubeconfig")) {
    deps.print(
      "Usage: cluster add --label <name> --kind <in-cluster|kubeconfig> " +
        "[--kubeconfig-secret <provider:name>] [--paperclip-public-url <url>] [--image-registry <url>] " +
        "[--cilium] [--storage-class <name>] [--arch <amd64|arm64>] (--arch may repeat)",
    );
    return 2;
  }

  let kubeconfigSecretRef: { provider: string; name: string } | undefined;
  if (flags["kubeconfig-secret"]) {
    const colonIdx = flags["kubeconfig-secret"].indexOf(":");
    if (colonIdx <= 0) {
      deps.print("Invalid --kubeconfig-secret. Use <provider>:<name> (e.g. local_encrypted:my-cfg)");
      return 2;
    }
    const provider = flags["kubeconfig-secret"].slice(0, colonIdx);
    const name = flags["kubeconfig-secret"].slice(colonIdx + 1);
    if (!name) {
      deps.print("Invalid --kubeconfig-secret. Use <provider>:<name> (e.g. local_encrypted:my-cfg)");
      return 2;
    }
    kubeconfigSecretRef = { provider, name };
  }

  const capabilities = parseCapabilityFlags(flags);
  if (capabilities === null) {
    deps.print("Invalid --arch. Allowed values: amd64, arm64.");
    return 2;
  }
  // Defaults match the most common single-arch x86 cluster without Cilium installed.
  // Operators must pass --cilium for clusters running Cilium so the agent
  // egress NetworkPolicy + per-tenant CiliumNetworkPolicy actually engage.
  // `paperclip cluster doctor` reports the detected installation so operators
  // can verify before adding.

  const created = await deps.clusterConnections.create({
    label,
    kind,
    kubeconfigSecretRef,
    paperclipPublicUrl: flags["paperclip-public-url"],
    imageRegistry: flags["image-registry"],
    capabilities,
    createdBy: process.env.PAPERCLIP_CLI_USER ?? "cli",
  });
  deps.print(`Created cluster connection ${created.id} (${created.label})`);
  deps.print(
    `  capabilities: cilium=${capabilities.cilium} storageClass=${capabilities.storageClass} archs=${capabilities.architectures.join(",")}`,
  );
  return 0;
}

/**
 * Build a ClusterCapabilities object from CLI flags. Returns null when --arch
 * carries an unsupported value.
 */
function parseCapabilityFlags(flags: Record<string, string>): ClusterCapabilities | null {
  const cilium = flags["cilium"] === "true";
  const storageClass = flags["storage-class"] ?? "standard";
  const archRaw = flags["arch"];
  // parseFlags only retains the last value of a repeated flag, so for
  // multi-arch clusters the operator passes --arch as a comma list.
  const architectures: ClusterCapabilities["architectures"] =
    archRaw === undefined
      ? ["amd64"]
      : (archRaw.split(",").map((s) => s.trim()).filter(Boolean) as ClusterCapabilities["architectures"]);
  for (const a of architectures) {
    if (a !== "amd64" && a !== "arm64") return null;
  }
  if (architectures.length === 0) return null;
  return { cilium, storageClass, architectures };
}

async function cmdList(_argv: string[], deps: ClusterCommandDeps): Promise<number> {
  const rows = await deps.clusterConnections.list();
  if (rows.length === 0) {
    deps.print("No cluster connections.");
    return 0;
  }
  for (const r of rows) {
    deps.print(
      `${r.id}\t${r.label}\t${r.kind}\t` +
        `cilium=${r.capabilities.cilium}\t` +
        `storageClass=${r.capabilities.storageClass}\t` +
        `archs=${r.capabilities.architectures.join(",")}`,
    );
  }
  return 0;
}

async function cmdTest(argv: string[], deps: ClusterCommandDeps): Promise<number> {
  const [id] = argv;
  if (!id) {
    deps.print("Usage: cluster test <id>");
    return 2;
  }
  const resolved = await deps.clusterConnections.resolve(id);
  if (!resolved) {
    deps.print(`Cluster connection ${id} not found`);
    return 1;
  }
  deps.print(`OK: connection ${id} resolves (label=${resolved.label})`);
  deps.print(`  kind:         ${resolved.kind}`);
  deps.print(`  cilium:       ${resolved.capabilities.cilium}`);
  deps.print(`  storageClass: ${resolved.capabilities.storageClass}`);
  deps.print(`  archs:        ${resolved.capabilities.architectures.join(", ")}`);
  return 0;
}

async function cmdRemove(argv: string[], deps: ClusterCommandDeps): Promise<number> {
  const [id] = argv;
  if (!id) {
    deps.print("Usage: cluster remove <id>");
    return 2;
  }
  const existing = await deps.clusterConnections.get(id);
  if (!existing) {
    deps.print(`Cluster connection ${id} not found`);
    return 1;
  }
  await deps.clusterConnections.delete(id);
  deps.print(`Deleted cluster connection ${id}`);
  return 0;
}

async function cmdEnsureTenant(argv: string[], deps: ClusterCommandDeps): Promise<number> {
  const [clusterId, companyId] = argv;
  if (!clusterId || !companyId) {
    deps.print("Usage: cluster ensure-tenant <clusterId> <companyId>");
    return 2;
  }

  const company = await deps.companies.getById(companyId);
  if (!company) {
    deps.print(`Company ${companyId} not found`);
    return 1;
  }

  const slug = company.slug ?? deriveCompanySlug(company.name);

  const tp = await deps.tenantPolicies.get(clusterId, companyId);

  const result = await deps.driver.ensureTenant({
    clusterConnectionId: clusterId,
    company: { id: company.id, slug },
    tenantPolicy: tp
      ? {
          quota: tp.quota,
          limitRange: tp.limitRange,
          additionalAllowFqdns: tp.additionalAllowFqdns,
          imageOverrides: tp.imageOverrides,
        }
      : null,
    driverServiceAccount: {
      name: process.env.PAPERCLIP_DRIVER_SA ?? "paperclip-driver",
      namespace: process.env.PAPERCLIP_DRIVER_NAMESPACE ?? "paperclip-system",
    },
    controlPlane: {
      topology: "cross-cluster",
      namespaceLabels: {},
      podLabels: {},
    },
    adapterAllowFqdns: [],
    imagePullDockerConfigJson: null,
  });

  await deps.namespaceBindings.record({
    clusterConnectionId: clusterId,
    companyId,
    namespaceName: result.namespace,
  });

  deps.print(`Provisioned namespace ${result.namespace} (cilium=${result.ciliumApplied})`);
  return 0;
}

async function cmdDoctor(argv: string[], deps: ClusterCommandDeps): Promise<number> {
  const [id] = argv;
  if (!id) {
    deps.print("Usage: cluster doctor <id>");
    return 2;
  }

  const resolved = await deps.clusterConnections.resolve(id);
  if (!resolved) {
    deps.print(`Cluster connection ${id} not found`);
    return 1;
  }

  deps.print(`Doctor report for cluster connection ${id} (${resolved.label}):`);
  deps.print(`  kind:         ${resolved.kind}`);
  deps.print(`  cilium:       ${resolved.capabilities.cilium}`);
  deps.print(`  storageClass: ${resolved.capabilities.storageClass}`);
  deps.print(`  archs:        ${resolved.capabilities.architectures.join(", ")}`);
  deps.print("");
  deps.print(
    `Apply the reference ClusterRole before first ensure-tenant:\n` +
      `  kubectl apply -f packages/adapters/kubernetes-execution/manifests/paperclip-tenant-manager-clusterrole.yaml`,
  );
  return 0;
}
