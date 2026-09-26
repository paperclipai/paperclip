# Tunnel Configuration

Read the documentation for the existing management mode before changing routes or credentials.

| Task | Documentation |
| --- | --- |
| Configure remotely-managed tunnels | [Setup](https://developers.cloudflare.com/tunnel/setup/) |
| Edit local ingress rules, service mappings, and validate matching | [Configuration file](https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/) |
| Configure origin TLS, HTTP, and connection behavior | [Origin parameters](https://developers.cloudflare.com/tunnel/advanced/origin-parameters/) |
| Configure runtime flags and service arguments | [Run parameters](https://developers.cloudflare.com/tunnel/advanced/run-parameters/) |
| Manage remote tunnel tokens and rotation | [Tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/) |
| Choose service protocols and DNS routing | [Routing](https://developers.cloudflare.com/tunnel/routing/) |

Confirm which configuration source the running process uses, then review the routes affected by the change. Match origin settings to the actual service and certificate rather than copying settings from a different deployment. See [networking.md](./networking.md) for connectivity and [patterns.md](./patterns.md) for rollout decisions.
