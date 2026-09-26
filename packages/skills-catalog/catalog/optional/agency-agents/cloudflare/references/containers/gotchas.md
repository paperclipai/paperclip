# Containers troubleshooting

Use the current documentation to diagnose behavior instead of relying on copied timeout values, resource limits, or lifecycle recipes.

| Symptom or concern | Documentation to read |
| --- | --- |
| Startup timeout or unavailable port | [Start and stop](https://developers.cloudflare.com/containers/reference/container-class/#start-and-stop), [Container properties](https://developers.cloudflare.com/containers/reference/container-class/#properties), and [first-deploy provisioning](https://developers.cloudflare.com/containers/get-started/) |
| WebSocket forwarding fails | [WebSocket example](https://developers.cloudflare.com/containers/examples/websocket/) and [request methods](https://developers.cloudflare.com/containers/reference/container-class/#request-methods) |
| Background work stops on idle expiry | [Activity renewal](https://developers.cloudflare.com/containers/reference/container-class/#renewactivitytimeout) and [idle expiry hook](https://developers.cloudflare.com/containers/reference/container-class/#onactivityexpired) |
| Scheduled callbacks do not run | [Scheduling and alarm ownership](https://developers.cloudflare.com/containers/reference/container-class/#scheduling) |
| Shutdown cleanup or filesystem data loss | [Container shutdown and disk lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/#container-shutdown) |
| Out-of-memory errors or resource exhaustion | [FAQ](https://developers.cloudflare.com/containers/faq/) and [limits and instance types](https://developers.cloudflare.com/containers/platform/limits/) |
| Instance count exceeded or unexpected request distribution | [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#containers) and [scaling and routing](https://developers.cloudflare.com/containers/configuration/scaling-and-routing/) |
| Worker and container image versions differ after deployment | [Deployment behavior](https://developers.cloudflare.com/containers/guides/deploy/) and [rollouts](https://developers.cloudflare.com/containers/configuration/rollouts/) |
| Local behavior differs from deployed behavior | [Local development](https://developers.cloudflare.com/containers/guides/local-dev/) |
| Logs, cold starts, or runtime availability questions | [FAQ](https://developers.cloudflare.com/containers/faq/) |
