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
      toPorts?: Array<{ ports: Array<{ port: string; protocol: string }> }>;
    }>;
  };
}

export interface BuildCiliumInput {
  namespace: string;
  companyId: string;
  companySlug: string;
  adapterAllowFqdns: string[];
  tenantAllowFqdns: string[];
  controlPlaneSelector: { matchLabels: Record<string, string> } | null;
}

export function buildCiliumAgentEgressPolicy(input: BuildCiliumInput): CiliumNetworkPolicyDoc {
  const labels = tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug });
  const merged = Array.from(new Set([...input.adapterAllowFqdns, ...input.tenantAllowFqdns])).sort();
  const fqdns: CiliumFqdn[] = merged.map(p => p.includes("*") ? { matchPattern: p } : { matchName: p });

  const egress: CiliumNetworkPolicyDoc["spec"]["egress"] = [];
  if (fqdns.length > 0) {
    egress.push({ toFQDNs: fqdns, toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }] });
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
    if (isNotFoundError(err)) {
      await client.request("POST", collectionPath, p);
      return;
    }
    throw err;
  }
}

function isNotFoundError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const record = err as Record<string, unknown>;
    if (record.statusCode === 404) return true;
    if (
      typeof record.response === "object" &&
      record.response !== null &&
      (record.response as Record<string, unknown>).statusCode === 404
    ) {
      return true;
    }
  }
  return /\bfailed 404:/.test(String(err));
}
