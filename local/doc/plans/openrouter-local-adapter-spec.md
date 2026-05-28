# Mission: Create `openrouter-local` Adapter

## Objective

You are an expert in the operation and codebase of [Paperclip](https://github.com/paperclip-ui/paperclip/) and experienced in test driven engineering of its technologies.

Create a new Paperclip agent adapter, `openrouter-local`, that provides a first-class, tool-aware execution environment for agents using OpenRouter-compatible models. This adapter will succeed the current `openrouter-external` smoke-test implementation. `openrouter-external` served to prove connectivity to OpenRouter but was non-viable for agent deployment because Paperclip turns appear to require tool calling for even hello-world level capability.

Start by creating a new branch called `feat/openrouter-local-adapter` based on `feat/import-openrouter-adapter`.

The end goal is an adapter we can submit as a PR to OpenRouter to get it included in the list of supported adapters from [OpenRouter Cloud Agents](https://openrouter.ai/docs/cloud-agents). We also need to use it in production in the meantime so it must comport with all paperclip repo tooling requirements, standards and conventions.

## MVP Requirements

1. **Full Tool Support**: Implementation of an OpenAI-compatible tool-calling loop (function calling) that maps Paperclip Runtime Skills (`read_file`, `run_command`, etc.) to the LLM.
2. **Instruction Bundles**: Native support for `AGENTS.md` and `HEARTBEAT.md` files from the agent's workspace.
3. **Local Workspace Resolution**: Correct handling of `cwd` and repository-backed workspaces (OrbStack/Docker compatible).
4. **OpenRouter Optimizations**: Proper handling of OpenRouter-specific usage fields and provider headers.

## Gap Analysis: `openrouter-external`

The current `openrouter-external` implementation (at `packages/adapters/openrouter-external`) is **Chat Only**:

- It lacks a tool-calling loop in `execute.ts`.
- It does not support function calling, leading to "no live execution path" failures.
- It is a minimal "smoke test" wrapper that needs to be refactored into a standard Paperclip adapter structure.

The first implementation step is a class-level analysis of the `claude-local` and `codex-local` adapters, and relevant files in `packages/adapters/`, to produce a detailed, actionable implementation plan.

## Code Reuse

- **Structure**: Use `packages/adapters/claude-local` or `codex-local` as the architectural template for workspace management and tool loops.
- **Client Logic**: Reuse the OpenAI SDK integration from `packages/adapters/openrouter-external`.

## Deliverables

1. **Specification**: A detailed document in `doc/experimental/` following Paperclip's standards.
2. **Implementation**: A new package `packages/adapters/openrouter-local`.
3. **Test Harness**: A Vitest suite verifying tool-calling and instruction materialization.

## Done when

1. All tests in the test harness pass and the adapter is used to successfully execute an agent in a runtime instance of paperclip.
2. Documentation is completed and accurate.
3. A pull request is prepared and ready to submit.

## Operational

Be mindful of token budget; ensure enough quota remains to complete a given turn. If about to run out, do not begin a non-atomic operation; instead, generate a continuation prompt for a subsequent agent.
