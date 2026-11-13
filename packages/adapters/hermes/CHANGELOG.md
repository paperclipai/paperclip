# @paperclipai/hermes-paperclip-adapter

## Unreleased

### Patch Changes

- Honour an explicit provider namespace in a Hermes model id. `openrouter/...` model ids now resolve to the `openrouter` provider instead of being routed to another vendor's base URL (for example `openrouter/gpt-4.1-mini` no longer resolves to `openai-codex`, and `openrouter/claude-3.5-sonnet` no longer resolves to `anthropic`), and a model id whose namespace disagrees with the configured provider or base URL is rejected when the agent config is saved.
