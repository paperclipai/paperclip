import type { KubernetesApiClient } from "../types.js";
import { tenantBaseLabels, PAPERCLIP_ROLE, ROLE_AGENT_RUNTIME } from "./labels.js";

interface CiliumFqdn {
  matchPattern?: string;
  matchName?: string;
}

export interface CiliumNetworkPolicyDoc {
  apiVersion: "cilium.io/v2";
  kind: "CiliumNetworkPolicy";
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  spec: {
    endpointSelector: { matchLabels: Record<string, string> };
    egress: Array<{
      toFQDNs?: CiliumFqdn[];
      toEndpoints?: Array<{ matchLabels: Record<string, string> }>;
      toCIDR?: string[];
      toPorts?: Array<{
        ports: Array<{ port: string; protocol: string }>;
        rules?: { dns?: Array<{ matchPattern?: string; matchName?: string }> };
      }>;
    }>;
  };
}

export interface BuildCiliumInput {
  namespace: string;
  companyId: string;
  companySlug: string;
  adapterAllowFqdns: string[];
  tenantAllowFqdns: string[];
  /**
   * Optional tenant Cilium allowlist. When present, this is the authoritative
   * FQDN egress set for agent pods; it is folded into the baseline CNP instead
   * of emitted as a second policy because Cilium allow policies are additive.
   */
  tenantCiliumDnsAllowlist?: string[];
  /** Optional tenant Cilium CIDR egress allowlist, folded into the baseline CNP. */
  tenantCiliumEgressCidrs?: string[];
  controlPlaneSelector: { matchLabels: Record<string, string> } | null;
}

export function buildCiliumAgentEgressPolicy(input: BuildCiliumInput): CiliumNetworkPolicyDoc {
  const labels = tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug });
  const baselineFqdns = [...input.adapterAllowFqdns, ...input.tenantAllowFqdns];
  const tenantFqdns = input.tenantCiliumDnsAllowlist ?? [];
  const merged = Array.from(new Set([...baselineFqdns, ...tenantFqdns])).sort();
  const fqdns: CiliumFqdn[] = merged.map(p => p.includes("*") ? { matchPattern: p } : { matchName: p });
  const cidrs = Array.from(new Set(input.tenantCiliumEgressCidrs ?? [])).sort();

  const egress: CiliumNetworkPolicyDoc["spec"]["egress"] = [];
  if (fqdns.length > 0) {
    egress.push({ toFQDNs: fqdns, toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }] });
  }
  if (cidrs.length > 0) {
    egress.push({ toCIDR: cidrs });
  }
  if (input.controlPlaneSelector) {
    egress.push({
      toEndpoints: [{ matchLabels: input.controlPlaneSelector.matchLabels }],
      toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }],
    });
  }

  return {
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: { name: "paperclip-agent-egress-l7", namespace: input.namespace, labels },
    spec: {
      endpointSelector: { matchLabels: { [PAPERCLIP_ROLE]: ROLE_AGENT_RUNTIME } },
      egress,
    },
  };
}

export async function applyCiliumNetworkPolicy(client: KubernetesApiClient, p: CiliumNetworkPolicyDoc): Promise<void> {
  const ns = p.metadata.namespace;
  const name = p.metadata.name;
  const itemPath = `/apis/cilium.io/v2/namespaces/${encodeURIComponent(ns)}/ciliumnetworkpolicies/${encodeURIComponent(name)}`;
  const collectionPath = `/apis/cilium.io/v2/namespaces/${encodeURIComponent(ns)}/ciliumnetworkpolicies`;
  try {
    await client.request("GET", itemPath);
    await client.request("PUT", itemPath, p);
  } catch (err: unknown) {
    const is404 =
      /\b404\b/.test(String(err)) ||
      (typeof err === "object" && err !== null && (err as Record<string, unknown>)["statusCode"] === 404) ||
      (typeof err === "object" && err !== null &&
        typeof (err as Record<string, unknown>)["response"] === "object" &&
        ((err as Record<string, unknown>)["response"] as Record<string, unknown>)?.["statusCode"] === 404);
    if (is404) {
      await client.request("POST", collectionPath, p);
      return;
    }
    throw err;
  }
}
