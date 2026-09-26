# Tunnel Troubleshooting

Capture the tunnel status, failing route, management mode, and cloudflared logs before changing settings.

| Task | Documentation |
| --- | --- |
| Tunnel fails to connect or reports an error | [Troubleshooting](https://developers.cloudflare.com/tunnel/troubleshooting/) |
| Tunnel is healthy but an HTTPS application fails or redirects | [HTTPS origins](https://developers.cloudflare.com/tunnel/troubleshooting/https-origins/) |
| Inspect connection health and application diagnostics | [Monitoring](https://developers.cloudflare.com/tunnel/monitoring/) |
| Check local configuration and rule matching | [Configuration file](https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/) |
| Connections behave unexpectedly after token rotation | [Tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/) |
| Check replica capacity or firewall requirements | [Configuration](https://developers.cloudflare.com/tunnel/configuration/) |
| Update an existing installation | [Update cloudflared](https://developers.cloudflare.com/tunnel/downloads/update-cloudflared/) |

Separate tunnel health from origin availability. Check the service address, protocol, and certificate before relaxing verification. Scope operational changes to the intended tunnel and replicas; follow the documented rotation and upgrade sequence instead of stopping every cloudflared process on a host. See [networking.md](./networking.md) for connectivity checks.
