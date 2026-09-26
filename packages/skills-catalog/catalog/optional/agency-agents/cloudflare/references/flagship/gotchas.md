# Flagship Gotchas & Troubleshooting

## Common Errors

### Flag Always Returns Default Value

**Cause:** Flag is disabled (`enabled: false`), or no targeting rules match, or evaluation context is missing expected attributes.

**Solution:** Check these in order:

1. Is the flag enabled? (`"enabled": true`)
2. Do your targeting rules match the context you're passing?
3. Are you passing the right attributes in the evaluation context?

```typescript
// ❌ BAD — no context, rules can't match
const val = await env.FLAGS.getBooleanValue("my-flag", false);

// ✅ GOOD — pass context attributes that rules reference
const val = await env.FLAGS.getBooleanValue("my-flag", false, {
  userId: "user-42",
  plan: "enterprise",
});
```

### TYPE_MISMATCH Error in Details

**Cause:** Calling a typed method on a flag with a different type (e.g., `getBooleanValue` on a string flag).

**Solution:** Use the method matching the flag's variation type.

```typescript
// ❌ BAD — flag "checkout-flow" has string variations
const val = await env.FLAGS.getBooleanValue("checkout-flow", false);

// ✅ GOOD
const val = await env.FLAGS.getStringValue("checkout-flow", "original");
```

### 409 Conflict on Flag Creation

**Cause:** A flag with that key already exists in the app.

**Solution:** Use a different key, or GET + PUT to update the existing flag.

### Inconsistent Rollout Results

**Cause:** `targetingKey` (or the configured bucketing attribute) is missing from the evaluation context, causing random bucketing on each request.

**Solution:** Always pass a stable identifier:

```typescript
// ❌ BAD — no targetingKey, rollout is random per request
const val = await env.FLAGS.getBooleanValue("gradual-rollout", false);

// ✅ GOOD — stable userId for consistent bucketing
const val = await env.FLAGS.getBooleanValue("gradual-rollout", false, {
  userId: sessionUserId,
});
```

### Update Overwrites Entire Flag

**Cause:** PUT replaces the full `FlagDefinition`. Sending only changed fields deletes the rest.

**Solution:** Always read-modify-write:

```bash
# ❌ BAD — overwrites the entire flag, losing rules/variations
curl -X PUT -d '{"enabled": true}' ...

# ✅ GOOD — GET first, modify, PUT back
FLAG=$(curl -s -H "Authorization: Bearer $TOKEN" "$URL/flags/my-flag" | jq '.result')
UPDATED=$(echo "$FLAG" | jq '.enabled = true')
echo "$UPDATED" | curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @- "$URL/flags/my-flag"
```

### Reading REST Envelope Fields

**Cause:** Management endpoints use Cloudflare v4 envelopes, not raw payloads.

**Solution:** Read `.result` for successful payloads, `.result_info.cursor` for pagination, and `.errors[].message` for errors.

```bash
jq '.result'
jq '.result_info.cursor'
jq '.errors[].message'
```

### Mixing CamelCase and Snake Case in REST Responses

**Cause:** Management API responses are public API JSON and use snake_case. Evaluation responses use OpenFeature-style camelCase.

**Solution:** For management endpoints use `default_variation`, `serve_variation`, `updated_at`, `updated_by`, and changelog `flag_key`. For `/evaluate`, use `flagKey`, `variant`, and `reason`.

### FLAG_NOT_FOUND in Client Provider

**Cause:** Flag key not included in `prefetchFlags` array.

**Solution:** Add the flag key to `prefetchFlags` when initializing `FlagshipClientProvider`.

### Client Provider Token Exposure

**Cause:** The `authToken` passed to `FlagshipClientProvider` is visible in the browser. It can evaluate flags across all apps in the account.

**Solution:** Use a token with minimal permissions (Flagship Evaluate only). Never use a token with write/management permissions in the browser.

---

## Limits

| Limit | Value | Notes |
|-------|-------|-------|
| Flag key length | 1-64 chars | Alphanumeric, hyphens, underscores only |
| Flag key pattern | `/^[a-zA-Z0-9_-]+$/` | — |
| Variation value size | 10KB max | Per variation, serialized |
| Variation name length | 64 chars max | Alphanumeric, hyphens, underscores |
| Description length | 512 chars max | Nullable |
| App name length | 1-64 chars | Alphanumeric, hyphens, underscores |
| Logical nesting depth | 6 levels | AND/OR conditions |
| Mutation rate limit | 60 / 60s | Per account:app |
| Read rate limit | 600 / 60s | Per account:app |
| Rollout percentage | 0-100 | Integer |
| Rule priorities | Unique integers >= 1 | Lower = evaluated first |

---

## Anti-Patterns

### Evaluating Flags in a Tight Loop

Flag evaluation via the binding is fast but not free. Avoid evaluating the same flag repeatedly in a loop — evaluate once and reuse the result.

```typescript
// ❌ BAD
for (const item of items) {
  const enabled = await env.FLAGS.getBooleanValue("my-flag", false, ctx);
  // ...
}

// ✅ GOOD
const enabled = await env.FLAGS.getBooleanValue("my-flag", false, ctx);
for (const item of items) {
  // use `enabled`
}
```

### Using the SDK Inside Workers When Binding Is Available

The binding avoids HTTP overhead entirely. Only use the SDK inside Workers when you specifically need OpenFeature vendor-neutrality.

```typescript
// ❌ Unnecessary HTTP overhead inside a Worker
const provider = new FlagshipServerProvider({
  appId: "...", accountId: "...", authToken: "...",
});

// ✅ Use the binding directly, or pass it to the SDK
const provider = new FlagshipServerProvider({ binding: env.FLAGS });
```

### Partial PUT Updates

The flag update API (PUT) requires the complete `FlagDefinition`. Sending only changed fields silently drops everything else. Always GET first, then modify and PUT back the full object.

### Stale Flag Cleanup

Flags that are disabled and no longer referenced in code should be deleted. Stale flags clutter the dashboard and make it harder to understand which flags are active. Follow the safe deletion workflow in `patterns.md`.

---

## Propagation Behavior

Flag changes propagate globally within seconds. During the brief propagation window, some regions may serve the previous value. After propagation completes, all evaluations return the updated value.

- No Worker redeployment needed for flag changes.
- If the dashboard is temporarily unavailable, evaluation continues using the last propagated configuration.
- Flag changes made via the REST API and dashboard are equivalent — both trigger propagation.
