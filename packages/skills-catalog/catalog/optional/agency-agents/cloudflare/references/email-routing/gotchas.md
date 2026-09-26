# Email Routing Troubleshooting

Start with the message's activity log to distinguish routing, authentication, and delivery failures, then fetch the matching documentation.

| Symptom or question | Documentation |
| --- | --- |
| Rule disabled, wrong destination, or catch-all behavior | [Routing rules and verified addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/) |
| DNS conflict or domain not configured | [Domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/) |
| SPF, DKIM, or DMARC failure | [Authentication troubleshooting](https://developers.cloudflare.com/email-service/reference/troubleshooting/) |
| Message missing, rejected, dropped, or delivery failed | [Email logs](https://developers.cloudflare.com/email-service/observability/logs/) |
| Quotas, message sizes, routing capacity, or Worker resource exhaustion | [Current limits](https://developers.cloudflare.com/email-service/platform/limits/) |
| Sending costs and verified-destination allowances | [Pricing](https://developers.cloudflare.com/email-service/platform/pricing/) |
| Stream, parser, reply, or Worker execution error | [Email Workers troubleshooting](../email-workers/gotchas.md) |

Do not use a sender-address string as proof of authentication. Inspect the authentication results described in the logs and authentication docs.
