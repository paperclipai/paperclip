# Flagship API Reference

## Binding API (Workers)

The binding is available as `env.FLAGS` (type `Flagship` from `@cloudflare/workers-types`).

### Evaluation Methods

All methods are async, never throw, and return the `defaultValue` on errors.

| Method | Signature | Returns |
|--------|-----------|---------|
| `get` | `get(flagKey, defaultValue?, context?)` | `Promise<unknown>` |
| `getBooleanValue` | `getBooleanValue(flagKey, defaultValue, context?)` | `Promise<boolean>` |
| `getStringValue` | `getStringValue(flagKey, defaultValue, context?)` | `Promise<string>` |
| `getNumberValue` | `getNumberValue(flagKey, defaultValue, context?)` | `Promise<number>` |
| `getObjectValue` | `getObjectValue<T>(flagKey, defaultValue, context?)` | `Promise<T>` |
| `getBooleanDetails` | `getBooleanDetails(flagKey, defaultValue, context?)` | `Promise<FlagshipEvaluationDetails<boolean>>` |
| `getStringDetails` | `getStringDetails(flagKey, defaultValue, context?)` | `Promise<FlagshipEvaluationDetails<string>>` |
| `getNumberDetails` | `getNumberDetails(flagKey, defaultValue, context?)` | `Promise<FlagshipEvaluationDetails<number>>` |
| `getObjectDetails` | `getObjectDetails<T>(flagKey, defaultValue, context?)` | `Promise<FlagshipEvaluationDetails<T>>` |

### Parameters (shared across all methods)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flagKey` | `string` | Yes | Flag key to evaluate |
| `defaultValue` | varies | Yes (except `get`) | Fallback if evaluation fails or flag not found |
| `context` | `FlagshipEvaluationContext` | No | Attributes for targeting rules (`{ userId: "user-42", country: "US" }`) |

### Types

```typescript
type FlagshipEvaluationContext = Record<string, string | number | boolean>;

interface FlagshipEvaluationDetails<T> {
  flagKey: string;
  value: T;
  variant?: string;     // name of the matched variation
  reason?: string;      // "TARGETING_MATCH" | "DEFAULT" | "DISABLED" | "SPLIT"
  errorCode?: string;   // "TYPE_MISMATCH" | "GENERAL"
  errorMessage?: string;
}
```

### Example

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const enabled = await env.FLAGS.getBooleanValue("new-feature", false, {
      userId: "user-42",
    });
    return new Response(enabled ? "Feature on" : "Feature off");
  },
};
```

---

## OpenFeature SDK

Package: `@cloudflare/flagship`

### Server Provider (`FlagshipServerProvider`)

For Workers, Node.js, and server-side JavaScript.

**With binding (recommended inside Workers):**

```typescript
import { OpenFeature } from "@openfeature/server-sdk";
import { FlagshipServerProvider } from "@cloudflare/flagship";

await OpenFeature.setProviderAndWait(
  new FlagshipServerProvider({ binding: env.FLAGS }),
);
const client = OpenFeature.getClient();
const enabled = await client.getBooleanValue("new-checkout", false, {
  targetingKey: "user-42",
});
```

**With app ID (Node.js / non-Worker runtimes):**

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
const enabled = await client.getBooleanValue("new-checkout", false, {
  targetingKey: "user-42",
});
```

### Client Provider (`FlagshipClientProvider`)

For browser applications. Pre-fetches flags on init, evaluates synchronously.

```typescript
import { OpenFeature } from "@openfeature/web-sdk";
import { FlagshipClientProvider } from "@cloudflare/flagship";

await OpenFeature.setProviderAndWait(
  new FlagshipClientProvider({
    appId: "<APP_ID>",
    accountId: "<ACCOUNT_ID>",
    authToken: "<API_TOKEN>",
    prefetchFlags: ["promo-banner", "dark-mode"],
  }),
);
await OpenFeature.setContext({ targetingKey: "user-42", plan: "enterprise" });
const client = OpenFeature.getClient();

// Synchronous — no await needed
const showBanner = client.getBooleanValue("promo-banner", false);
```

