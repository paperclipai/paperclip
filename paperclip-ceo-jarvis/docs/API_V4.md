# API v4 — Autonomy + Enchantments

All endpoints except `/health` require the `X-Jarvis-Key` header.

## Autonomy

### `GET /autonomy/policies`
Returns active/inactive authority policies.

### `POST /autonomy/policies`
Creates a policy.

```json
{
  "name": "Production deployment requires approval",
  "category": "engineering",
  "trigger_terms": ["deploy", "production"],
  "risk_level": "high",
  "decision": "approval_required",
  "requires_approval": true,
  "rationale": "Production actions affect users."
}
```

### `POST /autonomy/evaluate`
Evaluates an action.

```json
{
  "action": "Publish the launch announcement and deploy to production",
  "impact_area": "operations",
  "intended_actor": "jarvis"
}
```

Returns risk level, decision, matched policies, required controls, and next step.

### `POST /autonomy/watch-cycle`
Runs proactive watch rules and generates insights, alerts, and notifications.

### `GET /autonomy/insights`
Returns open system insights.

## Enchantments

### `GET /enchantments/backlog`
Returns the full structured upgrade backlog. Optional query parameters:

- `category`
- `status`

### `GET /enchantments/brainstorm`
Returns the feature matrix grouped by category.

### `POST /enchantments/plan`
Builds an implementation plan.

```json
{
  "focus_categories": ["safety", "memory", "cognitive", "dashboard"],
  "horizon_days": 60,
  "capacity_level": "normal",
  "include_high_risk": false
}
```

### `PUT /enchantments/features/{feature_id}/status`
Updates a feature status. If set to `planned` or `building`, Jarvis creates an implementation task.

```json
{
  "status": "planned",
  "note": "Start in the next sprint."
}
```

### `GET /enchantments/audit`
Runs the v4 maturity audit and returns tier scores, gaps, and next-best upgrades.
