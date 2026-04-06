# @paperclipai/ui

Published static assets for the Paperclip board UI.

## What gets published

The npm package contains the production build under `dist/`. It does not ship the UI source tree or workspace-only dependencies.

## Typical use

Install the package, then serve or copy the built files from `node_modules/@paperclipai/ui/dist`.

## Accessibility note

When using Radix `Dialog`, every `DialogContent` must include a `DialogTitle` (visible or screen-reader-only, for example with `className="sr-only"`). This avoids runtime accessibility warnings and keeps modal semantics correct for assistive technologies.
