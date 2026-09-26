# Email Routing Patterns

Prefer a routing rule when the destination depends only on the email address. Use an Email Worker for decisions based on message content or application state.

| Task | Documentation |
| --- | --- |
| Address-based forwarding, catch-all, or subaddressing | [Routing rules and addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/) |
| Recipient/subject routing, multiple destinations, rejection, or automatic replies | [Email handler actions](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) |
| Filter unwanted messages | [Spam filtering](https://developers.cloudflare.com/email-service/examples/email-routing/spam-filtering/) |
| Parse MIME, extract attachments, archive mail, or notify an application | [Email Workers patterns](../email-workers/patterns.md) |
| Send outbound attachments | [Email attachments](https://developers.cloudflare.com/email-service/examples/email-sending/email-attachments/) |

Verify all forwarding destinations. For delayed responses after processing or human review, use the outbound sending API; an incoming event's reply operation belongs to that event.
