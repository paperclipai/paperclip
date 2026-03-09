# Scheduled Job Example Plugin

Reference plugin demonstrating **scheduled (recurring) tasks** with the Paperclip plugin SDK.

## What it does

- Declares two jobs in the manifest with cron schedules.
- Registers handlers in the worker with `ctx.jobs.register(jobKey, fn)`.
- **Heartbeat:** runs every 5 minutes (`*/5 * * * *`); writes instance state and a metric.
- **Daily summary:** runs once per day at 2:00 AM (`0 2 * * *`); writes instance state and a metric.

Runs can be triggered by the **schedule**, **manually** from the Paperclip UI/API, or as a **retry**. The handler receives `PluginJobContext` (`jobKey`, `runId`, `trigger`, `scheduledAt`).

## Docs

- [Plugin SDK README](../../sdk/README.md) — **Scheduled (recurring) jobs** section
- [PLUGIN_SPEC.md](../../../../doc/plugins/PLUGIN_SPEC.md) §17 — Scheduled Jobs
- [PLUGIN_AUTHORING_GUIDE.md](../../../../doc/plugins/PLUGIN_AUTHORING_GUIDE.md) — Scheduled Jobs

## Build

```bash
pnpm install
pnpm build
```

## Capabilities used

- `jobs.schedule` — declare and run scheduled jobs
- `plugin.state.read` / `plugin.state.write` — store last-run timestamps
- `metrics.write` — record run counts
