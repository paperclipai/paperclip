import type { CiliumNetworkPolicyDoc } from "./cilium-network-policy.js";

export interface BuildTenantCiliumInput {
  namespace: string;
  companySlug: string;
  dnsAllowlist: string[];
  egressCidrs: string[];
}

/**
 * Build a per-tenant CiliumNetworkPolicy that narrows tenant egress.
 *
 * Cilium combines multiple allow-only policies selecting the same endpoint as
 * a union, so every rule emitted here must carry its own safety bounds instead
 * of relying on the baseline policy to subtract ports later.
 *
 * Returns `null` when both arrays are empty, in which case
 * `ensureTenantNamespace` does not apply a second CNP and the M1 baseline
 * alone governs egress.
 */
export function buildTenantCiliumPolicy(input: BuildTenantCiliumInput): CiliumNetworkPolicyDoc | null {
  if (input.dnsAllowlist.length === 0 && input.egressCidrs.length === 0) return null;

  const egress: CiliumNetworkPolicyDoc["spec"]["egress"] = [];

  // Always preserve kube-dns access. Without this, a dnsAllowlist of
  // ["api.anthropic.com"] would also block DNS resolution for that very
  // host and the agent would fail to resolve any FQDN at all.
  egress.push({
    toEndpoints: [{
      matchLabels: {
        "k8s:io.kubernetes.pod.namespace": "kube-system",
        "k8s:k8s-app": "kube-dns",
      },
    }],
    toPorts: [{
      ports: [{ port: "53", protocol: "ANY" }],
      rules: { dns: [{ matchPattern: "*" }] },
    }],
  });

  if (input.dnsAllowlist.length > 0) {
    // Mirror the M1 baseline shape — `toFQDNs` plus an explicit
    // `toPorts: [443/TCP]`. This is a no-op behaviorally because Cilium
    // AND-intersects this CNP with the M1 baseline, which already
    // restricts egress to 443/TCP — so the effective port set is
    // unchanged. Emitting it here makes the tenant policy
    // self-documenting on its own (a reader doesn't have to chase the
    // baseline to see why arbitrary ports aren't reachable) and keeps
    // both policies symmetric so future port additions only need to
    // change one shape.
    egress.push({
      toFQDNs: input.dnsAllowlist.map((dns) =>
        dns.includes("*") ? { matchPattern: dns } : { matchName: dns },
      ),
      toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }],
    });
  }
  if (input.egressCidrs.length > 0) {
    egress.push({
      toCIDR: input.egressCidrs,
      toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }],
    });
  }

  return {
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: {
      name: `paperclip-tenant-${input.companySlug}-restrict`,
      namespace: input.namespace,
    },
    spec: {
      endpointSelector: { matchLabels: { "paperclip.ai/managed-by": "paperclip" } },
      egress,
    },
  };
}