**Important:** Only flags listed in `prefetchFlags` are available. Unlisted flags return `FLAG_NOT_FOUND`.

### SDK Hooks

```typescript
import { LoggingHook, TelemetryHook } from "@cloudflare/flagship";
OpenFeature.addHooks(new LoggingHook(), new TelemetryHook());
```

---

## REST API (Flag Management)

Source of truth: [Cloudflare Flagship API reference](https://developers.cloudflare.com/api/resources/flagship/). Use it to verify REST paths, envelopes, response fields, and permission wording before relying on examples here.

### FIRST: Check Prerequisites

Before making any REST API calls (create, read, update, delete, toggle flags), verify these environment variables are set:

| Variable | Purpose | How to get |
|----------|---------|------------|
| `CLOUDFLARE_ACCOUNT_ID` | Account identifier | Dashboard URL or `wrangler whoami` |
| `CLOUDFLARE_API_TOKEN` | Bearer token for API auth | [Create API token](https://dash.cloudflare.com/profile/api-tokens) with Flagship permissions |
| `FLAGSHIP_APP_ID` | Target app UUID | Dashboard under **Compute > Flagship**, or `GET /apps` endpoint |

Check with:

```bash
echo "CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-(not set)}"
echo "CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN:-(not set)}"
echo "FLAGSHIP_APP_ID=${FLAGSHIP_APP_ID:-(not set)}"
```

**If any are missing, ask the user to provide them before proceeding.**

### Base URL and Auth

Base URL: `https://api.cloudflare.com/client/v4/accounts/{account_id}/flagship`

Authentication: `Authorization: Bearer <API_TOKEN>`

Management endpoints use the Cloudflare v4 envelope. On success, the payload is under `result`; errors are an array under `errors`.

```jsonc
// Success
{ "success": true, "result": <T>, "errors": [], "messages": [] }

// Paginated success
{
  "success": true,
  "result": [<T>],
  "result_info": { "count": 50, "cursor": "next-cursor-or-null" },
  "errors": [],
  "messages": []
}

// Error
{ "success": false, "result": null, "errors": [{ "message": "message" }], "messages": [] }
```

### App Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/apps` | List all apps |
| `GET` | `/apps/{app_id}` | Get app |
| `POST` | `/apps` | Create app (`{ "name": "my-app" }`) |
| `PUT` | `/apps/{app_id}` | Update app (`{ "name": "new-name" }`) |
| `DELETE` | `/apps/{app_id}` | Delete app |

App name constraints: alphanumeric + hyphens + underscores, 1-64 chars.

### Flag Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/apps/{app_id}/flags?limit=50&cursor=<cursor>` | List flags (paginated) |
| `GET` | `/apps/{app_id}/flags/{flag_key}` | Get flag |
| `POST` | `/apps/{app_id}/flags` | Create flag |
| `PUT` | `/apps/{app_id}/flags/{flag_key}` | Update flag (full replace) |
| `DELETE` | `/apps/{app_id}/flags/{flag_key}` | Delete flag |
| `GET` | `/apps/{app_id}/flags/{flag_key}/changelog?limit=20&cursor=<cursor>` | Flag changelog |

### Evaluate Endpoint

```
GET /apps/{app_id}/evaluate?flagKey=<key>&<context-attrs>
```

Requires an API token with the `com.cloudflare.account.flagship.evaluate` permission. Context attributes passed as query params. This endpoint is not wrapped in the management envelope; the SDK contract returns OpenFeature-style camelCase:

```json
{
  "flagKey": "my-flag",
  "value": true,
  "variant": "on",
  "reason": "SPLIT"
}
```

Reasons: `TARGETING_MATCH`, `SPLIT`, `DEFAULT`, `DISABLED`.

### Management Response Payloads

Management endpoints are wrapped in the Cloudflare v4 envelope shown above. Common `.result` payloads:

**App result**

```json
{
  "id": "app-uuid",
  "name": "my-app",
  "created_at": "2026-06-09T12:00:00.000Z",
  "updated_at": "2026-06-09T12:00:00.000Z",
  "updated_by": "user@example.com"
}
```

**Flag result**

```json
{
  "key": "my-flag",
  "type": "boolean",
  "default_variation": "off",
  "variations": { "on": true, "off": false },
  "rules": [],
  "description": "Enables the new feature",
  "enabled": true,
  "updated_at": "2026-06-09T12:00:00.000Z",
  "updated_by": "user@example.com"
}
```

**Changelog entry**

```json
{
  "flag_key": "my-flag",
  "event": "update",
  "after": { "key": "my-flag", "default_variation": "off", "variations": { "on": true, "off": false }, "rules": [], "enabled": true },
  "diff": { "enabled": { "from": false, "to": true } }
}
```

Changelog entries include the full flag state after the change. `update` entries also include `diff`.

---

## FlagDefinition Schema

```json
{
  "key": "my-flag",
  "type": "boolean",
  "default_variation": "off",
  "variations": {
    "on": true,
    "off": false
  },
  "rules": [
    {
      "priority": 1,
      "conditions": [
        {
          "attribute": "email",
          "operator": "ends_with",
          "value": "@cloudflare.com"
        }
      ],
      "serve_variation": "on",
      "rollout": { "percentage": 100 }
    }
  ],
  "description": "Enables the new feature",
  "enabled": true
}
```

### Field Constraints

| Field | Type | Constraints |
|-------|------|-------------|
| `key` | string | 1-64 chars, `/^[a-zA-Z0-9_-]+$/` |
| `type` | enum | Optional. `boolean`, `string`, `number`, `json` (auto-inferred from variations) |
| `default_variation` | string | Must be a key in `variations` |
| `variations` | `Record<string, T>` | At least one. All values same type. Keys: alphanumeric/hyphens/underscores, max 64 chars. Values max 10KB. |
| `rules` | `Rule[]` | Can be empty. No duplicate priorities. |
| `description` | string? | Max 512 chars, nullable |
| `enabled` | boolean | Required. `false` = always returns default variation. |

### Rule Schema

```json
{
  "priority": 1,
  "conditions": [ /* Condition[] */ ],
  "serve_variation": "on",
  "rollout": { "percentage": 50, "attribute": "targetingKey" }
}
```

- `priority`: integer >= 1, unique across rules in the flag (lower = evaluated first)
- `conditions`: array of base or logical conditions
- `serve_variation`: must be a key in `variations`
- `rollout`: optional. `percentage` 0-100. `attribute` defaults to `targetingKey`.

### Condition Schema

**Base condition:**

```json
{ "attribute": "email", "operator": "ends_with", "value": "@cloudflare.com" }
```

**Logical condition (AND/OR):**

```json
{
  "logical_operator": "AND",
  "clauses": [
    { "attribute": "country", "operator": "equals", "value": "US" },
    { "attribute": "plan", "operator": "in", "value": ["enterprise", "business"] }
  ]
}
```

Nesting supported up to 6 levels deep.

### Operators

| Operator | Description | Value Type |
|----------|-------------|------------|
| `equals` | Exact match (case-sensitive) | String |
| `not_equals` | Not exact match | String |
| `greater_than` | Numeric / datetime > | Number, ISO 8601 |
| `less_than` | Numeric / datetime < | Number, ISO 8601 |
| `greater_than_or_equals` | >= | Number, ISO 8601 |
| `less_than_or_equals` | <= | Number, ISO 8601 |
| `contains` | Substring match (case-sensitive) | String |
| `starts_with` | Prefix match | String |
| `ends_with` | Suffix match | String |
| `in` | Value in array | Array |
| `not_in` | Value not in array | Array |

---

## Rate Limits

| Operation | Limit |
|-----------|-------|
| Mutations (POST/PUT/DELETE) | 60 per 60s per account:app |
| Reads (GET) | 600 per 60s per account:app |

## Error Codes

| HTTP Status | Meaning |
|-------------|---------|
| 200 | Success (read/update/delete) |
| 201 | Created (create) |
| 400 | Validation error (check `errors[].message`) |
| 401 | Invalid or missing token |
| 404 | Flag or app not found |
| 409 | Flag key already exists (create) |
| 429 | Rate limited |
