---
name: "21st-registry"
description: "Publish your own work to 21st.dev and manage it from the terminal with the `21st` CLI (`@21st-dev/cli`): publish a React component to a team library, publish a CSS theme or a template listing, edit / unpublish / delete your published items, list and reopen existing component work, and..."
key: "paperclipai/optional/agency-agents/21st-registry"
recommendedForRoles:
  - "designer"
tags:
  - "agency-agents"
  - "designer"
  - "21st"
  - "registry"
defaultInstall: false
---
# Publish & manage on the 21st registry

Publish components, themes and templates to 21st.dev, and manage what you've
already published, all through the unified `21st` CLI (`@21st-dev/cli`).

## Pre-flight (always)

1. **Authenticate before publishing.** Component publishing, inventory,
   checkout, metadata editing, and unpublishing accept either a `21st login`
   session or a `21st_sk_…` API key. Theme/template commands still require a
   real API key from **https://21st.dev/settings/api-keys**, passed via
   `--api-key`, `TWENTYFIRST_TOKEN`, or `API_KEY_21ST`.
2. The CLI is the unified `@21st-dev/cli` (bin `21st`). Don't reinvent — use it.
3. **Search before publishing** (`21st search "<query>"`) so you don't add a
   duplicate to the library.

---

## Find existing components and drafts

Start here when the user asks to continue or edit old component work:

```bash
21st components
21st components --status draft --scope personal --json
21st open component:123
21st open draft:<uuid> --no-open
```

`21st components` drains both independently paginated collections by default,
so an unfiltered run returns every accessible personal or Team component and
every owned draft. Narrow it with `--status all|draft|published|private` or
`--scope all|personal|team:<uuid>`. Keep the returned stable
`component:<id>` or `draft:<uuid>` reference; do not substitute a slug.

`21st open draft:<uuid>` resumes an editable Studio draft. `21st open
component:<id>` creates or resumes a server-owned CLI Review revision from the
retained published component code and demos. The live component stays
unchanged until that revision is published. Fresh covers are required, while
optional video generation runs best-effort in the background. `--no-open`
creates or resumes the workspace and prints its URL without launching a
browser.

Use a local file when the source is already changed:

```bash
21st publish ./Component.tsx \
  --component component:123 \
  --description "What changed"
```

Never replace the stable ref with a same-slug guess. Only the original
component author can check out code. A Team manager can still edit or unpublish
a teammate's component metadata by stable ref.

Checkout fails closed when retained source, dependencies, style, support files,
or the default demo cannot be reproduced safely. Use the local source command
above instead of weakening the checks or claiming code access.

A login session can inventory personal work and Teams the user can manage. A
personal key is personal-only, while a Team key is restricted to that Team.
New CLI Review drafts persist their authenticated personal or Team/library
scope. Legacy proof-backed CLI drafts are recovered into the matching
authenticated scope. An older unsigned draft whose scope cannot be proven may
need to be recreated.

---

## Publish a component

The positional file path triggers auto-detection — name from the exported
component, slug from the filename, tags from imports, and a demo that is
auto-found or synthesised. For a new slug or an owned revision, the command
validates dependencies, installs and builds the component, creates a Studio
draft, opens its dedicated **CLI Review**, and waits. The review sidebar shows
the exact **Demos (N)** count and keeps the selected demo beside its live
preview. Studio generates the required cover first, then attempts an optional
video in the background. An owned revision stays pending until it completes the
same CLI Review and is published.

```bash
21st publish ./path/to/Component.tsx \
  --to default \
  --description "1-2 sentences: what it does and when to use it"
```

### Decide access — default to Published

| User says…                                                 | Flag                                   |
| ---------------------------------------------------------- | -------------------------------------- |
| "publish", "share a link", default for any unqualified ask | _(none — defaults to `published`)_     |
| "submit for the catalog", "get featured"                   | Publish, then run `21st submit <slug>` |
| "restrict to the team library", "keep it internal"         | `--private`                            |

