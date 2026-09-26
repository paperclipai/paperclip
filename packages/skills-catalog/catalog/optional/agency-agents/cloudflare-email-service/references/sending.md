# Sending Emails — Workers Binding & Agents SDK

Prefer the native binding for Workers. For an external application, or when the user explicitly requests HTTP integration, use the [REST API guide](rest-api.md).

Read the documentation for the selected task before implementing. Inspect the project's installed Wrangler and Agents SDK versions, configuration, and existing conventions first. Run `wrangler types` through the project's package manager after changing bindings; use its generated types instead of handwritten email interfaces. See [Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/) for matching types to the project's compatibility date and flags. Do not upgrade dependencies just to match an example.

| Task | Read |
|------|------|
| Configure the binding, send a message, or maintain existing MIME-based sending | [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) |
| Restrict sender or destination addresses | [Configure send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/) |
| Set multiple recipients, CC/BCC, or named addresses | [Specify recipients](https://developers.cloudflare.com/email-service/examples/email-sending/recipients/) |
| Add files, inline images, or uploaded attachments | [Email attachments](https://developers.cloudflare.com/email-service/examples/email-sending/email-attachments/) |
| Set custom headers or diagnose header validation | [Email headers](https://developers.cloudflare.com/email-service/reference/headers/) |
| Check recipient, message-size, or sending quotas | [Limits](https://developers.cloudflare.com/email-service/platform/limits/) |
| Choose local simulation or remote delivery | [Local email sending](https://developers.cloudflare.com/email-service/local-development/sending/) |
| Interpret send results and binding errors | [Workers API response and error handling](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/#error-handling) |
| Send, receive, route, and securely reply from an Agent | [Email agent walkthrough](https://developers.cloudflare.com/agents/examples/email-agent/) |

When adapting REST code to a binding, verify address fields, attachment representation, response shape, and errors against the binding docs and generated types. Exercise the relevant success and failure paths using the project's existing checks. Confirm whether the chosen local configuration simulates delivery or sends real mail before testing.
