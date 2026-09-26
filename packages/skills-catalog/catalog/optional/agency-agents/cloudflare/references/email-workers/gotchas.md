# Email Workers Troubleshooting

| Symptom or decision | Documentation |
| --- | --- |
| Raw stream already consumed or locked | [ReadableStream](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestream/) and [handler parsing guidance](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) |
| Forwarding or reply exception; unsupported forwarding headers | [Email handler actions and requirements](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) |
| Unverified destination or disabled rule | [Routing rules and addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/) |
| Sender identity or authentication failure | [Email authentication](https://developers.cloudflare.com/email-service/concepts/email-authentication/) and [troubleshooting](https://developers.cloudflare.com/email-service/reference/troubleshooting/) |
| Sending validation, attachment, or recipient error | [Sending API errors](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) |
| Local test or binary attachment issue | [Local routing](https://developers.cloudflare.com/email-service/local-development/routing/) and [local sending](https://developers.cloudflare.com/email-service/local-development/sending/) |
| CPU, memory, message-size, or reply limits | [Email limits](https://developers.cloudflare.com/email-service/platform/limits/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Background work or unhandled error | [Execution context](https://developers.cloudflare.com/workers/runtime-apis/context/) and [Workers logs](https://developers.cloudflare.com/workers/observability/logs/) |
| Mail accepted but missing at the destination | [Email activity logs](https://developers.cloudflare.com/email-service/observability/logs/) |

Raw content is single-use: reuse buffered content if multiple operations need it, and account for memory limits. `waitUntil()` extends execution lifetime; it does not remove CPU or memory limits. Diagnose reply failures against the incoming message's requirements, not just the sending domain's DNS.
