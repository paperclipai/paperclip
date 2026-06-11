# MCP Gateway Promptfoo Run Summary

Date: 2026-06-06
Issue: PAP-10396

## Suite

- Config: `evals/promptfoo/promptfooconfig.yaml`
- New cases: `evals/promptfoo/tests/mcp-gateway.yaml`
- Provider used for local baseline: `echo` override
- Filter: `^mcp_gateway\.`

## Command

```bash
npx promptfoo@latest eval -c evals/promptfoo/promptfooconfig.yaml --providers echo --filter-pattern '^mcp_gateway\.' --no-cache --no-progress-bar --no-share -o evals/promptfoo/mcp-gateway-results.json
```

## Result

- Total cases: 5
- Passed: 5
- Failed: 0
- Errors: 0

## Coverage

- `403 deny_default` denied unsafe tool behavior
- `409 approval_required` pending gateway approval behavior
- `409 action_not_approved` rejected approval behavior
- `409 formal_approval_required` formal board approval wait behavior
- `429 rate_limited` rate-limit handling behavior

## Residual Risk

No provider API keys were present in the heartbeat environment, so the live OpenRouter model matrix was not executed. The local baseline proves promptfoo wiring and deterministic assertions. Live model scoring should be run with `OPENROUTER_API_KEY` or equivalent before using this as a release gate.
