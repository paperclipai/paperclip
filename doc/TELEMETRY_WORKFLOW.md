# Telemetry Workflow

Paperclip first-party telemetry is schema-led for stable events and proposal-led for new product instrumentation.

Stable events must be present in `packages/shared/src/telemetry/generated/paperclip-telemetry.ts` before normal client code emits them. Proposed events may be added ahead of schema registration only with an `@ts-expect-error` proposal marker on the `client.track()` event-name argument.

## Proposed Events

A proposed event is a normal `client.track()` call whose event name is not yet in `PaperclipEventName`. The runtime client swallows unregistered first-party event names before queueing, state initialization, or network flush, so proposed events do not leave the process until the generated telemetry schema adopts the event name.

Use this marker shape when possible:

```ts
import type { TelemetryClient } from "./client.js";

export function trackYourFeatureActionPerformed(
  client: TelemetryClient,
  dims: {
    action_source: "toolbar" | "menu" | (string & {});
    item_count: number;
  },
): void {
  client.track(
    // @ts-expect-error -- proposed-telemetry(https://github.com/paperclipai/paperclip/issues/123): measure feature action completion
    "your_feature.action_performed",
    dims,
  );
}
```

The multi-line shape is recommended because TypeScript places the unregistered-name error on the event-name line. When the schema later registers the event, that error disappears and TypeScript raises TS2578 for the now-unused directive, which tells the adopter to remove the marker in the same change that syncs the generated schema.

The suffix format is:

```text
-- proposed-telemetry(<issue>): <rationale>
```

`<issue>` should be a public `https://github.com/paperclipai/paperclip/issues/123` URL. The rationale should be a short product reason for collecting the event. Missing issue or rationale text is tolerated at the call site and flagged by `scripts/extract-proposed-events.mjs`; it is not an OSS CI failure.

These formatting conventions are documentation-only. Do not add repo-wide bans for `@ts-expect-error`, casts, or single-line calls as part of this workflow.

## Extracting Proposals

Run the extractor from the repo root:

```sh
node scripts/extract-proposed-events.mjs --ref $(git rev-parse HEAD)
```

The extractor scans `packages/shared/src/telemetry/events.ts` for `@ts-expect-error` directives attached to `<identifier>.track()` event-name arguments inside telemetry wrapper functions, including function declarations and variable-assigned arrow/function expressions. It emits `proposed-telemetry-extractor.v2` JSON with event names, primitive dimension names/types from the wrapper `dims` parameter type, rationale fields and missing-field flags, plus repo-relative file/line/column provenance.

Extractor provenance is deliberately repo-relative. Absolute paths, `..` segments, Windows drive-letter paths, and backslash-separated paths are rejected so developer host paths cannot enter proposal inventory records.

## Adoption

When a proposed event is approved and registered in the telemetry backend, sync the regenerated telemetry artifact into the OSS repo. The event name is then part of `PaperclipEventName`, so the proposal marker should fail with TS2578. Remove the marker and keep the wrapper payload aligned with the registered dimensions in the same change.

Old clients that do not yet have the synced schema continue to swallow the proposed event. Clients with the synced schema emit it through the normal stable telemetry path.
