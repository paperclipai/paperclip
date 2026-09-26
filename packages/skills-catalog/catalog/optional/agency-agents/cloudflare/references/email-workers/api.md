# Email Workers APIs

Fetch the relevant page for current interfaces and return types.

| Task | Documentation |
| --- | --- |
| Implement the handler; inspect envelope addresses, headers, raw content, or size | [Email handler API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) |
| Forward, add forwarding headers, reject, or reply with MIME and threading | [Email actions and reply requirements](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) |
| Parse MIME bodies and attachments | [Email handler parsing guidance](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) — follow its postal-mime reference |
| Send new outbound mail or an existing raw MIME message | [Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) |
| Configure sender and recipient restrictions | [Send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/) |
| Set outbound headers | [Email headers](https://developers.cloudflare.com/email-service/reference/headers/) |
| Generate Worker and binding types | [Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/) |

Envelope addresses describe SMTP transport; message headers describe the message. Neither an address comparison nor a display header replaces [email authentication](https://developers.cloudflare.com/email-service/concepts/email-authentication/).
