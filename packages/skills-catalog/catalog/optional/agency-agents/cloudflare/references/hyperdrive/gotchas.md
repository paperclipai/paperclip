# Hyperdrive troubleshooting

Start with the actual error and the affected configuration. Fetch [Troubleshoot and debug](https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/) for current error codes and diagnosis rather than guessing from a generic connection failure.

| Symptom | What to inspect and where to read |
|---------|----------------------------------|
| Connection refused or authentication failure | Check origin reachability and credentials using [troubleshooting](https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/) and [firewall/networking configuration](https://developers.cloudflare.com/hyperdrive/configuration/firewall-and-networking-configuration/). |
| Private database or TLS failure | Follow the selected [Workers VPC](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database-vpc/) or [Tunnel/Access](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/) path and its certificate prerequisites; see [SSL/TLS configuration](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/). |
| Pool exhaustion or too many connections | Distinguish client connection lifetime from origin pool capacity. Read [connection lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/), [pool tuning](https://developers.cloudflare.com/hyperdrive/configuration/tune-connection-pool/), and [limits](https://developers.cloudflare.com/hyperdrive/platform/limits/). |
| Query timeout | Check the current [limits](https://developers.cloudflare.com/hyperdrive/platform/limits/) and [metrics](https://developers.cloudflare.com/hyperdrive/observability/metrics/) before changing query or transaction design. |
| Stale reads or unexpectedly uncached queries | Inspect the binding's cache configuration and query eligibility in [query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/). Writes do not purge cached reads; do not treat prepared-statement settings as cache controls. |
| Slow multi-query requests | Inspect [metrics](https://developers.cloudflare.com/hyperdrive/observability/metrics/) and evaluate [Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/). |
| Local connection failure, ignored environment variable, or absent cache behavior | Check binding names, local connection overrides, precedence, and remote testing in [local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/). |
| Unsupported driver or SQL feature | Check [supported databases and features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/) and the selected [driver guide](./api.md). |

## Capacity and changes

Retrieve [limits](https://developers.cloudflare.com/hyperdrive/platform/limits/) and [pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) for current plan allowances, connection and query bounds, and limit-increase guidance. Check [release notes](https://developers.cloudflare.com/hyperdrive/platform/release-notes/) when behavior changes after an upgrade.

See [configuration.md](./configuration.md) to change a configuration and [patterns.md](./patterns.md) to revisit freshness or connection decisions.
