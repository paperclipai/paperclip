# Hermes Gateway Adapter Compatibility Shim

`@paperclipai/adapter-hermes-gateway` is a deprecated compatibility shim.

Use `@paperclipai/hermes-paperclip-adapter/gateway` for the Hermes Gateway
adapter. The adapter type remains `hermes_gateway`; only package ownership
changed.

The shim preserves the legacy exports for one release:

- `.`
- `./server`
- `./ui`
- `./cli`
- `./ui-parser`
