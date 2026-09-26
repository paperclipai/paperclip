# Sending Emails — REST API

Use the REST API for HTTP integrations from external applications, or when the user explicitly requests it inside a Worker. Otherwise prefer the [Workers binding](sending.md).

Read the relevant page before building the request. Keep credentials in the project's existing secret or environment-variable mechanism, and inspect the installed client SDK version if one is used.

| Task | Read |
|------|------|
| Authenticate, send an email, or find the complete request schema | [REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/) and its linked Email Sending API reference |
| Set multiple recipients, CC/BCC, or named addresses | [Specify recipients](https://developers.cloudflare.com/email-service/examples/email-sending/recipients/) (REST examples) |
| Encode attachments | [REST attachments](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/#attachments) |
| Add custom headers | [Email headers](https://developers.cloudflare.com/email-service/reference/headers/) |
| Check recipient, message-size, or sending quotas | [Limits](https://developers.cloudflare.com/email-service/platform/limits/) |
| Interpret delivery outcomes | [REST response](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/#response) |
| Diagnose errors and decide whether to retry | [REST error handling](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/#error-handling) |

Do not reuse a Workers binding payload or response parser unchanged: verify field names, attachment encoding, response shape, and error handling for the chosen API. Validate both successful responses and failures through the project's existing checks; distinguish retryable service failures from requests that need correction.
