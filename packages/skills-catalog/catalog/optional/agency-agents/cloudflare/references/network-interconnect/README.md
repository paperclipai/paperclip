# Cloudflare Network Interconnect (CNI)

Private, high-performance connectivity to Cloudflare's network. **Enterprise-only**.

## Connection Types

**Direct**: Physical fiber in shared datacenter. 10/100 Gbps. You order cross-connect.

**Partner**: Virtual via Console Connect, Equinix, Megaport, etc. Managed via partner SDN.

**Cloud**: AWS Direct Connect or GCP Cloud Interconnect. Magic WAN only.

## Dataplane Versions

**v1 (Classic)**: GRE tunnel support, VLAN/BFD/LACP, asymmetric MTU (1500↓/1476↑), peering support.

**v2 (Beta)**: No GRE, 1500 MTU both ways, no VLAN/BFD/LACP yet, ECMP instead.

## Use Cases

- **Magic Transit DSR**: DDoS protection, egress via ISP (v1/v2)
- **Magic Transit + Egress**: DDoS + egress via CF (v1/v2)
- **Magic WAN + Zero Trust**: Private backbone (v1 needs GRE, v2 native)
- **Peering**: Public routes at PoP (v1 only)
- **App Security**: WAF/Cache/LB (v1/v2 over Magic Transit)

## Prerequisites

- Enterprise plan
- IPv4 /24+ or IPv6 /48+ prefixes
- BGP ASN for v1
- See [locations PDF](https://developers.cloudflare.com/network-interconnect/static/cni-locations-05-may-2026.pdf)

## Specs

- /31 point-to-point subnets
- 10km max optical distance
- 10G: 10GBASE-LR single-mode
- 100G: 100GBASE-LR4 single-mode
- **No SLA** (free service)
- Backup Internet required

## Throughput

| Direction | 10G | 100G |
|-----------|-----|------|
| CF → Customer | 10 Gbps | 100 Gbps |
| Customer → CF (peering) | 10 Gbps | 100 Gbps |
| Customer → CF (Magic) | 1 Gbps/tunnel or CNI | 1 Gbps/tunnel or CNI |

## Timeline

2-4 weeks typical. Steps: request → config review → order connection → configure → test → enable health checks → activate → monitor.

## In This Reference
- [configuration.md](./configuration.md) - BGP, routing, setup
- [api.md](./api.md) - API endpoints, SDKs
- [patterns.md](./patterns.md) - HA, hybrid cloud, failover
- [gotchas.md](./gotchas.md) - Troubleshooting, limits

## Reading Order by Task

| Task | Files to Load |
|------|---------------|
| Initial setup | README → configuration.md → api.md |
| Create interconnect via API | api.md → gotchas.md |
| Design HA architecture | patterns.md → README |
| Troubleshoot connection | gotchas.md → configuration.md |
| Cloud integration (AWS/GCP) | configuration.md → patterns.md |
| Monitor + alerts | configuration.md |

## Automation Boundary

**API-Automatable:**
- List/create/delete interconnects (Direct, Partner)
- List available slots
- Get interconnect status
- Download LOA PDF
- Create/update CNI objects (BGP config)
- Query settings

**Requires Account Team:**
- Initial request approval
- AWS Direct Connect setup (send LOA+VLAN to CF)
- GCP Cloud Interconnect final activation
- Partner interconnect acceptance (Equinix, Megaport)
- VLAN assignment (v1)
- Configuration document generation (v1)
- Escalations + troubleshooting support

**Cannot Be Automated:**
- Physical cross-connect installation (Direct)
- Partner portal operations (virtual circuit ordering)
- AWS/GCP portal operations
- Maintenance window coordination

## See Also
- [tunnel](../tunnel/) - Alternative for private network connectivity
- [spectrum](../spectrum/) - Layer 4 proxy for TCP/UDP traffic
