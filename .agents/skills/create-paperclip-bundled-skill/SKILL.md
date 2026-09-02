---
name: create-paperclip-bundled-skill
description: >
  Turn an idea, tweet, or task into a skill in the Paperclip skills catalog
  (packages/skills-catalog). Use when asked to FIND or MAKE a skill and publish
  it as a bundled/optional catalog skill: research prior art, reference or
  author it, add examples, regenerate the manifest, open a PR.
---

# Create a Paperclip Bundled Skill

Take source material — a tweet, a task description, a blog post, "make a skill
that does X" — and land it as a skill in the Paperclip skills catalog
(`packages/skills-catalog/`), delivered as a reviewed PR. The catalog is the
shelf every Paperclip company browses and installs from, so the bar is: correct
metadata, useful instructions, worked examples, and a clean validation run.

The core rule is **FIND before MAKE**: if a good skill already exists (in the
catalog, in this repo, or published on GitHub), reference or adapt it instead
of writing a duplicate from scratch.

## When to use

- A human sends a tweet/link/idea and asks for it to become a Paperclip skill.
- A task asks to bundle an existing repo skill into the catalog.
- A task asks to add an external published skill to the catalog.

## When not to use

- The skill is company-private (belongs in that company's library via the
  Skills UI/API, not the shipped catalog).
- You only need a repo-internal agent skill for working on Paperclip itself —
  that goes in `.agents/skills/` or `skills/`, with no catalog machinery.

## Step 0 — Capture the source material

Understand exactly what the skill should teach before writing anything.

**Tweets / X links.** Use the `xc` CLI (X API client). Paperclip engineering
agent environments ship it preinstalled and pre-authenticated; it is not a
tool you install or mint credentials for yourself. Check availability before
relying on it:

```sh
command -v xc && xc whoami    # on PATH and authenticated? if not, use the fallback below
```

```sh
xc get <post-url-or-id> --json        # the post itself (conversation_id, author)
xc search 'conversation_id:<id>' --archive --json   # rest of the thread (>7 days old needs --archive)
xc user <username>                    # author context
xc search '<topic keywords>' -n 30    # related discussion
```

If `xc` is not on PATH, is unauthenticated, or the account lacks read access
(the check above fails for any reason), delegate the
fetch to a teammate with X/Twitter access (e.g. the Content Strategist agent)
via a child issue: give them the URL and ask for full text of the post + thread
+ any linked content.

**Other sources.** Fetch linked articles/READMEs directly. Record the source
URL — it goes in the skill body or PR description as attribution.

