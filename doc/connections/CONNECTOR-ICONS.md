# Connector icons

Use the shared `AppLogo` component and bundled artwork in `ui/public/brands/apps`.
Keep the existing gray rounded frame, caller size and border, and contained image
padding. Preserve vendor shapes and colors; use a separate dark asset only when
the light artwork is unsuitable on the dark frame. Do not invert or stretch marks.

The public manifest contains only identity, catalog visibility, artwork paths,
and optional aliases. Omit `darkAsset` when both themes use the same file. Keep
matching logo paths in the app definition. Brand-library membership does not
enable a connector. Google People and Workspace Search share the Google mark.

Use reviewed vendor or supplied source files. Keep source research and review
records outside the browser-served manifest. Never add credentials or private
review links to public assets. Render SVGs as images, not inline HTML. The
structural safety check rejects common active SVG features; it is not a general
sanitizer for untrusted uploads.

Before submitting artwork, run:

```sh
node scripts/check-app-brand-assets.mjs
node --test scripts/app-brand-validation.test.mjs
pnpm exec vitest run ui/src/lib/app-brand-assets.test.ts ui/src/pages/apps/AppLogo.brand-assets.test.tsx packages/shared/src/app-definitions.test.ts
```

Run the structural artwork check locally. Review the Storybook canonical icon registry
in light and dark themes at 24–48px, then inspect affected product surfaces. Check
contrast, optical size, native details, and the existing image-error fallback.
