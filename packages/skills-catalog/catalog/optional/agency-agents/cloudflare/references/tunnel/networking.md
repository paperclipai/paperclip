# Tunnel Networking

Investigate the connection from cloudflared to Cloudflare separately from the connection to the origin and the client access path.

| Task | Documentation |
| --- | --- |
| Determine required egress ports and destinations | [Firewall rules](https://developers.cloudflare.com/tunnel/configuration/#firewall-rules) |
| Diagnose DNS, QUIC, or TCP connectivity | [Connection errors](https://developers.cloudflare.com/tunnel/troubleshooting/#connection-errors) |
| Configure transport and runtime options | [Run parameters](https://developers.cloudflare.com/tunnel/advanced/run-parameters/) |
| Check service protocols and client requirements | [Routing](https://developers.cloudflare.com/tunnel/routing/) |
| Set up private-network access with Cloudflare One | [Connect private networks with cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/) |
| Inspect tunnel health, logs, and metrics | [Monitoring](https://developers.cloudflare.com/tunnel/monitoring/) |

Test from the machine or container running cloudflared. Compare the actual firewall policy with the current documented destinations; do not infer transport ports from the origin protocol. For private access, follow the linked Cloudflare One setup for routes and device-client configuration instead of reusing public-hostname instructions. See [gotchas.md](./gotchas.md) for origin failures.
