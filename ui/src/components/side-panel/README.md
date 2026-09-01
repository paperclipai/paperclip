# Portable side panel

The components exported by `@/components/side-panel` are controlled, domain-free navigation primitives. They do not import task data, APIs, routing, feature flags, or persistence.

## Composition boundary

- `SidePanelFrame` renders docked, sheet, or embedded chrome and applies the selected content layout.
- `SidePanelTabs` and `SidePanelTab` render projected visual tab data and own keyboard navigation, close focus recovery, overflow visibility, and pointer/keyboard reordering.
- `SidePanelLauncher` renders caller-provided sections from the same model as either a plus-button popover or the empty panel body.
- `useSidePanelTabs<TPayload>` owns serializable open/select/close/reorder/reset state. Its optional `onStateChange` callback is the persistence boundary; it never reads storage itself.
- The host adapter owns payload validation, data queries, URL synchronization, content rendering, and persistence scope.

Never put React nodes or fetched content in a persisted `SidePanelTabRecord`. Project icons and live status into `SidePanelTabItem` at render time.

## Registering another page

1. Define a serializable payload union for that page, such as `details | activity | history`.
2. Build stable `SidePanelTabRecord<PagePayload>` descriptors and initialize `useSidePanelTabs` with validated state.
3. Project descriptors into `SidePanelTabItem` values for the tab strip.
4. Render active content in the page adapter by switching on `payload.kind`.
5. Supply the same launcher sections to the plus popover and empty panel.
6. If state is persisted, version and scope it in the adapter and pass writes through `onStateChange`.

## Accessibility and review

The tab strip uses the tabs pattern with roving focus, Arrow/Home/End navigation, named close actions, middle-click close, and live reorder/close announcements. Closing the active tab chooses the right neighbor, then the left; closing the final tab sends focus to the launcher. Reduced-motion preferences disable component transitions and smooth overflow scrolling.

Review `Navigation/Side Panel` in Storybook before changing production adapters. Compare light/dark, minimum/default/wide/maximized, mobile, overflow, empty, launcher, unavailable-resource, and task-composition stories. Tune spacing, radius, contrast, icon size, and motion centrally through the side-panel tokens in `ui/src/index.css`.
