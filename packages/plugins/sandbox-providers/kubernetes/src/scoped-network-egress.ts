import type { KubeClients } from "./kube-client.js";
import { buildNetworkPolicyManifests } from "./network-policy.js";
import { buildCiliumNetworkPolicyManifest } from "./cilium-network-policy.js";

export const NETWORK_EGRESS_GRANT_PATH = "executionWorkspaceSettings.networkEgress";

export interface ScopedNetworkEgressGrant {
  allowFqdns: string[];
  allowCidrs: string[];
}

export function parseScopedNetworkEgressGrant(settings: unknown): ScopedNetworkEgressGrant {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return { allowFqdns: [], allowCidrs: [] };
  }
  const networkEgress = (settings as Record<string, unknown>).networkEgress;
  if (!networkEgress || typeof networkEgress !== "object" || Array.isArray(networkEgress)) {
    return { allowFqdns: [], allowCidrs: [] };
  }
  const record = networkEgress as Record<string, unknown>;
  const strings = (value: unknown) => Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];
  return {
    allowFqdns: strings(record.allowFqdns).map((fqdn) => fqdn.toLowerCase()),
    allowCidrs: strings(record.allowCidrs),
  };
}

export async function createScopedNetworkEgressPolicy(input: {
  clients: KubeClients;
  namespace: string;
  mode: "standard" | "cilium";
  runId: string;
  workloadName: string;
  ownerReference: Record<string, unknown>;
  grant: ScopedNetworkEgressGrant;
}): Promise<string | null> {
  if (input.grant.allowFqdns.length === 0 && input.grant.allowCidrs.length === 0) return null;
  const name = `${input.workloadName}-egress`;
  if (input.mode === "cilium") {
    const manifest = buildCiliumNetworkPolicyManifest({
      namespace: input.namespace,
      paperclipServerNamespace: "",
      egressAllowFqdns: input.grant.allowFqdns,
      egressAllowCidrs: input.grant.allowCidrs,
      name,
      endpointSelector: { "paperclip.io/run-id": input.runId },
      includeBaseRules: false,
      ownerReferences: [input.ownerReference],
    });
    await input.clients.custom.createNamespacedCustomObject({
      group: "cilium.io",
      version: "v2",
      namespace: input.namespace,
      plural: "ciliumnetworkpolicies",
      body: manifest,
    });
  } else {
    const [, manifest] = buildNetworkPolicyManifests({
      namespace: input.namespace,
      paperclipServerNamespace: "",
      egressAllowFqdns: input.grant.allowFqdns,
      egressAllowCidrs: input.grant.allowCidrs,
      name,
      podSelector: { "paperclip.io/run-id": input.runId },
      includeBaseRules: false,
      ownerReferences: [input.ownerReference],
    });
    await input.clients.networking.createNamespacedNetworkPolicy({ namespace: input.namespace, body: manifest as never });
  }
  return name;
}

export function appendNetworkEgressDenyHint(stderr: string, grant: ScopedNetworkEgressGrant): string {
  if (!/(could not resolve host|network is unreachable|connection timed out|failed to connect|temporary failure in name resolution)/i.test(stderr)) {
    return stderr;
  }
  const allowed = [...grant.allowFqdns, ...grant.allowCidrs];
  const detail = allowed.length > 0 ? ` Current task grant: ${allowed.join(", ")}.` : " No task-scoped destinations are granted.";
  return `${stderr.trimEnd()}\nPaperclip network policy denied or could not route this request.${detail} Request access through ${NETWORK_EGRESS_GRANT_PATH}.\n`;
}
