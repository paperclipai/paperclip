# DDoS API

## Endpoints

### HTTP DDoS (L7)

```typescript
// Zone-level
PUT /zones/{zoneId}/rulesets/phases/ddos_l7/entrypoint
GET /zones/{zoneId}/rulesets/phases/ddos_l7/entrypoint

// Account-level (Enterprise Advanced)
PUT /accounts/{accountId}/rulesets/phases/ddos_l7/entrypoint
GET /accounts/{accountId}/rulesets/phases/ddos_l7/entrypoint
```

### Network DDoS (L3/4)

```typescript
// Account-level only
PUT /accounts/{accountId}/rulesets/phases/ddos_l4/entrypoint
GET /accounts/{accountId}/rulesets/phases/ddos_l4/entrypoint
```

## TypeScript SDK

**SDK Version**: Requires `cloudflare` >= 3.0.0 for ruleset phase methods.

```typescript
import Cloudflare from "cloudflare";

const client = new Cloudflare({ apiToken: process.env.CLOUDFLARE_API_TOKEN });

// STEP 1: Discover managed ruleset ID (required for overrides)
const allRulesets = await client.rulesets.list({ zone_id: zoneId });
const ddosRuleset = allRulesets.result.find(
  (r) => r.kind === "managed" && r.phase === "ddos_l7"
);
if (!ddosRuleset) throw new Error("DDoS managed ruleset not found");
const managedRulesetId = ddosRuleset.id;

// STEP 2: Get current HTTP DDoS configuration
const entrypointRuleset = await client.zones.rulesets.phases.entrypoint.get("ddos_l7", {
  zone_id: zoneId,
});

// STEP 3: Update HTTP DDoS ruleset with overrides
await client.zones.rulesets.phases.entrypoint.update("ddos_l7", {
  zone_id: zoneId,
  rules: [
    {
      action: "execute",
      expression: "true",
      action_parameters: {
        id: managedRulesetId, // From discovery step
        overrides: {
          sensitivity_level: "medium",
          action: "managed_challenge",
        },
      },
    },
  ],
});

// Network DDoS (account level, L3/4)
const l4Rulesets = await client.rulesets.list({ account_id: accountId });
const l4DdosRuleset = l4Rulesets.result.find(
  (r) => r.kind === "managed" && r.phase === "ddos_l4"
);
const l4Ruleset = await client.accounts.rulesets.phases.entrypoint.get("ddos_l4", {
  account_id: accountId,
});
```

## Alert Configuration

```typescript
interface DDoSAlertConfig {
  name: string;
  enabled: boolean;
  alert_type: "http_ddos_attack_alert" | "layer_3_4_ddos_attack_alert" 
    | "advanced_http_ddos_attack_alert" | "advanced_layer_3_4_ddos_attack_alert";
  filters?: {
    zones?: string[];
    hostnames?: string[];
    requests_per_second?: number;
    packets_per_second?: number;
    megabits_per_second?: number;
    ip_prefixes?: string[]; // CIDR
    ip_addresses?: string[];
    protocols?: string[];
  };
  mechanisms: {
    email?: Array<{ id: string }>;
    webhooks?: Array<{ id: string }>;
    pagerduty?: Array<{ id: string }>;
  };
}

// Create alert
await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/alerting/v3/policies`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(alertConfig),
  }
);
```

## Typed Override Examples

```typescript
// Override by category
interface CategoryOverride {
  action: "execute";
  expression: string;
  action_parameters: {
    id: string;
    overrides: {
      categories?: Array<{
        category: "http-flood" | "http-anomaly" | "udp-flood" | "syn-flood";
        sensitivity_level?: "default" | "medium" | "low" | "eoff";
        action?: "block" | "managed_challenge" | "challenge" | "log";
      }>;
    };
  };
}

// Override by rule ID
interface RuleOverride {
  action: "execute";
  expression: string;
  action_parameters: {
    id: string;
    overrides: {
      rules?: Array<{
        id: string;
        action?: "block" | "managed_challenge" | "challenge" | "log";
        sensitivity_level?: "default" | "medium" | "low" | "eoff";
      }>;
    };
  };
}

// Example: Override specific adaptive rule
const adaptiveOverride: RuleOverride = {
  action: "execute",
  expression: "true",
  action_parameters: {
    id: managedRulesetId,
    overrides: {
      rules: [
        { id: "...adaptive-origins-rule-id...", sensitivity_level: "low" },
      ],
    },
  },
};
```

See [patterns.md](./patterns.md) for complete implementation patterns.
