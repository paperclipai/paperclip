export interface BuildNetworkPolicyInput {
  namespace: string;
  paperclipServerNamespace: string;
  egressAllowCidrs: string[];
  /**
   * Adapter-configured FQDNs (e.g. `api.anthropic.com`). Standard
   * NetworkPolicy cannot express FQDNs natively — only Cilium can.
   * When this list is non-empty AND no explicit `egressAllowCidrs`
   * was provided, the standard NetworkPolicy falls back to "public
   * IPv4 except RFC1918/link-local/loopback/multicast" so the
   * configured FQDNs at least become reachable. This is broader
   * than the operator probably wants — switch to `egressMode:
   * "cilium"` for exact FQDN allow-listing in production.
   */
  egressAllowFqdns?: string[];
}

/**
 * IPv4 ranges to carve out of `0.0.0.0/0` when we apply the
 * public-internet fallback. Keeps agent pods from reaching cluster
 * internals (RFC1918), node link-local + AWS IMDS (169.254.0.0/16),
 * cluster loopback (127.0.0.0/8), CGNAT (100.64.0.0/10), this-network
 * (0.0.0.0/8), and multicast (224.0.0.0/4).
 */
const PRIVATE_AND_LINK_LOCAL_EXCEPT_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
];

// Design note: the deny-all baseline blocks all ingress to agent pods.
// Paperclip-server does NOT push to agent pods — the agent shim makes
// outbound calls to paperclip-server via the egress allow-list (port 3100).
// This pull/callback model means no ingress rule is needed. If a future
// feature requires server→agent push (e.g. forced shutdown, live exec),
// add a targeted ingress rule here scoped to the paperclip-server pod
// selector.
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
        // NOTE: operator-supplied CIDRs are intentionally NOT port-scoped —
        // operators may need them for non-HTTP services (e.g. private VCS
        // mirrors, S3 endpoints, internal artifact registries). Operators
        // should keep CIDRs as specific as possible. For HTTP/HTTPS-only
        // LLM endpoints, the public-IPv4 fallback below is port-scoped
        // (TCP 80/443).
        ...input.egressAllowCidrs.map((cidr) => ({
          to: [{ ipBlock: { cidr } }],
        })),
        // Standard-NetworkPolicy fallback for FQDN-based egress. If the
        // adapter requires FQDNs (e.g. api.anthropic.com) and the
        // operator didn't supply explicit CIDRs, allow public IPv4 with
        // private/link-local/loopback/multicast carved out. This makes
        // the default `egressMode: "standard"` config functional out of
        // the box for cloud LLM APIs without inadvertently exposing
        // cluster internals or link-local metadata endpoints. Operators
        // who want exact FQDN enforcement should use `egressMode: "cilium"`.
        ...(input.egressAllowCidrs.length === 0 &&
          (input.egressAllowFqdns?.length ?? 0) > 0
          ? [
              {
                to: [
                  {
                    ipBlock: {
                      cidr: "0.0.0.0/0",
                      except: PRIVATE_AND_LINK_LOCAL_EXCEPT_CIDRS,
                    },
                  },
                ],
                ports: [
                  { protocol: "TCP", port: 443 },
                  { protocol: "TCP", port: 80 },
                ],
              },
            ]
          : []),
      ],
    },
  };

  return [denyAll, egressAllow];
}
