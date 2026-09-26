# Flagship Patterns & Best Practices

## Evaluating Flags in Workers (Binding)

### Simple Boolean Toggle

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const showNewUI = await env.FLAGS.getBooleanValue("new-ui", false, {
      userId: "user-42",
    });

    if (showNewUI) {
      return new Response("New UI");
    }
    return new Response("Classic UI");
  },
};
```

### Multi-Variant String Flag

```typescript
const checkoutFlow = await env.FLAGS.getStringValue(
  "checkout-flow",
  "original",
  { userId, country: "US" },
);

switch (checkoutFlow) {
  case "streamlined":
    return handleStreamlined(request);
  case "one-click":
    return handleOneClick(request);
  default:
    return handleOriginal(request);
}
```

### JSON Config Flag

```typescript
interface RateLimitConfig {
  rpm: number;
  burst: number;
}

const limits = await env.FLAGS.getObjectValue<RateLimitConfig>(
  "rate-limits",
  { rpm: 100, burst: 20 },
  { plan: userPlan },
);
```

### Using Details for Observability

```typescript
const details = await env.FLAGS.getBooleanDetails("new-checkout", false, {
  userId: "user-42",
});

console.log(details.value);     // true
console.log(details.variant);   // "on"
console.log(details.reason);    // "TARGETING_MATCH"
console.log(details.errorCode); // undefined (no error)
```

---

## Evaluating Flags with OpenFeature (Workers)

### Binding Passthrough (Recommended)

```typescript
import { OpenFeature } from "@openfeature/server-sdk";
import { FlagshipServerProvider } from "@cloudflare/flagship";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await OpenFeature.setProviderAndWait(
      new FlagshipServerProvider({ binding: env.FLAGS }),
    );
    const client = OpenFeature.getClient();

    const enabled = await client.getBooleanValue("new-checkout", false, {
      targetingKey: "user-42",
      plan: "enterprise",
      country: "US",
    });

    return new Response(enabled ? "New checkout" : "Standard checkout");
  },
};
```

### Migration from Another Provider

Only the provider initialization changes — evaluation call sites stay the same:

```typescript
// ❌ Before (LaunchDarkly)
await OpenFeature.setProviderAndWait(
  new LaunchDarklyProvider({ sdkKey: "..." }),
);

// ✅ After (Flagship)
await OpenFeature.setProviderAndWait(
  new FlagshipServerProvider({ binding: env.FLAGS }),
);

// Evaluation code is unchanged
const enabled = await client.getBooleanValue("my-flag", false, {
  targetingKey: "user-42",
});
```

---

## Managing Flags via REST API

All examples use `api.cloudflare.com`. Set `CLOUDFLARE_ACCOUNT_ID`, `FLAGSHIP_APP_ID`, and `CLOUDFLARE_API_TOKEN` first.

### Create a Boolean Flag

```bash
curl -s -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "new-feature",
    "default_variation": "off",
    "variations": { "on": true, "off": false },
    "rules": [],
    "description": "Enable the new feature",
    "enabled": false
  }' \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags" | jq .
```

### Create a Flag with Internal-Only Targeting

```bash
curl -s -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "beta-feature",
    "default_variation": "off",
    "variations": { "on": true, "off": false },
    "rules": [
      {
        "priority": 1,
        "conditions": [
          { "attribute": "email", "operator": "ends_with", "value": "@cloudflare.com" }
        ],
        "serve_variation": "on"
      }
    ],
    "description": "Beta feature for internal users",
    "enabled": true
  }' \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags" | jq .
```

### Create a JSON Config Flag

```bash
curl -s -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "rate-limits",
    "default_variation": "standard",
    "variations": {
      "standard": { "rpm": 100, "burst": 20 },
      "premium": { "rpm": 1000, "burst": 200 }
    },
    "rules": [
      {
        "priority": 1,
        "conditions": [
          { "attribute": "plan", "operator": "in", "value": ["enterprise", "business"] }
        ],
        "serve_variation": "premium"
      }
    ],
    "description": "Rate limit configuration by plan",
    "enabled": true
  }' \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags" | jq .
```

### Read a Flag

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags/new-feature" | jq .
```

### List All Flags (with pagination)

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags?limit=50" | jq .
```

If `result_info.cursor` is non-null, fetch the next page:

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags?limit=50&cursor=<cursor>" | jq .
```

### Update a Flag (Full Replace)

Updates use PUT with the full `FlagDefinition`. Always GET first, modify, then PUT back.

```bash
# 1. Read current flag
FLAG=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags/new-feature" | jq '.result')

# 2. Modify (e.g., enable the flag)
UPDATED=$(echo "$FLAG" | jq '.enabled = true')

# 3. PUT back
echo "$UPDATED" | curl -s -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags/new-feature" | jq .
```

### Toggle a Flag On

Read-modify-write to set `enabled: true`:

```bash
BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags"

FLAG=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE/new-feature" | jq '.result')
UPDATED=$(echo "$FLAG" | jq '.enabled = true')
echo "$UPDATED" | curl -s -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- "$BASE/new-feature" | jq .
```

### Toggle a Flag Off (Disable)

Same pattern, set `enabled: false`. The flag immediately returns its default variation for all evaluations.

```bash
BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags"

FLAG=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE/new-feature" | jq '.result')
UPDATED=$(echo "$FLAG" | jq '.enabled = false')
echo "$UPDATED" | curl -s -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- "$BASE/new-feature" | jq .
```

### Add a Targeting Rule to an Existing Flag

Append a rule to the existing rules array. Pick a priority that doesn't collide with existing rules.

