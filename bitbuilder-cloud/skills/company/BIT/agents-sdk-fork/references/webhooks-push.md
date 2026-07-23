# Webhooks & Push Notifications

## Webhooks

Fetch https://developers.cloudflare.com/agents/api-reference/webhooks/ for complete documentation.

Route external webhooks to agent instances via `onRequest`:

```typescript
export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/webhooks/")) {
      const entityId = url.pathname.split("/")[2];
      const agent = getAgentByName(env.MyAgent, entityId);
      return agent.fetch(req);
    }
    return routeAgentRequest(req, env);
  }
};
```

In the agent:

```typescript
export class MyAgent extends Agent<Env, State> {
  async onRequest(request: Request) {
    const signature = request.headers.get("X-Signature");
    if (!verifySignature(signature, await request.text(), this.env.WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const payload = JSON.parse(await request.text());
    this.queue("processWebhook", payload);
    return new Response("OK", { status: 202 });
  }
}
```

**Tips:** Respond quickly (200/202), verify signatures, deduplicate with stored event IDs, use `queue()` for async processing.

## Push Notifications

Fetch https://developers.cloudflare.com/agents/api-reference/push-notifications/ for complete documentation.

Web Push via VAPID from agents. Store subscriptions in agent state, send via `web-push`.

```bash
npm install web-push
```

```typescript
import webpush from "web-push";

export class NotifyAgent extends Agent<Env, State> {
  @callable()
  async subscribe(subscription: PushSubscription) {
    this.setState({
      ...this.state,
      subscriptions: [...this.state.subscriptions, subscription]
    });
  }

  async sendReminder(payload: { message: string }, schedule: Schedule) {
    for (const sub of this.state.subscriptions) {
      try {
        await webpush.sendNotification(sub, JSON.stringify({
          title: "Reminder",
          body: payload.message
        }), {
          vapidDetails: {
            subject: "mailto:you@example.com",
            publicKey: this.env.VAPID_PUBLIC_KEY,
            privateKey: this.env.VAPID_PRIVATE_KEY
          }
        });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          // Remove expired subscription
        }
      }
    }
  }
}
```

VAPID keys: generate with `npx web-push generate-vapid-keys`, store as secrets.
