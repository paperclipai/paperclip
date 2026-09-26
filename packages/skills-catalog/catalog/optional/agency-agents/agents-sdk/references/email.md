# Email Handling

Fetch https://developers.cloudflare.com/agents/api-reference/email/ for complete documentation.

## Overview

Agents receive and reply to emails via Cloudflare Email Routing.

## Wrangler Configuration

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "EmailAgent", "class_name": "EmailAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["EmailAgent"] }],
  "send_email": [
    { "name": "SEB", "destination_address": "reply@yourdomain.com" }
  ]
}
```

## Basic Email Handler

```typescript
import { Agent } from "agents";
import { type AgentEmail } from "agents/email";
import PostalMime from "postal-mime";

export class EmailAgent extends Agent<Env, State> {
  async onEmail(email: AgentEmail) {
    const raw = await email.getRaw();
    const parsed = await PostalMime.parse(raw);

    console.log("From:", email.from);
    console.log("Subject:", parsed.subject);

    await this.replyToEmail(email, {
      fromName: "My Agent",
      subject: `Re: ${parsed.subject}`,
      body: "Thanks for your email!"
    });
  }
}
```

## Routing Emails

```typescript
import { routeAgentRequest, routeAgentEmail } from "agents";
import { createAddressBasedEmailResolver } from "agents/email";

export default {
  async email(message, env) {
    await routeAgentEmail(message, env, {
      resolver: createAddressBasedEmailResolver("EmailAgent")
    });
  },

  async fetch(request, env) {
    return routeAgentRequest(request, env) ?? new Response("Not found", { status: 404 });
  }
};
```

## Resolvers

### Address-Based (Inbound Mail)

Routes based on recipient address:

```typescript
import { createAddressBasedEmailResolver } from "agents/email";

const resolver = createAddressBasedEmailResolver("EmailAgent");
// support@example.com → EmailAgent, instance "support"
// NotificationAgent+user123@example.com → NotificationAgent, instance "user123"
```

### Secure Reply (Reply Flows)

Verifies replies are authentic using HMAC-SHA256 signatures:

```typescript
import { createSecureReplyEmailResolver } from "agents/email";

const resolver = createSecureReplyEmailResolver(env.EMAIL_SECRET, {
  maxAge: 7 * 24 * 60 * 60, // 7 days (default: 30 days)
  onInvalidSignature: (email, reason) => {
    console.warn(`Invalid signature from ${email.from}: ${reason}`);
  }
});
```

Sign outbound emails to enable secure reply routing:

```typescript
await this.replyToEmail(email, {
  fromName: "My Agent",
  body: "Thanks!",
  secret: this.env.EMAIL_SECRET  // Signs headers for secure reply routing
});
```

### Catch-All (Single Instance)

Routes all emails to one agent instance:

```typescript
import { createCatchAllEmailResolver } from "agents/email";

const resolver = createCatchAllEmailResolver("EmailAgent", "default");
```

### Combining Resolvers

```typescript
async email(message, env) {
  const secureReply = createSecureReplyEmailResolver(env.EMAIL_SECRET);
  const addressBased = createAddressBasedEmailResolver("EmailAgent");

  await routeAgentEmail(message, env, {
    resolver: async (email, env) => {
      // Try secure reply first
      const result = await secureReply(email, env);
      if (result) return result;
      // Fall back to address-based
      return addressBased(email, env);
    }
  });
}
```

## Utilities

```typescript
import { isAutoReplyEmail } from "agents/email";

async onEmail(email: AgentEmail) {
  if (isAutoReplyEmail(email.headers)) {
    // Skip auto-replies (vacation, out-of-office, etc.)
    return;
  }
  // Process email...
}
```
