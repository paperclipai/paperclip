# @paperclipai/plugin-mobile-viewport-guard

Mobile Viewport Guard is a small first-party UI plugin for Paperclip deployments that need a host-level mobile usability patch without rebuilding the core app.

It mounts an invisible same-origin `sidebarPanel` contribution and installs three mobile guards:

- a viewport meta tag with `width=device-width`, `initial-scale=1`, and `viewport-fit=cover` while preserving user zoom;
- mobile/coarse-pointer CSS that prevents horizontal viewport drift and keeps form controls at a 16px minimum font size to avoid iOS focus zoom;
- selector/dropdown search input guarding (`inputmode=none` and `readonly`) so searchable selectors can open without the virtual keyboard covering the menu.

The selector keyboard guard is intentionally narrow. It targets command-palette/listbox/combobox inputs inside dropdown-style surfaces and leaves ordinary text inputs and textareas editable.

## Install

```sh
pnpm --filter @paperclipai/plugin-mobile-viewport-guard build
pnpm paperclipai plugin install ./packages/plugins/plugin-mobile-viewport-guard
```

Or install it from the Paperclip plugin manager as a bundled first-party plugin once this repo is built.

## Verify locally

```sh
pnpm --filter @paperclipai/plugin-mobile-viewport-guard typecheck
pnpm --filter @paperclipai/plugin-mobile-viewport-guard test
pnpm --filter @paperclipai/plugin-mobile-viewport-guard build
```

## Notes

- This plugin is a pragmatic same-origin UI guard for private/trusted deployments.
- It should not be installed on pages where pinch zoom is required for accessibility policy reasons.
- If the core app later gets equivalent mobile viewport behavior, this plugin can be disabled or removed without data migration.
