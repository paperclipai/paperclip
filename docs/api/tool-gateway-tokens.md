---
title: Tool Gateway Tokens
summary: Create, reveal and revoke gateway client tokens
---

A tool gateway exposes a company's tool access profile to external MCP clients. A client connects with a gateway client token. Paperclip stores only a hash of each token value.

## Create a Token

```
POST /api/tool-gateway/gateways/{gatewayId}/tokens
{
  "companyId": "{companyId}",
  "name": "Website client",
  "clientLabel": "Website client",
  "expiresAt": "2026-12-31T23:59:59.000Z"
}
```

The caller needs `tools:admin` in the company.

A person (board session) receives the value once, in the `token` field of the `201` response. Copy it then: Paperclip cannot show it again.

An agent with delegated connection management can create a token for its responsible person. The agent never receives a value. The `201` response contains:

- token metadata: `id`, `name`, `tokenPrefix`, `expiresAt`, `responsibleUserId`, and `pendingReveal: true`
- `tokensPath`: the gateway's Tokens page, `/{prefix}/apps/gateways/{gatewayId}/tokens`
- `requiredUserAction`: `kind: "reveal_credential"` for the responsible person, with `setupPath` set to the Tokens page
- `nextStep`: an instruction for the agent

A token with `pendingReveal: true` has no usable value and cannot authenticate. The agent sends the person to the Tokens page to reveal it.

To rotate a client's token, create the replacement and leave the old token active. The client keeps working on the old token until the person installs the new value. Revoke the old token after the client works with the new one.

## Reveal an Agent-Created Token

```
POST /api/tool-gateway/gateway-tokens/{tokenId}/reveal
{ "companyId": "{companyId}" }
```

Person-only. Paperclip generates the value at this moment, stores its hash, and returns it once in the `token` field. The Tokens page calls this route from its **Reveal token** button.

| Status | Reason code | Meaning |
|--------|-------------|---------|
| `200` | | The response contains the value. It is not shown again. |
| `403` | `gateway_token_requires_person` | The caller is an agent. Only a person can reveal a value. |
| `403` | `gateway_token_reveal_requires_responsible_person` | The token acts for another person. Only that person can reveal it. |
| `409` | `gateway_token_already_revealed` | The value was already shown once. Create a new token to get a new value. |
| `409` | `gateway_token_revoked` | The token was revoked before its value was revealed. |
| `409` | `gateway_token_expired` | The token expired before its value was revealed. Create a new token. |

Each reveal writes a `tool_gateway.token_revealed` activity entry.

## Revoke a Token

```
POST /api/tool-gateway/gateway-tokens/{tokenId}/revoke
{ "companyId": "{companyId}" }
```

A person or an agent with delegated connection management can revoke a token. Clients that use it stop working at once.

## Create a Gateway

```
POST /api/companies/{companyId}/tools/gateways
```

When an agent creates a gateway, the `201` response also contains `gatewayPath` (`/{prefix}/apps/gateways/{gatewayId}/overview`), `tokensPath` and `nextStep`.
