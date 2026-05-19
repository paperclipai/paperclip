import type { KubernetesProviderConfig } from "./types.js";

type CidrAllowEntry = KubernetesProviderConfig["egressAllowCidrs"][number];

export interface BuildNetworkPolicyInput {
  namespace: string;
  paperclipServerNamespace: string;
  egressAllowFqdns: string[];
  egressAllowCidrs: CidrAllowEntry[];
}

const PUBLIC_IPV4_EXCEPTIONS = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

// Design note: the deny-all baseline blocks all ingress to agent pods.
// Paperclip-server does NOT push to agent pods — the agent shim makes
// outbound calls to paperclip-server via the egress allow-list (port 3100).
// This pull/callback model means no ingress rule is needed. If a future
// feature requires server→agent push (e.g. forced shutdown, live exec),
// add a targeted ingress rule here scoped to the paperclip-server pod
// selector.
//
// Standard Kubernetes NetworkPolicy cannot express FQDN allow-lists. When
// adapter defaults require FQDN egress, keep runs functional by allowing public
// IPv4 HTTPS while excluding private/link-local ranges. Operators who need
// exact FQDN enforcement should use egressMode="cilium".
export function buildNetworkPolicyManifests(input: BuildNetworkPolicyInput): Record<string, unknown>[] {
  const fqdnsRequirePublicHttpsFallback = input.egressAllowFqdns.length > 0;
  const denyAll = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "paperclip-deny-all",
      namespace: input.namespace,
      labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" },
    },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
    },
  };

  const egressAllow: Record<string, unknown> = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "paperclip-egress-allow",
      namespace: input.namespace,
      labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" },
    },
    spec: {
      podSelector: { matchLabels: { "paperclip.io/role": "agent" } },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": input.paperclipServerNamespace } },
              podSelector: { matchLabels: { app: "paperclip-server" } },
            },
          ],
          ports: [{ protocol: "TCP", port: 3100 }],
        },
        ...(fqdnsRequirePublicHttpsFallback
          ? [
              {
                to: [
                  {
                    ipBlock: {
                      cidr: "0.0.0.0/0",
                      except: PUBLIC_IPV4_EXCEPTIONS,
                    },
                  },
                ],
                ports: [{ protocol: "TCP", port: 443 }],
              },
            ]
          : []),
        ...input.egressAllowCidrs.map((entry) => {
          const normalized = normalizeCidrEntry(entry);
          return {
            to: [{ ipBlock: { cidr: normalized.cidr } }],
            ports: normalized.ports.map((port) => ({ protocol: "TCP", port })),
          };
        }),
      ],
    },
  };

  return [denyAll, egressAllow];
}

function normalizeCidrEntry(entry: CidrAllowEntry): { cidr: string; ports: number[] } {
  return typeof entry === "string"
    ? { cidr: entry, ports: [443] }
    : { cidr: entry.cidr, ports: entry.ports };
}
