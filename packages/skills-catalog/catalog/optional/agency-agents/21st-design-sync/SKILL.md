---
name: "21st-design-sync"
description: "Look at the current project's design (its shadcn / Tailwind CSS variables and color tokens) and publish it to the 21st.dev community as a shareable theme, using `21st publish-theme`."
key: "paperclipai/optional/agency-agents/21st-design-sync"
recommendedForRoles:
  - "designer"
tags:
  - "agency-agents"
  - "designer"
  - "21st"
  - "design"
  - "sync"
defaultInstall: false
---
# 21st Design Sync — publish your project's design as a theme

Take the design a project already ships (its light + dark CSS variables) and
publish it to the **public** 21st.dev theme library so anyone can preview,
bookmark, and apply it. Under the hood this is one CLI call:
`21st publish-theme <file.css> --name "…"`.

## Pre-flight (always)

1. **Auth needs a real API key.** `publish-theme` is a management endpoint: it
   accepts a `21st_sk_…` key **only**, not a `21st login` session token. Get one
   at **https://21st.dev/mcp** (or **https://21st.dev/settings/api-keys**) and pass it via
   `--api-key 21st_sk_…` or the `TWENTYFIRST_TOKEN` / `API_KEY_21ST` env var. If
   the user has no key, point them there — don't try to mint one.
2. The CLI is the unified `@21st-dev/cli` (bin `21st`). Use `npx @21st-dev/cli`
   if it isn't installed.
3. **Publishing is public and outward-facing.** A published theme is immediately
   `is_public` in the community library (there is no unlisted/private option for
   themes). Confirm with the user before publishing.

---

## Step 1 — Find the project's design tokens

Locate the file that defines the shadcn/Tailwind theme variables. Check, in order:

- `app/globals.css`, `src/app/globals.css`
- `src/index.css`, `styles/globals.css`, `app/styles/globals.css`

You're looking for a `:root { … }` block of CSS custom properties
(`--background`, `--foreground`, `--card`, `--primary`, `--secondary`,
`--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, the
`--chart-*` / `--sidebar-*` tokens, `--radius`) and a matching `.dark { … }`
block. Values may be `hsl(...)`, `oklch(...)`, hex, or raw channels — keep them
exactly as the project wrote them.

Tailwind v4 projects usually keep the same `:root` / `.dark` blocks plus an
`@theme inline` mapping; you only need the `:root` and `.dark` token values,
not the `@theme` mapping.

## Step 2 — Assemble a valid theme CSS file

The publish endpoint parses `--name: value;` pairs out of a `:root { … }` block
and a `.dark { … }` block, and **requires both to be non-empty**. So the file
you publish must contain both.

- Copy the project's `:root` and `.dark` blocks into a standalone file
  (e.g. `project-theme.css`). Nothing else is required.
- **If the project has only a light `:root` and no `.dark`** (or an empty one),
  generate a dark variant before publishing — don't ship a theme with an empty
  dark mode. Reuse the `add-dark-mode` / `oklch-skill` approach: invert
  lightness while preserving hue/chroma so the dark set stays on-brand. Keep the
  same token names.
- Keep the token names shadcn-standard so the theme previews correctly on the
  card and applies cleanly for others.

Minimal shape:

```css
:root {
  --background: 0 0% 100%;
  --foreground: 240 10% 4%;
  --primary: 240 6% 10%;
  /* …the rest of the project's light tokens… */
  --radius: 0.5rem;
}
.dark {
  --background: 240 10% 4%;
  --foreground: 0 0% 98%;
  --primary: 0 0% 98%;
  /* …the rest of the project's dark tokens… */
}
```

## Step 3 — Name & tag it

- **Name** (required, ≤ 50 chars): infer from the project — the product/brand
  name from `package.json`, the repo, or the site title. Ask the user if it's
  ambiguous.
- **Tags** (optional): a few descriptors that match how people browse themes,
  e.g. `dark`, `minimal`, `neutral`, `vibrant`, `saas`. Pass comma-separated.

## Step 4 — Publish

```bash
21st publish-theme ./project-theme.css \
  --name "Acme" \
  --tags dark,minimal \
  --api-key 21st_sk_…            # or set TWENTYFIRST_TOKEN
```

The command prints the live theme URL (`https://21st.dev/community/themes/<slug>`).
Share it with the user.

## Updating vs re-publishing

- **Each `publish-theme` creates a NEW theme** (there's no upsert-by-slug like
  components have). Running it twice = two themes in the library.
- To change **name/tags/visibility** on an existing theme, edit it in place:
  `21st edit <theme-id> --type theme [--name "…"] [--tags a,b]`.
- To change the **colors**, publish a fresh file and remove the old one:
  `21st delete <theme-id> --type theme --yes` (soft-unpublish, reversible).

## When NOT to use this

- Syncing a component **library** to a Codex Design project → that's the
  built-in `/design-sync` skill, a different destination.
- Publishing a **component** (not a color theme) → use `21st-registry`.
