# @paperclipai/plugin-kitchen-sink-example

Kitchen Sink is the first-party reference plugin that demonstrates nearly the full currently implemented Paperclip plugin surface in one package.

It is intentionally broad:

- full plugin page
- dashboard widget
- project and issue surfaces
- comment surfaces
- sidebar surfaces
- settings page
- worker bridge data/actions
- events, jobs, webhooks, tools, streams
- state, entities, assets, metrics, activity
- local workspace and process demos

This plugin is for local development, contributor onboarding, and runtime regression testing. It is not meant as a production plugin template to ship unchanged.

## Install

```sh
pnpm --filter @paperclipai/plugin-kitchen-sink-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-kitchen-sink-example
```

Or install it from the Paperclip plugin manager as a bundled example once this repo is built.

## Notes

- Local workspace and process demos are trusted-only and default to safe, curated commands.
- The plugin settings page lets you toggle optional demo surfaces and local runtime behavior.
- Some SDK-defined host surfaces still depend on the Paperclip host wiring them visibly; this package aims to exercise the currently mounted ones and make the rest obvious.
