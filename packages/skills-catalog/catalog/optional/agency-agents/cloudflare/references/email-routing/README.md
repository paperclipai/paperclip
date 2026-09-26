# Email Routing

Use routing rules for address-based forwarding; use an Email Worker when incoming mail needs custom processing. Fetch the linked docs before implementing APIs, DNS, configuration, or limits.

| Task | Start here |
| --- | --- |
| Forward incoming mail to an existing mailbox | [Route emails](https://developers.cloudflare.com/email-service/get-started/route-emails/) |
| Manage addresses, verification, catch-all rules, or subaddressing | [Routing rules and addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/) |
| Filter, parse, reply to, or store incoming mail | [Email Workers](../email-workers/README.md) |
| Send a new outbound message | [Send emails](https://developers.cloudflare.com/email-service/get-started/send-emails/) — Workers binding, REST API, or SMTP |

Forwarding requires verified destinations. Replying within an incoming email event and sending a new outbound message have different requirements; use the relevant API docs.

## Reference map

- [Configuration](configuration.md): domains, rules, deployment, and local testing.
- [API](api.md): routing management and inbound/outbound operations.
- [Patterns](patterns.md): filtering, parsing, storage, and notifications.
- [Troubleshooting](gotchas.md): authentication, delivery, and current limits.
