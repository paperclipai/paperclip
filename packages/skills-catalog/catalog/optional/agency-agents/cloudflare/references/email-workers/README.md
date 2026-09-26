# Email Workers

Use an Email Worker's `email()` handler for custom processing of incoming mail. Use [routing rules](../email-routing/README.md) for simple address-based forwarding. Fetch current documentation before implementing the handler or its dependencies.

| Operation | Documentation |
| --- | --- |
| Forward to a verified destination, reject, or reply within the incoming event | [Email handler API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) |
| Send a new message or a later response | [Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) |
| Parse and store mail for later processing | [Email storage and processing](https://developers.cloudflare.com/email-service/examples/email-routing/email-storage/) |

`message.raw` is a single-use stream. If parsing and archiving both need the raw content, plan how to reuse it rather than reading the stream twice. Forwarding destinations must be verified; reply requirements are documented separately from outbound sending.

## Reference map

- [Configuration](configuration.md): routing, bindings, local development, and types.
- [API](api.md): message actions, MIME, and sending.
- [Patterns](patterns.md): filtering, storage, attachments, and background processing.
- [Troubleshooting](gotchas.md): stream handling, authentication, limits, and errors.
