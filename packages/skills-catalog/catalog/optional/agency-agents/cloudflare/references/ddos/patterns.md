# DDoS Protection Patterns

## Allowlist Trusted IPs

```typescript
const config = {
  description: "Allowlist trusted IPs",
  rules: [{
    expression: "ip.src in { 203.0.113.0/24 192.0.2.1 }",
    action: "execute",
    action_parameters: {
      id: managedRulesetId,
      overrides: { sensitivity_level: "eoff" },
    },
  }],
};

await client.accounts.rulesets.phases.entrypoint.update("ddos_l7", {
  account_id: accountId,
  ...config,
});
```

## Route-specific Sensitivity

```typescript
const config = {
  description: "Route-specific protection",
  rules: [
    {
      expression: "not http.request.uri.path matches \"^/api/\"",
      action: "execute",
      action_parameters: {
        id: managedRulesetId,
        overrides: { sensitivity_level: "default", action: "block" },
      },
    },
    {
      expression: "http.request.uri.path matches \"^/api/\"",
      action: "execute",
      action_parameters: {
        id: managedRulesetId,
        overrides: { sensitivity_level: "low", action: "managed_challenge" },
      },
    },
  ],
};
```

## Progressive Enhancement

```typescript
enum ProtectionLevel { MONITORING = "monitoring", LOW = "low", MEDIUM = "medium", HIGH = "high" }

const levelConfig = {
  [ProtectionLevel.MONITORING]: { action: "log", sensitivity: "eoff" },
  [ProtectionLevel.LOW]: { action: "managed_challenge", sensitivity: "low" },
  [ProtectionLevel.MEDIUM]: { action: "managed_challenge", sensitivity: "medium" },
  [ProtectionLevel.HIGH]: { action: "block", sensitivity: "default" },
} as const;

async function setProtectionLevel(zoneId: string, level: ProtectionLevel, rulesetId: string, client: Cloudflare) {
  const settings = levelConfig[level];
  return client.zones.rulesets.phases.entrypoint.update("ddos_l7", {
    zone_id: zoneId,
    rules: [{
      expression: "true",
      action: "execute",
      action_parameters: { id: rulesetId, overrides: { action: settings.action, sensitivity_level: settings.sensitivity } },
    }],
  });
}
```

## Dynamic Response to Attacks

```typescript
interface Env { CLOUDFLARE_API_TOKEN: string; ZONE_ID: string; KV: KVNamespace; }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.url.includes("/attack-detected")) {
      const attackData = await request.json();
      await env.KV.put(`attack:${Date.now()}`, JSON.stringify(attackData), { expirationTtl: 86400 });
      const recentAttacks = await getRecentAttacks(env.KV);
      if (recentAttacks.length > 5) {
        await setProtectionLevel(env.ZONE_ID, ProtectionLevel.HIGH, managedRulesetId, client);
        return new Response("Protection increased");
      }
    }
    return new Response("OK");
  },
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const recentAttacks = await getRecentAttacks(env.KV);
    if (recentAttacks.length === 0) await setProtectionLevel(env.ZONE_ID, ProtectionLevel.MEDIUM, managedRulesetId, client);
  },
};
```

## Multi-rule Tiered Protection (Enterprise Advanced)

```typescript
const config = {
  description: "Multi-tier DDoS protection",
  rules: [
    {
      expression: "not ip.src in $known_ips and not cf.bot_management.score gt 30",
      action: "execute",
      action_parameters: { id: managedRulesetId, overrides: { sensitivity_level: "default", action: "block" } },
    },
    {
      expression: "cf.bot_management.verified_bot",
      action: "execute",
      action_parameters: { id: managedRulesetId, overrides: { sensitivity_level: "medium", action: "managed_challenge" } },
    },
    {
      expression: "ip.src in $trusted_ips",
      action: "execute",
      action_parameters: { id: managedRulesetId, overrides: { sensitivity_level: "low" } },
    },
  ],
};
```

## Defense in Depth

Layered security stack: DDoS + WAF + Rate Limiting + Bot Management.

```typescript
// Layer 1: DDoS (volumetric attacks)
await client.zones.rulesets.phases.entrypoint.update("ddos_l7", {
  zone_id: zoneId,
  rules: [{ expression: "true", action: "execute", action_parameters: { id: ddosRulesetId, overrides: { sensitivity_level: "medium" } } }],
});

// Layer 2: WAF (exploit protection)
await client.zones.rulesets.phases.entrypoint.update("http_request_firewall_managed", {
  zone_id: zoneId,
  rules: [{ expression: "true", action: "execute", action_parameters: { id: wafRulesetId } }],
});

// Layer 3: Rate Limiting (abuse prevention)
await client.zones.rulesets.phases.entrypoint.update("http_ratelimit", {
  zone_id: zoneId,
  rules: [{ expression: "http.request.uri.path eq \"/api/login\"", action: "block", ratelimit: { characteristics: ["ip.src"], period: 60, requests_per_period: 5 } }],
});

// Layer 4: Bot Management (automation detection)
await client.zones.rulesets.phases.entrypoint.update("http_request_sbfm", {
  zone_id: zoneId,
  rules: [{ expression: "cf.bot_management.score lt 30", action: "managed_challenge" }],
});
```

## Cache Strategy for DDoS Mitigation

Exclude query strings from cache key to counter randomized query parameter attacks.

```typescript
const cacheRule = {
  expression: "http.request.uri.path matches \"^/api/\"",
  action: "set_cache_settings",
  action_parameters: {
    cache: true,
    cache_key: { ignore_query_strings_order: true, custom_key: { query_string: { exclude: { all: true } } } },
  },
};

await client.zones.rulesets.phases.entrypoint.update("http_request_cache_settings", { zone_id: zoneId, rules: [cacheRule] });
```

**Rationale**: Attackers randomize query strings (`?random=123456`) to bypass cache. Excluding query params ensures cache hits absorb attack traffic.

See [configuration.md](./configuration.md) for rule structure details.
