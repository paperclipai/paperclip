import type { KubernetesProviderConfig } from "./types.js";

type CidrAllowEntry = KubernetesProviderConfig["egressAllowCidrs"][number];

export interface BuildCiliumNetworkPolicyInput {
  namespace: string;
  paperclipServerNamespace: string;
  egressAllowFqdns: string[];
  egressAllowCidrs: CidrAllowEntry[];
}

// Design note: no ingress rules are defined here. Paperclip-server does NOT
// push to agent pods — agents make outbound (egress) callbacks to
// paperclip-server on port 3100. If server→agent push is ever needed, add a
// targeted ingress rule scoped to the paperclip-server endpoint selector.
export function buildCiliumNetworkPolicyManifest(input: BuildCiliumNetworkPolicyInput): Record<string, unknown> {
  const egress: Record<string, unknown>[] = [];

  egress.push({
    toEndpoints: [
      { matchLabels: { "k8s:io.kubernetes.pod.namespace": "kube-system", "k8s-app": "kube-dns" } },
    ],
    toPorts: [
      {
        ports: [
          { port: "53", protocol: "UDP" },
          { port: "53", protocol: "TCP" },
        ],
        rules: { dns: [{ matchPattern: "*" }] },
      },
    ],
  });

  if (input.egressAllowFqdns.length > 0) {
    egress.push({
      toFQDNs: input.egressAllowFqdns.map((fqdn) => ({ matchName: fqdn })),
      toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }],
    });
  }

  egress.push({
    toEndpoints: [
      {
        matchLabels: {
          "k8s:io.kubernetes.pod.namespace": input.paperclipServerNamespace,
          app: "paperclip-server",
        },
      },
    ],
    toPorts: [{ ports: [{ port: "3100", protocol: "TCP" }] }],
  });

  if (input.egressAllowCidrs.length > 0) {
    egress.push(
      ...input.egressAllowCidrs.map((entry) => {
        const normalized = normalizeCidrEntry(entry);
        return {
          toCIDRSet: [{ cidr: normalized.cidr }],
          toPorts: [
            {
              ports: normalized.ports.map((port) => ({ port: String(port), protocol: "TCP" })),
            },
          ],
        };
      }),
    );
  }

  return {
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: {
      name: "paperclip-egress-fqdn",
      namespace: input.namespace,
      labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" },
    },
    spec: {
      endpointSelector: { matchLabels: { "paperclip.io/role": "agent" } },
      egress,
    },
  };
}

function normalizeCidrEntry(entry: CidrAllowEntry): { cidr: string; ports: number[] } {
  return typeof entry === "string"
    ? { cidr: entry, ports: [443] }
    : { cidr: entry.cidr, ports: entry.ports };
}
