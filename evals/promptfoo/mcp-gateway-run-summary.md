# MCP Gateway Promptfoo Run Summary

Date: 2026-06-16
Issue: PAP-11188

## Suite

- Config: `evals/promptfoo/promptfooconfig.yaml`
- Cases: `evals/promptfoo/tests/mcp-gateway.yaml`
- Provider used for local baseline: `echo` override
- Filter: `^mcp_gateway\.`

## Command

```bash
npx promptfoo@0.103.3 eval -c evals/promptfoo/promptfooconfig.yaml --providers echo --filter-pattern '^mcp_gateway\.' --no-cache --no-progress-bar --no-write -o evals/promptfoo/mcp-gateway-results.json
```

Config validation:

```bash
npx promptfoo@latest validate -c evals/promptfoo/promptfooconfig.yaml
```

## Result

- Total cases: 12
- Passed: 12
- Failed: 0
- Errors: 0

## Coverage

- `allow` / `profile_allows_tool` read-only success behavior
- `403 deny_default` denied unsafe tool behavior
- `409 approval_required` pending gateway approval behavior
- `409 action_not_approved` rejected approval behavior
- `409 formal_approval_required` formal board approval wait behavior
- `429 rate_limited` rate-limit handling behavior
- `422 remote_http_missing_secret` credential repair without secret leakage
- `401 session_revoked` stale gateway-token handling
- remote HTTP header forwarding and redacted credential audit evidence
- exact named/on-demand gateway target selection
- elicitation-required human input wait path
- `409 approved_tool_target_changed` stale approval / target drift behavior

## Residual Risk

No provider API keys were present in the heartbeat environment, so the live OpenRouter model matrix was not executed. The local baseline proves promptfoo wiring and deterministic assertions. Live model scoring should be run with `OPENROUTER_API_KEY` or equivalent before using this as a release gate.
