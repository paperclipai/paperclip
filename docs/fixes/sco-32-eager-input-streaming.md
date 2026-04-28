# SCO-32: OpenCode eager_input_streaming Validation Error

## Problem

OpenCode adapter runs failed immediately with validation errors when using non-Anthropic models (e.g., `opencode/minimax-m2.5-free`):

```
Error from provider: 12 request validation errors: Extra inputs are not permitted, field: 'tools[0].eager_input_streaming', value: True
```

The error occurred when the OpenCode binary included tool definitions with the `eager_input_streaming: True` field in API calls to `opencode.ai/zen/v1/messages`. The OpenCode proxy validates tools and rejects this field for non-Anthropic models.

## Root Cause

OpenCode 1.14.28 and earlier versions included the `eager_input_streaming` field in tool definitions. This field is Claude/Anthropic SDK-specific and valid for Claude API, but the OpenCode proxy routes requests to multiple providers (Minimax, etc.) that do not accept this field.

When an agent had skills/tools available (symlinked to `~/.claude/skills/`), OpenCode would automatically include them as tools in the request, resulting in validation failures for all 12 tools in the error example.

## Solution

**Upgrade OpenCode to version 1.14.29 or later.**

The fix was implemented in the OpenCode binary itself. Version 1.14.29 resolves the issue by handling the `eager_input_streaming` field correctly when routing to non-Anthropic model providers.

### Verification

After upgrade to OpenCode 1.14.29:
- ✅ Agent runs with Minimax (`opencode/minimax-m2.5-free`) complete successfully
- ✅ Tools/skills are still available to agents (44 skills detected in tests)
- ✅ No validation errors from the OpenCode proxy
- ✅ Works with both Claude models and non-Anthropic providers

## Testing

Manual tests confirm the fix:

```bash
# Test with Minimax model and tools available
/home/michal/.opencode/bin/opencode run \
  --model opencode/minimax-m2.5-free \
  --format json < prompt.txt

# Result: No eager_input_streaming errors, response completes successfully
```

## Configuration

No code changes required in Paperclip or the OpenCode adapter. The fix is entirely in the OpenCode binary distribution.

### Update Path

```bash
# Check current version
opencode --version  # 1.14.28 → upgrade needed

# Upgrade to latest
opencode upgrade

# Verify
opencode --version  # 1.14.29+
```

## References

- Issue: SCO-32
- Related: [SCO-30](./sco-30-gemini-session-fix.md) — similar investigation, different provider
- Affected adapter: `@paperclipai/adapter-opencode-local`
- Affected models: All non-Anthropic models via OpenCode proxy
