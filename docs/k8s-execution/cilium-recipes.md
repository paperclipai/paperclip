# Cilium tenant policy recipes

The per-tenant Cilium DSL (`ciliumDnsAllowlist` + `ciliumEgressCidrs`) emits a
*second* CiliumNetworkPolicy that intersects with M1's baseline. Cilium evaluates
multiple selecting CNPs as AND, so every rule below produces an effective egress
that is **strictly tighter** than the M1 default — never looser.

## How to apply

```bash
paperclip cluster set-cilium-policy \
  --cluster <cluster-id> \
  --company <company-id> \
  --cilium-dns "api.anthropic.com,github.com" \
  --cilium-cidrs "10.42.0.0/16"
```

Empty arrays disable the second CNP — only the M1 baseline applies.

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

- **DNS resolution is preserved automatically.** The builder always emits a
  rule allowing kube-dns; an allowlist of `["api.anthropic.com"]` does not
  accidentally block DNS resolution for that very host.
- **CIDR allowlists also need a port.** This is an M3a limitation — the second
  CNP grants TCP/443 + 80 implicitly. If the tenant needs a non-standard port
  on a CIDR, contact the operator team (M3b will add explicit port flags).
- **Wildcards.** Use `*.linear.app` for subdomain matching. The builder emits
  `matchPattern` for entries containing `*` and `matchName` otherwise.

## Verification

```bash
kubectl --kubeconfig <kubeconfig> -n paperclip-<slug> get ciliumnetworkpolicies
```

You should see two CNPs:
- `paperclip-agent-egress-l7` (M1 baseline)
- `paperclip-tenant-<slug>-restrict` (M3a tenant DSL — only when the arrays are non-empty)
