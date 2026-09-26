# Flagship Configuration

## Wrangler Binding Setup

Add a Flagship binding to your Wrangler config to access flags via `env.FLAGS`.

### Single App

```jsonc
// wrangler.jsonc
{
  "flagship": {
    "binding": "FLAGS",
    "app_id": "<APP_ID>"
  }
}
```

```toml
# wrangler.toml
[flagship]
binding = "FLAGS"
app_id = "<APP_ID>"
```

### Multiple Apps

```jsonc
// wrangler.jsonc
{
  "flagship": [
    {
      "binding": "FLAGS",
      "app_id": "<APP_ID_1>"
    },
    {
      "binding": "EXPERIMENT_FLAGS",
      "app_id": "<APP_ID_2>"
    }
  ]
}
```

```toml
# wrangler.toml
[[flagship]]
binding = "FLAGS"
app_id = "<APP_ID_1>"

[[flagship]]
binding = "EXPERIMENT_FLAGS"
app_id = "<APP_ID_2>"
```

### Generate Types

After adding the binding, generate TypeScript types:

```bash
npx wrangler types
```

This creates the `Env` interface with each binding typed as `Flagship`:

```typescript
interface Env {
  FLAGS: Flagship;
  EXPERIMENT_FLAGS: Flagship; // if multiple
}
```

The `Flagship` type comes from `@cloudflare/workers-types`.

---

## OpenFeature SDK Installation

### Server-Side (Workers, Node.js)

```bash
npm i @cloudflare/flagship @openfeature/server-sdk
```

### Browser

```bash
npm i @cloudflare/flagship @openfeature/web-sdk
```

---

## SDK Provider Setup

### Server Provider — With Binding (Workers)

Recommended approach inside Workers. No HTTP overhead, auth handled automatically.

```typescript
import { OpenFeature } from "@openfeature/server-sdk";
import { FlagshipServerProvider } from "@cloudflare/flagship";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await OpenFeature.setProviderAndWait(
      new FlagshipServerProvider({ binding: env.FLAGS }),
    );
    const client = OpenFeature.getClient();
    // ... evaluate flags
  },
};
```

### Server Provider — With App ID (Node.js)

For non-Worker runtimes. Requires an API token with Flagship read permissions.

```typescript
import { OpenFeature } from "@openfeature/server-sdk";
import { FlagshipServerProvider } from "@cloudflare/flagship";

await OpenFeature.setProviderAndWait(
  new FlagshipServerProvider({
    appId: "<APP_ID>",
    accountId: "<ACCOUNT_ID>",
    authToken: "<API_TOKEN>",
  }),
);
const client = OpenFeature.getClient();
```

### Client Provider (Browser)

Pre-fetches flags on init, then evaluates synchronously. Only `prefetchFlags` are available.

```typescript
import { OpenFeature } from "@openfeature/web-sdk";
import { FlagshipClientProvider } from "@cloudflare/flagship";

await OpenFeature.setProviderAndWait(
  new FlagshipClientProvider({
    appId: "<APP_ID>",
    accountId: "<ACCOUNT_ID>",
    authToken: "<API_TOKEN>",
    prefetchFlags: ["promo-banner", "dark-mode", "max-uploads"],
  }),
);
await OpenFeature.setContext({ targetingKey: "user-42", plan: "enterprise" });
const client = OpenFeature.getClient();
```

### Provider Options Reference

**FlagshipServerProvider:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `binding` | `Flagship` | No | Binding from `env.FLAGS`. Use inside Workers. |
| `appId` | string | No | App ID from dashboard. Required without binding. |
| `accountId` | string | No | Cloudflare account ID. Required without binding. |
| `authToken` | string | No | API token with Flagship read permissions. Required without binding. |

Provide either `binding` or all three of `appId` + `accountId` + `authToken`.

**FlagshipClientProvider:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `appId` | string | Yes | App ID from dashboard |
| `accountId` | string | Yes | Cloudflare account ID |
| `authToken` | string | Yes | API token with Flagship read permissions |
| `prefetchFlags` | string[] | Yes | Flag keys to prefetch. Unlisted flags return `FLAG_NOT_FOUND`. |

---

## REST API Authentication

For managing flags via the REST API (create, update, delete), set these environment variables:

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | API token with Flagship permissions |
| `FLAGSHIP_APP_ID` | Target app UUID (from dashboard under **Compute > Flagship**, or `GET /apps`) |

Base URL: `https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship`

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps" | jq .
```

App IDs are shown in the Cloudflare dashboard under **Compute > Flagship**.

---

## Local Development

Flagship bindings work in local dev with `wrangler dev`. Flag evaluation uses the live Flagship configuration — there is no local flag store. Ensure the `app_id` in your Wrangler config points to a valid app.

```bash
npx wrangler dev
```
