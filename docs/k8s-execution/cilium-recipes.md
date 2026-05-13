# Cilium tenant policy recipes

The per-tenant Cilium DSL (`ciliumDnsAllowlist` + `ciliumEgressCidrs`) is folded
into Paperclip's baseline `paperclip-agent-egress-l7` CiliumNetworkPolicy. This
must be one effective allow policy: Cilium allow policies are additive, so
emitting a second allow CNP would widen egress rather than narrow it.

## How to apply

```bash
paperclip cluster set-cilium-policy \
  --cluster <cluster-id> \
  --company <company-id> \
  --cilium-dns "api.anthropic.com,github.com" \
  --cilium-cidrs "10.42.0.0/16"
```

Empty arrays keep the default adapter and tenant FQDN baseline.

## Recipe 1: Anthropic-only tenant

A tenant that should reach only Anthropic + GitHub:

```bash
paperclip cluster set-cilium-policy \
  --cluster c-1 --company co-1 \
  --cilium-dns "api.anthropic.com,github.com"
```

The agent can hit the Anthropic API and clone GitHub repos. All other egress
(other LLM providers, arbitrary internet, internal infra) is dropped.

## Recipe 2: Self-hosted git tenant

A tenant with a self-hosted git server on an internal network:

```bash
paperclip cluster set-cilium-policy \
  --cluster c-1 --company co-1 \
  --cilium-dns "api.anthropic.com" \
  --cilium-cidrs "10.42.0.0/16"
```

`api.anthropic.com` for the LLM, `10.42.0.0/16` for the git server.

## Recipe 3: Block everything outside a small allowlist

Locking a tenant to one LLM provider and one internal repo CIDR:

```bash
paperclip cluster set-cilium-policy \
  --cluster c-1 --company co-1 \
  --cilium-dns "api.anthropic.com" \
  --cilium-cidrs "192.168.10.0/24"
```

## Footguns

- **DNS allowlists are authoritative when non-empty.** `--cilium-dns
  "api.anthropic.com"` replaces the adapter/default FQDN set for agent pods.
- **CIDR allowlists are additive to the effective FQDN set.** Use CIDRs only
  for specific internal services that cannot be represented as DNS names.
- **Wildcards.** Use `*.linear.app` for subdomain matching. The builder emits
  `matchPattern` for entries containing `*` and `matchName` otherwise.

## Verification

```bash
kubectl --kubeconfig <kubeconfig> -n paperclip-<slug> get ciliumnetworkpolicies
```

You should see `paperclip-agent-egress-l7`; tenant DSL values are reflected in
that policy's egress rules.
