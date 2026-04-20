---
name: paperclip-create-plugin
description: >
  Create new Paperclip plugins with the current alpha SDK/runtime. Use when
  scaffolding a plugin package, adding a new example plugin, or updating plugin
  authoring docs. Covers the supported worker/UI surface, route conventions,
  scaffold flow, and verification steps.
---

# Create a Paperclip Plugin

Use this skill when the task is to create, scaffold, or document a Paperclip plugin.

## 1. Ground rules

Read these first when needed:

1. `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`
2. `packages/plugins/sdk/README.md`
3. `doc/plugins/PLUGIN_SPEC.md` only for future-looking context

Current runtime assumptions:

- plugin workers are trusted code
- plugin UI is trusted same-origin host code
- worker APIs are capability-gated
- plugin UI is not sandboxed by manifest capabilities
- no host-provided shared plugin UI component kit yet
- `ctx.assets` is not supported in the current runtime

## 2. Preferred workflow

Use the scaffold package instead of hand-writing the boilerplate:

```bash
pnpm --filter @paperclipai/create-paperclip-plugin build
node packages/plugins/create-paperclip-plugin/dist/index.js <npm-package-name> --output <target-dir>
```

For a plugin that lives outside the Paperclip repo, pass `--sdk-path` and let the scaffold snapshot the local SDK/shared packages into `.paperclip-sdk/`:

```bash
pnpm --filter @paperclipai/create-paperclip-plugin build
node packages/plugins/create-paperclip-plugin/dist/index.js @acme/plugin-name \
  --output /absolute/path/to/plugin-repos \
  --sdk-path /absolute/path/to/paperclip/packages/plugins/sdk
```

Recommended target inside this repo:

- `packages/plugins/examples/` for example plugins
- another `packages/plugins/<name>/` folder if it is becoming a real package

## 3. After scaffolding

Check and adjust:

- `src/manifest.ts`
- `src/worker.ts`
- `src/ui/index.tsx`
- `tests/plugin.spec.ts`
- `package.json`

Make sure the plugin:

- declares only supported capabilities
- does not use `ctx.assets`
- does not import host UI component stubs
- keeps UI self-contained
- uses `routePath` only on `page` slots
- is installed into Paperclip from an absolute local path during development

## 4. If the plugin should appear in the app

For bundled example/discoverable behavior, update the relevant host wiring:

- bundled example list in `server/src/routes/plugins.ts`
- any docs that list in-repo examples

Only do this if the user wants the plugin surfaced as a bundled example.

## 5. Verification

Always run:

```bash
pnpm --filter <plugin-package> typecheck
pnpm --filter <plugin-package> test
pnpm --filter <plugin-package> build
```

If you changed SDK/host/plugin runtime code too, also run broader repo checks as appropriate.

## 6. Documentation expectations

When authoring or updating plugin docs:

- distinguish current implementation from future spec ideas
- be explicit about the trusted-code model
- do not promise host UI components or asset APIs
- prefer npm-package deployment guidance over repo-local workflows for production