```bash
BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags"

FLAG=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE/new-feature" | jq '.result')
UPDATED=$(echo "$FLAG" | jq '.rules += [{
  "priority": 2,
  "conditions": [{ "attribute": "plan", "operator": "equals", "value": "enterprise" }],
  "serve_variation": "on"
}]')
echo "$UPDATED" | curl -s -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- "$BASE/new-feature" | jq .
```

### Change Rollout Percentage

Update the rollout percentage on an existing rule (e.g., rule at index 0):

```bash
BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags"

FLAG=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE/gradual-rollout" | jq '.result')
UPDATED=$(echo "$FLAG" | jq '.rules[0].rollout.percentage = 50')
echo "$UPDATED" | curl -s -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- "$BASE/gradual-rollout" | jq .
```

### Change Default Variation

```bash
BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags"

FLAG=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE/new-feature" | jq '.result')
UPDATED=$(echo "$FLAG" | jq '.default_variation = "on"')
echo "$UPDATED" | curl -s -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- "$BASE/new-feature" | jq .
```

### Add a New Variation

```bash
BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags"

FLAG=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE/checkout-flow" | jq '.result')
UPDATED=$(echo "$FLAG" | jq '.variations["treatment-c"] = "minimal"')
echo "$UPDATED" | curl -s -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- "$BASE/checkout-flow" | jq .
```

### Remove a Rule

Remove a rule by filtering on priority:

```bash
BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags"

FLAG=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE/new-feature" | jq '.result')
UPDATED=$(echo "$FLAG" | jq '.rules = [.rules[] | select(.priority != 2)]')
echo "$UPDATED" | curl -s -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- "$BASE/new-feature" | jq .
```

### Delete a Flag

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/flagship/apps/$FLAGSHIP_APP_ID/flags/old-feature" | jq .
```

---

## Targeting Rule Patterns

### Enterprise-Only Access

```json
{
  "priority": 1,
  "conditions": [
    { "attribute": "plan", "operator": "equals", "value": "enterprise" }
  ],
  "serve_variation": "on"
}
```

### Country-Based Targeting with Logical AND/OR

Target enterprise users in the US or Canada:

```json
{
  "priority": 1,
  "conditions": [
    {
      "logical_operator": "AND",
      "clauses": [
        { "attribute": "plan", "operator": "equals", "value": "enterprise" },
        {
          "logical_operator": "OR",
          "clauses": [
            { "attribute": "country", "operator": "equals", "value": "US" },
            { "attribute": "country", "operator": "equals", "value": "CA" }
          ]
        }
      ]
    }
  ],
  "serve_variation": "on"
}
```

### Percentage Rollout

Gradually roll out to 10% of users:

```json
{
  "priority": 1,
  "conditions": [
    { "attribute": "targetingKey", "operator": "not_equals", "value": "" }
  ],
  "serve_variation": "on",
  "rollout": {
    "percentage": 10,
    "attribute": "targetingKey"
  }
}
```

### A/B/n (Multi-Variant) Testing

To split traffic across N variants, create one rule per variant with **cumulative** rollout percentages. Flagship evaluates rules in priority order. If a rule's conditions match but the user misses that rule's rollout percentage, evaluation continues to the next rule. Use the same stable rollout attribute on every rule so each user is compared against the same bucket as the thresholds increase.

The example uses `conditions: []` because the rules are intended to match every context. For sticky user assignment, callers must still pass the configured bucketing attribute (`targetingKey` here); otherwise Flagship uses a random bucket per request.

For example, to split traffic 30% / 40% / 30% across variants A, B, and C:

| Variant | Share | Cumulative threshold |
|---------|-------|----------------------|
| A       | 30%   | 30                   |
| B       | 40%   | 70                   |
| C       | 30%   | 100                  |

```json
"rules": [
  {
    "priority": 1,
    "conditions": [],
    "serve_variation": "variant-a",
    "rollout": { "percentage": 30, "attribute": "targetingKey" }
  },
  {
    "priority": 2,
    "conditions": [],
    "serve_variation": "variant-b",
    "rollout": { "percentage": 70, "attribute": "targetingKey" }
  },
  {
    "priority": 3,
    "conditions": [],
    "serve_variation": "variant-c",
    "rollout": { "percentage": 100, "attribute": "targetingKey" }
  }
]
```

Key points:
- Rules are evaluated lowest-priority-number first. A user who falls into rule 1's 0-30% bucket gets `variant-a` and is not evaluated further.
- Rule 2's 70% threshold covers the next 40% of users (31-70%).
- Rule 3's 100% threshold catches the remaining 30% (71-100%).
- Always set the last rule to `100` so every context with the bucketing attribute is assigned a variant.
- For sticky A/B/n assignment, pass a stable `targetingKey` or configured bucketing attribute. Without it, rollout assignment is random per request, which can be useful for request-level sampling but is usually wrong for user experiments.
- A percentage rollout match reports reason `SPLIT` in evaluation details.

### Progressive Rollout Workflow

1. Create flag with 5% rollout, enable it
2. Monitor metrics
3. Increase to 25% → 50% → 100% by updating the `rollout.percentage`
4. Once at 100%, remove the rule and set `default_variation` to the winning variation
5. Eventually remove the flag and the code branch

---

## Safe Deletion Workflow

1. **Disable** the flag first (`enabled: false`) — confirms nothing depends on it being active
2. **Monitor** for unexpected behavior
3. **Remove** flag evaluation code from your application
4. **Deploy** the code change
5. **Delete** the flag via API