Distill: what is the repeatable procedure? What inputs does it take? What does
"done" look like? If the source is just an aspiration ("agents should write
better commit messages"), you are authoring the procedure yourself — say so in
the PR.

## Step 1 — FIND: search for an existing skill

Search in this order; stop when you have a clear winner.

1. **Already in the catalog?** Avoid duplicates (duplicate slugs fail the
   build):
   ```sh
   grep -i '<topic>' packages/skills-catalog/generated/catalog.json
   ls packages/skills-catalog/catalog/{bundled,optional}/*/
   ```
2. **Already in this repo?** Check `.agents/skills/`, `skills/`, and issue
   history (`gh search issues` / Paperclip board) for prior work on the topic.
3. **Published on GitHub?** Skills are conventionally a directory with a
   `SKILL.md`:
   ```sh
   gh search code --filename SKILL.md "<topic>" --limit 20
   gh search repos "<topic> skill" --limit 20
   ```
   Also check known collections (e.g. `anthropics/skills`) and do a web search
   for `<topic> agent skill SKILL.md`.

Judge candidates by: does the SKILL.md actually contain the procedure (not a
stub)? Is it maintained? What does it bundle (scripts raise the trust level)?
Is the license compatible with redistribution? Then pick a path:

- **Good external skill exists** → add it as an **external reference**
  (Step 2A). It stays attributed to and pinned at the upstream repo.
- **Partial match** → author a local skill (Step 2B) that adapts the idea;
  credit the source with a link in the SKILL.md body.
- **Nothing usable** → author a new local skill (Step 2B).

## Step 2 — Choose kind, category, and slug

- **kind**: default to `optional`. Use `bundled` only when the skill should
  ship to every Paperclip company by default — that needs explicit human/board
  direction, not your judgment call.
- **category**: reuse an existing directory when one fits (`browser`,
  `content`, `docs`, `finance`, `paperclip-operations`, `product`, `quality`,
  `research`, `software-development`). New categories are allowed but must be
  lowercase kebab-case slugs.
- **slug**: lowercase kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`), unique across
  the whole catalog (both kinds).

The skill lives at
`packages/skills-catalog/catalog/<kind>/<category>/<slug>/` and its canonical
key is `paperclipai/<kind>/<category>/<slug>`.

## Step 2A — External reference path (`catalog-ref.json`)

The directory contains **only** `catalog-ref.json` (a directory with both
`catalog-ref.json` and `SKILL.md` fails the build). The manifest builder
fetches the pinned files from GitHub at build time and inventories them.

```sh
# Pin the exact commit for the chosen ref (tag or branch)
gh api repos/<owner>/<repo>/commits/<ref> --jq .sha
```

```json
{
  "source": {
    "type": "github",
    "hostname": "github.com",
    "owner": "<owner>",
    "repo": "<repo>",
    "ref": "<tag-or-branch>",
    "commit": "<40-char sha from above>",
    "path": "<dir inside the repo containing SKILL.md, or ''>"
  },
  "files": ["SKILL.md", "references/**", "scripts/run.py"],
  "defaultInstall": false,
  "recommendedForRoles": ["researcher"],
  "requires": ["python3"],
  "tags": ["topic", "keywords"]
}
```

Rules the builder enforces:

- `files` entries are exact relative paths or `dir/**` globs; `SKILL.md` must
  be included and must have frontmatter with `name` and `description`.
- If the upstream frontmatter declares `key`/`slug`, they must match the
  catalog placement — otherwise pick a matching slug or use the local path.
- `commit` must be a full 40-hex SHA; every listed file must be ≤ 1 MiB.
- `recommendedForRoles`, `requires`, `tags` live in the JSON (there is no
  local SKILL.md to carry them).

See `catalog/optional/research/last30days/catalog-ref.json` for the live
example, and `examples/external-reference.md` next to this skill.

## Step 2B — Author a local catalog skill

Layout:

```
catalog/<kind>/<category>/<slug>/
├── SKILL.md          # required entrypoint
├── examples/         # 1–2 worked examples (Step 3)
├── references/       # optional deep-dive docs
├── scripts/          # optional — raises trust level, avoid unless needed
└── assets/           # optional templates/images
```

`SKILL.md` frontmatter (all validated by the builder):

```markdown
---
name: <slug>
description: >
  40–300 chars. Routing logic, not marketing: what it does, when to use it,
  when not to.
key: paperclipai/<kind>/<category>/<slug>
recommendedForRoles:
  - engineer            # non-empty; used for staffing suggestions
tags:
  - topic               # non-empty; used for browse/search
---
```

Optional frontmatter: `defaultInstall: true` (only for skills every new
company should get), `requires: [node, python3, ...]` for runtime deps.

Body: follow `docs/guides/agent-developer/writing-a-skill.md` — "When to use"
/ "When not to use" sections, concrete commands over prose, supporting detail
in `references/`. If the skill came from a tweet or external source, link it
in the body for attribution.

Trust level is derived from files, not declared: any `scripts/` file makes the
skill `scripts_executables` (install becomes audit-gated and you must extend
the `scriptBearing` expectation in `src/shipped-catalog.test.ts`); `assets/`
or non-markdown files make it `assets`; markdown-only skills stay
`markdown_only`. Prefer markdown-only.

## Step 3 — Write 1–2 worked examples

Create `examples/` inside the skill directory with one or two markdown files,
each a complete input → application → output walkthrough (realistic input, the
skill's steps applied, the finished artifact). These ship with the skill so
installers can judge it before running it, and they keep the trust level at
`markdown_only` because they are `.md` files.

Name them by scenario, e.g. `examples/rewrite-release-note.md`.

## Step 4 — Regenerate the manifest and update tests

Never hand-edit `generated/catalog.json`; it is deterministic build output.

```sh
pnpm --filter @paperclipai/skills-catalog build:manifest   # regenerates generated/catalog.json
pnpm --filter @paperclipai/skills-catalog validate         # must report no errors
```

(External references need network access to GitHub during these steps.)

Then update `packages/skills-catalog/src/shipped-catalog.test.ts`:

- add the new key to `EXPECTED_BUNDLED_KEYS` or `EXPECTED_OPTIONAL_KEYS`
  (alphabetical order);
- if the skill bears scripts, add it to the `scriptBearing` expectation.

```sh
pnpm --filter @paperclipai/skills-catalog test
```

The test suite also enforces the ≤300-char frontmatter description budget
across the repo and the ≥40-char description / non-empty roles+tags rules for
every catalog skill.

## Step 5 — Open the PR

Follow the `prepare-paperclip-pr` skill (`.agents/skills/prepare-paperclip-pr/`)
against `paperclipai/paperclip` master. The diff should contain exactly:

1. the new skill directory (SKILL.md + examples/ + supporting files, **or**
   catalog-ref.json),
2. the regenerated `generated/catalog.json`,
3. the `shipped-catalog.test.ts` expectation update.

In the PR body: link the source material (tweet URL, upstream repo), state
whether this is a new skill / adaptation / external reference, and note the
trust level. Reference PR #10410 (simplified-english) as the shape of a
minimal optional-skill PR.

## Gotchas

- `generated/catalog.json` staleness is a validation error — always rerun
  `build:manifest` after any file change inside the skill directory (the
  inventory carries per-file sha256 hashes).
- Duplicate `slug` across bundled *and* optional fails the build, not just
  duplicate keys.
- Symlinks inside a skill directory must resolve within it; directory
  symlinks are rejected — copy files in.
- The `bundled` kind and `defaultInstall` are independent axes; don't set
  `defaultInstall: true` casually on optional skills.
- For external references the builder fetches from GitHub on every manifest
  build; a moved/deleted upstream breaks the build, which is why `commit` is
  pinned — prefer upstream tags for `ref`.
