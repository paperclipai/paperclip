# AI Gateway Configuration

Choose the request path before configuring authentication: Cloudflare REST inference, a Workers binding, and provider-native gateway endpoints have different requirements. Gateway access does not by itself define which upstream credentials or billing source a request uses.

| Task | Current documentation |
|------|-----------------------|
| Send a first request and locate the account/gateway identifiers | [Getting started](https://developers.cloudflare.com/ai-gateway/get-started/) |
| Create, update, or delete a gateway; use the default gateway | [Manage gateways](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/) |
| Manage gateways programmatically | [Gateway management API](https://developers.cloudflare.com/api/resources/ai_gateway/methods/list/) |
| Protect gateway access and choose token permissions for the endpoint | [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) and [REST API authentication](https://developers.cloudflare.com/ai-gateway/usage/rest-api/#authentication) |
| Configure Wrangler and an AI binding | [Workers AI binding setup](https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/) and [binding methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/) |
| Store provider keys, select aliases, or diagnose missing credentials | [Bring Your Own Keys](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/) |
| Use Cloudflare billing or determine which credentials take precedence | [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) |
| Supply provider credentials with each request | [Provider guides](https://developers.cloudflare.com/ai-gateway/usage/providers/) |

Keep credentials out of source code. Use the chosen endpoint's documentation for headers and permissions instead of reusing an authentication recipe from another endpoint. Check credential precedence before changing an existing BYOK or billing setup.

For SDK selection, see [SDK integration](./sdk-integration.md); for policy settings, see [features](./features.md).
