# Pi Hook Survey

Status: investigation note
Date: 2026-04-07

## Why this exists

We were asked to find the hook surfaces exposed by `pi` and `pi-mono`, then decide which ideas transfer cleanly into Paperclip.

This note is based on direct source inspection of:

- `badlogic/pi` default branch and `pi2` branch
- `badlogic/pi-mono` `packages/coding-agent`
- current Paperclip plugin and adapter surfaces in this repo

## Short answer

- Current `pi` does not expose a comparable extension hook API. What it exposes today is a JSON event stream from `pi-agent`.
- `pi-mono` does expose a real extension hook system. It is broad, typed, and intentionally allows mutation of agent/runtime behavior.
- Paperclip should copy only the safe subset:
  - typed event subscriptions
  - read-only run lifecycle events
  - explicit worker lifecycle hooks
  - plugin-to-plugin events
- Paperclip should not copy the dangerous subset:
  - arbitrary mutation hooks on core control-plane decisions
  - project-local plugin loading
  - built-in tool shadowing by name collision

## What `pi` has today

Current `badlogic/pi` is primarily a GPU pod manager plus a lightweight agent runner. It does not expose a `pi.on(...)`-style extension API like `pi-mono`.

The closest thing to hooks is the `pi-agent --json` event stream:

- `session_start`
- `user_message`
- `assistant_start`
- `assistant_message`
- `thinking`
- `tool_call`
- `tool_result`
- `token_usage`
- `error`
- `interrupted`

That makes `pi` useful as an event producer, but not as a host for third-party runtime interception.

## What `pi-mono` has

`pi-mono` exposes a real extension API through `packages/coding-agent/src/core/extensions/types.ts`.

### Extension event hooks

Verified `pi.on(...)` hook names:

- `resources_discover`
- `session_start`
- `session_before_switch`
- `session_before_fork`
- `session_before_compact`
- `session_compact`
- `session_shutdown`
- `session_before_tree`
- `session_tree`
- `context`
- `before_provider_request`
- `before_agent_start`
- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `model_select`
- `tool_call`
- `tool_result`
- `user_bash`
- `input`

### Other extension surfaces

`pi-mono` extensions can also:

- `registerTool(...)`
- `registerCommand(...)`
- `registerShortcut(...)`
- `registerFlag(...)`
- `registerMessageRenderer(...)`
- `registerProvider(...)`
- `unregisterProvider(...)`
- use an inter-extension event bus via `pi.events`

### Important behavior

`pi-mono` hooks are not just observers. Several can actively mutate behavior:

- `before_agent_start` can rewrite the effective system prompt and inject messages
- `context` can replace the message set before an LLM call
- `before_provider_request` can rewrite the serialized provider payload
- `tool_call` can mutate tool inputs and block execution
- `tool_result` can rewrite tool output
- `user_bash` can replace shell execution entirely
- `input` can transform or fully handle user input before normal processing

That is a good fit for a local coding harness. It is not automatically a good fit for a company control plane.

## What Paperclip already has

Paperclip already has several hook-like surfaces, but they are much narrower and safer:

- plugin worker lifecycle hooks such as `setup()` and `onHealth()`
- declared webhook endpoints for plugins
- scheduled jobs
- a typed plugin event bus with filtering and plugin namespacing
- adapter runtime hooks for logs/status/usage in the run pipeline

The plugin event bus is already pointed in the right direction:

- core domain events can be subscribed to
- filters are applied server-side
- plugin-emitted events are namespaced under `plugin.<pluginId>.*`
- plugins do not override core behavior by name collision

## What transfers well to Paperclip

These ideas from `pi-mono` fit Paperclip with little conceptual risk:

### 1. Read-only run lifecycle subscriptions

Paperclip should continue exposing run and transcript events to plugins, for example:

- run started / finished
- tool started / finished
- usage reported
- issue comment created

This matches Paperclip's control-plane posture: observe, react, automate.

### 2. Plugin-to-plugin events

Paperclip already has this. It is worth keeping and extending.

This is the clean replacement for many ad hoc hook chains.

### 3. Explicit worker lifecycle hooks

Paperclip already has `setup()` and `onHealth()`. That is the right shape.

If more lifecycle is needed, it should stay explicit and host-controlled.

### 4. Trusted adapter-level prompt/runtime middleware

Some `pi-mono` ideas do belong in Paperclip, but only inside trusted adapter/runtime code:

- prompt shaping before a run starts
- provider request customization
- tool execution wrappers for local coding adapters

This should be an adapter surface, not a general company plugin surface.

## What should not transfer directly

These `pi-mono` capabilities are a bad fit for Paperclip core:

### 1. Arbitrary mutation hooks on control-plane decisions

Paperclip should not let general plugins rewrite:

- issue checkout semantics
- approval outcomes
- budget enforcement
- assignment rules
- company scoping

Those are core invariants.

### 2. Tool shadowing by name collision

`pi-mono`'s low-friction override model is great for a personal coding harness.

Paperclip should keep plugin tools namespaced and non-shadowing.

### 3. Project-local plugin loading

Paperclip is an operator-controlled control plane. Repo-local plugin auto-loading would make behavior too implicit and too hard to govern.

### 4. UI-session-specific hooks as first-class product surface

Hooks like:

- `session_before_switch`
- `session_before_fork`
- `session_before_tree`
- `model_select`
- `input`
- `user_bash`

are tied to `pi-mono` being an interactive terminal coding harness.

They do not map directly to Paperclip's board-and-issues model.

## Recommended Paperclip direction

If we want a "hooks" story inspired by `pi-mono`, it should split into two layers:

### Layer 1: safe control-plane plugins

Allowed surfaces:

- typed domain event subscriptions
- jobs
- webhooks
- plugin-to-plugin events
- UI slots and bridge actions
- plugin-owned tools and data endpoints

Disallowed:

- mutation of core issue/approval/budget invariants

### Layer 2: trusted runtime middleware

For adapters and other trusted runtime packages only:

- prompt assembly hooks
- provider payload hooks
- tool execution wrappers
- transcript rendering helpers

This is where the best `pi-mono` runtime ideas belong.

## Bottom line

If the question is "what hooks do `pi` and `pi-mono` have?":

- `pi`: JSON output events, not a general extension hook system
- `pi-mono`: a broad extension hook API with 27 named event hooks plus tool/command/provider registration

If the question is "what works for Paperclip too?":

- yes: typed event subscriptions, worker lifecycle hooks, namespaced plugin events, read-only run lifecycle events
- maybe, but trusted-only: prompt/provider/tool middleware around adapter execution
- no: arbitrary mutation hooks on control-plane invariants, project-local plugin loading, tool shadowing
