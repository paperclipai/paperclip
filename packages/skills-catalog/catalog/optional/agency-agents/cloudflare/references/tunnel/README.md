# Cloudflare Tunnel

Use Tunnel to connect origin services to Cloudflare. Inspect the existing tunnel, management mode, and intended audience before choosing a setup. Fetch current docs for commands, configuration, and limits.

| Task | Documentation |
| --- | --- |
| Create a remotely-managed tunnel or a temporary development tunnel | [Setup](https://developers.cloudflare.com/tunnel/setup/) |
| Maintain a tunnel managed through local files | [Create a locally-managed tunnel](https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/) |
| Publish an application and check protocol requirements | [Routing](https://developers.cloudflare.com/tunnel/routing/) |
| Choose private networking, Workers VPC, or Access integration | [Integrations](https://developers.cloudflare.com/tunnel/integrations/) |

Decide whether the goal is a public application, authenticated private access, or connectivity from a Worker. Then identify who owns configuration and how it will be deployed; multiple environments alone do not require local management.

## In This Reference

- [configuration.md](./configuration.md) — management mode, ingress, and origin settings
- [networking.md](./networking.md) — firewall, connectivity, and private-network investigation
- [api.md](./api.md) — programmatic setup and tunnel operations
- [patterns.md](./patterns.md) — deployment and availability decisions
- [gotchas.md](./gotchas.md) — troubleshooting and operational checks
