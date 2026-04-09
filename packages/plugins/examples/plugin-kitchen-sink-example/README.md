# @paperclipai/plugin-kitchen-sink-example

Operations Console is a first-party internal plugin built on top of the former kitchen-sink package.

It now serves as a practical operations cockpit for Paperclip operators:

- operational page route
- dashboard widget and sidebar surfaces
- project and issue operational views
- comment capture surfaces
- diagnostics, state, metrics, activity, and streams
- issue intake through actions, tools, and webhooks
- workspace notes and curated local diagnostics

The package name stays the same for compatibility with existing installs, but the UI and worker behavior now target real internal operations instead of generic demo-only flows.

## Install

```sh
pnpm --filter @paperclipai/plugin-kitchen-sink-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-kitchen-sink-example
```

Or install it from the Paperclip plugin manager as a bundled example once this repo is built.

## Notes

- Local workspace access and process diagnostics are trusted-only and default to safe, curated commands.
- The webhook intake can create a follow-up issue when the payload includes `companyId` and `title`, with optional `projectId` and `description`.
- The settings page controls which operational surfaces are visible and whether local diagnostics are enabled.

## Maintainer

- Instagram: @monrars
- Site: goldneuron.io
- GitHub: @monrars1995

## License

Distributed under the repository MIT license. See `/Users/monrars/paperclip/LICENSE`.
