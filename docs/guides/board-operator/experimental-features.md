---
title: Experimental Features
summary: What Paperclip experimental features mean for board operators
---

Experimental features are opt-in and are provided without compatibility guarantees. They may break, change, or be removed at any time. Use them at your own risk.

## What "experimental" means

When a feature is marked experimental, Paperclip is still evaluating the product shape and implementation details.

- The feature is not part of the stable operator contract yet.
- UI, API, CLI, behavior, and stored configuration may change as the feature evolves.
- Paperclip does not promise compatibility, rollback, migration, or long-term support for experimental features.

If you need stable behavior for an important workflow, do not rely on an experimental feature.

## Where you enable them

Board operators enable or disable experiments from **Instance Settings > Experimental** in the app.

The CLI exposes the same surface:

```sh
pnpm paperclipai instance settings:experimental
npx paperclipai instance settings:experimental:update --payload-json '{...}'
```

Those commands change the same opt-in settings that the UI manages.

## Chat connectors

**Chat connectors** is off by default. Enable it to connect a dedicated
Slack, GitHub, Microsoft Teams, Telegram, or Discord bot to one Paperclip
agent. The experiment shows chat setup, connection management, agent channels,
and external task controls.

When it is off, existing production tool connectors remain available. For
example, GitHub opens its normal tool connection flow without asking you to
choose between chat and tools.

This setting controls visibility. Turning it off does not disconnect an
existing bot or stop its messages. To stop a connection, pause it from its
chat connection settings before turning off the experiment.

## When to use them

Experimental features are best used when you are:

- evaluating a new capability before wider rollout
- testing a non-critical workflow
- comfortable with behavior changes between releases
- prepared to stop using the feature if it changes or disappears

## Operator expectations

Before enabling an experimental feature:

- decide whether the workflow can tolerate breakage or churn
- avoid making the feature a dependency for stable production processes
- keep the scope small until you understand how the feature behaves in your company
- watch release notes and docs for changes to the feature contract

## Related references

- See [Status Cards](/guides/board-operator/status-cards) for the watched-query summary experiment, refresh policies, and cost model.
- See the CLI caveat in [Control-Plane Commands](/cli/control-plane-commands).
- See the repo CLI reference in [`doc/CLI.md`](https://github.com/paperclipai/paperclip/blob/master/doc/CLI.md) when working from the repository.
