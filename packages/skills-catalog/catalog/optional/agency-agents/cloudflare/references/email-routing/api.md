# Email Routing APIs

Fetch the relevant API page before writing code; do not infer sending types or recipient restrictions from incoming-mail APIs.

| Task | Documentation |
| --- | --- |
| Manage routing settings, rules, and destination addresses programmatically | [Email Routing REST API](https://developers.cloudflare.com/api/resources/email_routing/) |
| Read incoming message metadata; forward, reply, or reject | [Email handler API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) |
| Send from a Worker, including attachments or existing raw MIME | [Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) |
| Restrict a sending binding's senders or recipients | [Configure send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/) |
| Send from an external application | [Sending REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/) or [SMTP](https://developers.cloudflare.com/email-service/api/send-emails/smtp/) |

For incoming messages, distinguish SMTP envelope addresses from message headers. Use [Email Workers API guidance](../email-workers/api.md) for processing and [authentication docs](https://developers.cloudflare.com/email-service/concepts/email-authentication/) for identity checks.
