# First-Party Example Plugins

These example packages are shipped in-repo as reference implementations for the plugin API in `doc/plugins/PLUGIN_SPEC.md`.

Packaging notes shared by all of them:

- They are workspace packages under `packages/plugins/examples/`.
- They publish the plugin contract via `package.json#paperclipPlugin`.
- Their compiled manifest/worker/UI outputs live under `dist/`.

## Included Examples

1. `@paperclipai/plugin-hello-world-example`
Path: `packages/plugins/examples/plugin-hello-world-example`

- Demonstrates the smallest UI plugin: a dashboard widget that renders a "Hello world" message.
- API notes: contributes UI via existing plugin host endpoints only; no plugin-defined HTTP routes.

## Local Install (Dev)

From repo root, build the example package and install it by local path:

```bash
pnpm --filter @paperclipai/plugin-hello-world-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-hello-world-example
```

**Local development notes:**

- **Build first.** The host discovers the compiled manifest and worker through `package.json#paperclipPlugin` (for example `./dist/manifest.js` and `./dist/worker.js`). Run `pnpm build` (or `pnpm --filter <package> build`) in the plugin directory before installing so those files exist. The worker file must call `runWorker(plugin, import.meta.url)` so the process stays alive when run as the entrypoint (see PLUGIN_AUTHORING_GUIDE.md).
- **Reinstall after pulling.** If you installed a plugin by local path before the server stored `package_path`, the plugin may show status **error** (worker not found). Uninstall and install again so the server persists the path and can activate the plugin:
  `pnpm paperclipai plugin uninstall <pluginKey> --force` then
  `pnpm paperclipai plugin install ./packages/plugins/examples/<plugin-dir>`.

---

## Developer Tools & Skills

### `paperclip-create-plugin` (Agent Skill)
Path: `skills/paperclip-create-plugin/`

This is an agent skill designed for AI agents (Claude, Gemini, etc.) to help them autonomously build Paperclip plugins.

- **Workflow:** Guides agents from requirement analysis and scaffolding to implementation and testing.
- **Reference Docs:** Includes local copies of the Plugin SDK API, Manifest schema, and UI component reference.
- **Usage:** Agents can activate this skill using their respective `activate_skill` tool:
  ```
  activate_skill(name: "paperclip-create-plugin")
  ```
- **Integrity Tests:** Automated tests in `cli/src/__tests__/paperclip-create-plugin-skill.test.ts` ensure the skill's documentation remains valid and complete.