Publishing controls access only. Catalog featuring is always a separate review
action, so publishing never silently submits the component.

### Flag reference

| Flag                                  | When to use                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--description "…"`                   | **Required**, 10+ chars: what it does + when to use it. Never fabricate — read the code or ask the user.                                                     |
| `--name`, `--slug`, `--tags a,b`      | Override auto-detected name / URL slug / 1-5 tags.                                                                                                           |
| `--demo <file>`                       | Demo file. Auto-found (`{Comp}.demo.tsx`, `demos/{slug}.tsx`, `demos/default.tsx`) or a trivial one is synthesised. A real demo gives a much better preview. |
| `--preview <img>`                     | Stage an initial cover image. It replaces the generated cover but does not bypass Studio review or the required-cover gate.                                  |
| `--no-open`                           | Print the Studio draft URL without opening it. The draft remains available for later review.                                                                 |
| `--registry ui\|hooks\|blocks\|icons` | Target sub-registry (default `ui`).                                                                                                                          |
| `--to <library-slug>`                 | Target team library (e.g. `--to default`). Omit for the team's default.                                                                                      |
| `--registry-dep <ref>`                | Not supported by CLI Review yet. Remove it before creating a new component or owned revision.                                                                |
| `--visibility published\|private`     | Access (default `published`).                                                                                                                                |

For a new slug or owned revision, the command prints the Studio draft URL and
reports the component URL and install line only after Studio publishes it.
Pressing <kbd>Ctrl</kbd>+<kbd>C</kbd> stops the CLI from waiting but keeps the
draft.

### Required agent review for a new slug or owned revision

The build gate catches undeclared packages, install failures, unresolved
imports, and compile errors. It cannot prove that the rendered UI, interactions,
or colors are visually correct. Before allowing the final publish:

1. Make the component and demo self-contained. Declare every imported npm
   package in the nearest `package.json`; do not leave unresolved local or alias
   imports. Confirm the CLI build succeeds before continuing. The current CLI
   command sends one component file and one demo; additional local files and
   `21st.json` are not accepted yet.
2. Use portable Tailwind semantic tokens such as `bg-primary`,
   `text-primary-foreground`, `bg-background`, and `border-border`. In custom
   CSS or arbitrary properties, use Tailwind v4 theme variables such as
   `var(--color-primary)` and `var(--color-muted-foreground)`.
3. Never write `oklch(var(--primary))`, `hsl(var(--primary))`, or otherwise
   assume the storage format of raw variables such as `--primary`. A project may
   store a channel tuple while Studio stores a complete CSS color. For opacity,
   use utilities such as `bg-primary/20` or `color-mix()` with
   `var(--color-primary)`.
4. When Studio opens, use the dedicated **CLI Review**. Confirm its
   **Demos (N)** count, select every demo, and inspect the right-side live
   preview. Exercise every meaningful state and verify both light and dark
   themes, including that the semantic primary color resolves correctly.
5. If the preview is blank, throws, has unresolved dependencies, or has wrong
   colors, fix the source and run `21st publish` again. Do not hardcode the
   source project's brand color just to make the preview pass.
6. Wait for the automatically generated **Cover** before final publish. Cover
   generation has first priority and the cover remains a hard publish gate. The
   optional video is best-effort in the background: publish never waits for it
   and includes it only if ready. Replace either asset manually if
   the generated result is not representative.
   Generated media is not a substitute for reviewing the live component.

### Updating vs a new component

Inventory first. Use `21st open component:<id>` to create or resume a reviewed
revision from the retained published code and demos. If the source is already
changed locally, run `21st publish <file> --component component:<id>` instead.
The current live version stays unchanged until the revision completes CLI
Review and is published. If the user meant a new component but the slug
collides, confirm before proceeding and suggest a different `--slug`.

### Hard rules for agents

- Never fabricate a description or publish a file with API keys, secrets, or
  unsaved edits.
- For existing work, inventory first and use its stable ref; do not guess from
  a slug.
- Always search first, ship a useful demo, verify the build and dependencies,
  complete the live-preview and theme-token review above, and wait for the
  required cover before final publish.

---

## Publish a theme

A theme is a CSS file that must define **both** a `:root` and a `.dark` block of
token values. It publishes as a **public** community theme.

```bash
21st publish-theme ./my-theme.css --name "Midnight" [--tags dark,minimal]
```

To generate that CSS from the current project's design tokens instead of writing
it by hand, use the `21st-design-sync` skill.

## Publish a template

A template is a metadata listing (URLs, not files). It lands in `draft` for
moderation.

```bash
21st publish-template "SaaS Starter" \
  --site https://demo.example.com \
  --preview https://example.com/thumb.png \
  [--description "…"] [--price 49] [--buy-url https://…] [--video https://…] [--tags 1,2]
```

---

## Edit & delete your published items

```bash
# Update an exact component from inventory. A Team manager may manage metadata.
21st edit component:<id> --type component --visibility published|private \
  [--description "…"] [--tags a,b]
21st edit <theme-id> --type theme [--visibility public|private] [--name "New Name"] [--tags a,b]
21st edit <template-id> --type template [--name N] [--description D] [--tags 1,2]

# Remove an item. ALWAYS requires --yes. Semantics differ by type:
#   component -> unpublished (visibility set to private; reversible via edit/re-publish)
#   theme     -> unpublished (removed from the marketplace; reversible)
#   template  -> PERMANENT hard delete
21st delete component:<id> --type component --yes
21st delete <id> --type theme|template --yes

# Catalog review is independent from Published/Private access.
21st submit <slug>
21st withdraw <slug>
21st resubmit <slug>
21st remove-from-catalog <slug>
```

Notes: template visibility is moderation-controlled (`--visibility` is ignored
for templates). Themes rename via `--name` and only support `public|private`.
Component edit/delete accepts a login session or API key; theme/template
management still requires an API key. For browser editing, inventory first and
run `21st open <stable-ref>`. If retained component source cannot be checked out
safely, create a reviewed code revision with
`21st publish <file> --component component:<id>` instead.

---

## Manage your profile page (bento board)

Your public profile at `21st.dev/@you` can show a bento-style board of blocks
instead of the classic layout. `set` is a FULL REPLACE (like `--tags` on
`edit`) — read the current board first if you want to keep existing content.

```bash
21st profile get [--json]                 # read your current board (as blocks)
21st profile set --file board.json        # replace it (JSON array, or pipe it via stdin)
21st profile set --clear                  # revert to the classic (non-bento) profile
21st profile upload ./cover.png           # upload a png/jpg/gif/webp, prints a url
```

`board.json` is an array of blocks, top to bottom:

```json
[
  { "type": "component", "demoId": 143 },
  { "type": "library", "refId": "<personal-or-team-library-id>" },
  { "type": "social", "url": "https://x.com/you" },
  { "type": "note", "text": "Building UI for 21st.dev" },
  { "type": "hire", "headline": "Work with me", "url": "https://cal.com/you" },
  { "type": "divider" },
  { "type": "image", "mediaUrl": "<url from `profile upload`>" }
]
```

Block types: `component` (your OWN demoId — from `21st search --mine` or
`21st get`), `social` (a link card, icon auto-detected from the domain),
`note` (text), `hire` / `pro` / `support` (headline/body/url/email/cta),
`library` (a public personal or team library by `refId`),
`image` (`mediaUrl` from `profile upload` — a foreign url is dropped, not an
error), `divider` (splits the board into a new section). Every block accepts
optional `w`/`h` (grid units, 1-3 wide / 1-2 tall) to size it.

Reordering = re-post the blocks array in the order you want; the board packs
top-to-bottom, left-to-right in array order.

## Teams & config

```bash
21st teams                          # your teams
21st team <teamId>                  # a team's libraries
21st team-lists <teamId>            # a team's shared bookmark lists
21st team-components <teamId> [--library <id>]

21st init --client cursor|Codex|codex|vscode|windsurf [--write]   # write MCP config
```
