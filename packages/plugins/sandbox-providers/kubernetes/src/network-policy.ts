export interface BuildNetworkPolicyInput {
  namespace: string;
  paperclipServerNamespace: string;
  egressAllowCidrs: string[];
}

export function buildNetworkPolicyManifests(input: BuildNetworkPolicyInput): Record<string, unknown>[] {
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
        ...input.egressAllowCidrs.map((cidr) => ({
          to: [{ ipBlock: { cidr } }],
        })),
      ],
    },
  };

  return [denyAll, egressAllow];
}
