---
name: paperclip-create-plugin
description: >
  Create new Paperclip plugins with manifest-first declarations, isolated 
  worker processes, and capability-gated host APIs. Use when you need to 
  scaffold, implement, test, or document a new plugin for Paperclip.
---

# Paperclip Create Plugin Skill

Use this skill when you are asked to build, scaffold, or implement a new plugin for Paperclip.

## Preconditions

You need:

- Node.js and pnpm installed in the development environment
- Access to the Paperclip codebase (for the SDK and local testing)
- Knowledge of the plugin's required capabilities (e.g., `issues.read`, `http.outbound`)

## Core Principles

-   **Manifest-First**: The plugin manifest (`paperclip-plugin.json`) is the authoritative declaration of a plugin's identity, capabilities, and extension points. The host validates this manifest at install time.
-   **Isolation**: Plugins run in separate Node.js worker processes, communicating with the Paperclip host over JSON-RPC. This ensures one plugin's failure doesn't crash the entire instance.
-   **Capability-Gated**: Plugins do not have direct access to the database or internal Paperclip services. All host interactions must go through the typed `PluginContext` SDK and require explicit capability declarations in the manifest.

## Workflow

1.  **Analyze Plugin Requirements**: Determine the categories (`connector`, `workspace`, `automation`, `ui`) and the specific capabilities needed for the plugin to function.

2.  **Scaffold the Plugin**: Use the official scaffolding tool to generate the project structure.

    ```bash
    npx @paperclipai/create-paperclip-plugin my-plugin \
      --template default \
      --category connector \
      --display-name "My Plugin" \
      --description "Brief description" \
      --author "Your Name <email@example.com>"
    ```

    *Note: If you are developing inside the Paperclip monorepo, you can test the local version of the generator using `pnpm --filter @paperclipai/create-paperclip-plugin build` then running the compiled output.*

3.  **Define the Manifest**: Refine `paperclip-plugin.json`. Ensure all required fields are present and `capabilities` accurately reflect the plugin's needs. See `references/manifest-types.md` for the full schema.

4.  **Implement Worker Logic**:
    -   In `src/worker.ts`, use `definePlugin` and `setup(ctx)`.
    -   Register event handlers using `ctx.events.on()`.
    -   Register scheduled jobs using `ctx.jobs.register()`.
    -   Contribute agent tools using `ctx.tools.register()`.
    -   Register data and action handlers for the UI using `ctx.data.register()` and `ctx.actions.register()`.
    -   See `references/api-types.md` for the full SDK surface.

5.  **Implement UI Components (Optional)**:
    -   If the plugin includes UI, implement React components in `src/ui/`.
    -   Use `usePluginData`, `usePluginAction`, and `useHostContext` from `@paperclipai/plugin-sdk/ui`.
    -   Use shared components like `MetricCard`, `StatusBadge`, and `DataTable` for visual consistency.
    -   Declare the components in the `uiSlots` section of the manifest.
    -   See `references/ui-sdk.md` for the UI hook and component reference.

6.  **Test the Plugin**:
    -   Write unit tests using `@paperclipai/plugin-sdk/testing`.
    -   Use the `createTestHarness` to simulate events, jobs, and UI interactions.
    -   Run tests with `pnpm test`.

7.  **Build and Validate**:
    -   Compile the worker to CommonJS (required for the sandbox loader).
    -   Compile the UI to ES modules.
    -   Validate the manifest against the schema.

## Quality Bar

-   **Capability Least Privilege**: Only declare the capabilities absolutely necessary for the plugin to function.
-   **Idempotency**: Ensure event handlers and scheduled jobs are idempotent to handle retries gracefully.
-   **Security**: Never hardcode or log secrets. Use `ctx.secrets.resolve()` with secret references from the configuration.
-   **Error Handling**: Wrap UI components in `<ErrorBoundary>`. Return structured errors (`PluginBridgeError`) from worker handlers.
-   **Performance**: Avoid long-running or blocking work in `setup()`. Use background jobs for heavy processing.
-   **Consistency**: Use the Paperclip design system and shared UI components where possible.

For detailed specifications and guides, read:
- `skills/paperclip-create-plugin/references/PLUGIN_SPEC.md`
- `skills/paperclip-create-plugin/references/PLUGIN_AUTHORING_GUIDE.md`
- `skills/paperclip-create-plugin/references/scaffold-tool.md`
- `skills/paperclip-create-plugin/references/sdk.md`
- `skills/paperclip-create-plugin/references/api-types.md`
- `skills/paperclip-create-plugin/references/manifest-types.md`
- `skills/paperclip-create-plugin/references/constants.md`
- `skills/paperclip-create-plugin/references/ui-sdk.md`
