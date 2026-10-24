# Canonical directory: the governance PR (separate, opened only on Tonio's yes)

Paste-ready diffs that make the Storybook **Design proposals** section the design directory:
the source of truth for visual references, with `DESIGN.md` recording decisions and pointing at
entries. The skill does not need it: every lab ships in mode A (story `status: "proposed"`, stage
carried by the registry's `stage` field and, once a per-direction story is written by hand, by its
first sentence; see `lifecycle.md`). Part 1 is the governance change, prose only. Part 2 is the
optional mode-B script change that lets an entry carry `current` or `historical`. Today's framing,
and why it exists, is `design-proposals-storybook.md` section 6; it is not repeated here.

Rules:

- Never apply any of this inside a lab PR. Offer it once, in one line of the lab PR body:
  "The design-directory governance change (`canonical-directory.md`) is ready as a separate PR
  on request." Open it only when Tonio says yes: branch `claude/design-directory`, title
  `docs(design): make the Design proposals section the design directory`, body from
  `.github/PULL_REQUEST_TEMPLATE.md` with every section filled, including Model Used.
- Part 1 alone is a complete PR. Part 2 alone is not: do not change the script while
  `DESIGN.md:9` still says Storybook does not define the system.
- Line numbers were read on 2026-10-24 at `5e26b733b`. Re-check each with `sed -n` before
  editing: every `-` line below must still match byte for byte, or the diff is stale.

## Part 1: governance diffs (prose only, no script change)

### 1.1 `DESIGN.md:9`, the source-of-truth sentence (under `## What this document is for`, line 7)

```diff
-Agents and humans modifying `ui/` treat this file as the source of truth for design decisions. Storybook is the verification surface — it documents the system; it does not define it. If a change conflicts with this document, change this document first (with review) or change the code.
+Agents and humans modifying `ui/` treat this file and the Storybook **Design proposals** directory as the source of truth: a directory entry (meta id `design-*`) is the canonical visual reference for its subject at its recorded stage; this document records the decisions and points at the entries. The rest of Storybook is the verification surface — it documents the system; it does not define it. If a change conflicts with this document or with a directory entry, change the document or the entry first (with review) or change the code.
```

Why "at its recorded stage": a `proposed` entry is canonical for what the proposal looks like,
not a claim that the product renders it. The stage is what separates the two.

### 1.2 New `## Design directory` section (additive)

Insert after line 9, before `## Product stance` (`DESIGN.md:11`), beside the sentence that
grants the authority:

```markdown
## Design directory

The Storybook **Design proposals** section is the design directory. Each row names the
entry (its stable meta id, `design-*`) that is the canonical visual reference for a subject
and the stage recorded for it. Advance a row's stage in the PR that advances the entry.
A subject without a row has no canonical reference yet. Entries never count as
production coverage; the product's own feature-home stories do.

| Subject | Entry | Stage |
| --- | --- | --- |
| Artifacts | `design-artifact-directions-compare` | adopted (`enableArtifactsV1`) |
```

No URL column: the meta id is the durable pointer (`/iframe.html?id=<meta id>--<export>`); the
published host is not. First-row facts: the id is at
`ui/storybook/stories/design-proposals/artifact-directions-compare.stories.tsx:39` (the story is
`status: "proposed"`, `home: "design-proposals"`, lines 52-53); the flag is `enableArtifactsV1`
(`packages/shared/src/feature-catalog.ts:202`, read by `ui/src/hooks/useArtifactsV1Enabled.ts:7-8`).
The artifact lab predates the `design-<slug>-directions` id convention, hence the `-compare`
suffix; new labs use `registry.storyId`. `lifecycle.md` section 10 offers a lab's row as text in
this table's shape; the table stays literal Markdown.

### 1.3 `DESIGN.md:304` and `:311-313`, "review references" and the move on adoption

Both sit in one paragraph (`DESIGN.md:297-313`) of `## Task-row refresh: proposed specimen`
(`:289`). Leave line 303 (`home: "design-proposals"`, `status: "proposed"`, "an explicit staging
reason") alone in Part 1: the catalog still enforces exactly that (`scripts/storybook-catalog.mjs:99-100`).
Line 311 starts mid-sentence; keep its first clause.

```diff
-These stories are review references and do not count as current production coverage.
+Directory entries are the canonical references for their subjects and never count as production coverage.
 ...
-for tasks explicitly implementing the refresh. After design review and adoption
-in the app, move each suite to its feature or Foundations home and update its
-classification while retaining its explicit story ID and exports.
+for tasks explicitly implementing the refresh. After adoption in the app the entry stays in
+the directory with its ID and exports; the shipped component gets its own story in its
+feature home, and the Design directory table above records the new stage.
```

### 1.4 `maps/storybook-map/README.md:34-35`, the exception is the entry's purpose

```diff
-Staged design work may use `home: "design-proposals"`, with `status: "proposed"`
-and an exception explaining why it is staged separately from production references.
+Design directory entries use `home: "design-proposals"`, `status: "proposed"` and an
+exception stating the entry's purpose: the subject it is the canonical reference for and
+what it compares.
```

### 1.5 `maps/storybook-map/README.md:60-75`, the section's role and the stages

Lines 61-69 (folder, title prefix, group order, "Preserve explicit story IDs and exports") stay.

```diff
-**Design proposals** is a separate top-level review section. Its stories live in
+**Design proposals** is the design directory: a separate top-level section whose entries
+are the canonical visual references named in `DESIGN.md` (Design directory). Its stories live in
 ...
-Retain capability references so proposals remain discoverable from the feature
-guide, but never count them as current production examples. Keep using shared
-components and tokens rather than creating a parallel design implementation.
-When a proposal is reviewed and adopted in the app, move its story into the usual
-feature or Foundations home, update its classification and staging metadata, and
-preserve the explicit CSF ID and exports so review links remain valid.
+Retain capability references so entries remain discoverable from the feature guide,
+but never count them as production coverage. Keep using shared components and tokens
+rather than creating a parallel design implementation. An entry has one of four stages:
+proposed, adopted (behind a flag), current (shipped as the default) and
+historical (superseded, with `replacement` naming the successor). The stage is recorded
+in the entry's description and in the `DESIGN.md` Design directory table; the catalog
+status stays `proposed` while the catalog accepts only that status in this home. Entries
+stay in the directory at every stage and keep their explicit CSF ID and exports; the
+shipped component gets its own story in its feature home.
```

Why entries stay put: fifteen of the twenty directory ids are pinned by Playwright specs, and a
directory whose entries leave when they succeed is not a directory. The count, from the repo root
(two of the fifteen, `tasks-list-page-design` and `tasks-row-design`, have no `design-` prefix):

```sh
for id in $(git ls-files 'ui/storybook/stories/design-proposals/*.stories.tsx' | xargs grep -hoE '^\s*id: "[^"]+"' | cut -d'"' -f2); do grep -rqF -- "$id" tests/storybook-visual && echo "$id"; done | wc -l   # 15 of the 20 ids
```

### Part 1 verification

Nothing executable reads this prose. Run what AGENTS.md requires after a `maps/` edit, plus the
catalog, which must be unaffected:

```sh
node scripts/check-maps.mjs                 # today: "Maps aligned: 35 areas, 191 capability IDs"
node scripts/storybook-catalog.mjs --check  # today: "Storybook map: 316 files, 2973 stories."
```

## Part 2 (optional): mode-B script change

Mode B lets a directory entry carry `status: "current"` or `"historical"` under
`home: "design-proposals"` while still never counting as coverage. The skill detects mode A by
the exact message `design proposal home requires proposed status` in `scripts/storybook-catalog.mjs`
(`scripts/lib/modes.mjs`; `lifecycle.md` section 2). The new message below does not contain that substring (the comma
breaks it), which is what flips detection to mode B. Do not shorten the message back.

### 2.1 `scripts/storybook-catalog.mjs:99`, the status gate

```diff
-      if (entry.status !== "proposed") errors.push(`${label}: design proposal home requires proposed status`);
+      if (!["proposed", "current", "historical"].includes(entry.status)) errors.push(`${label}: design proposal home requires proposed, current or historical status`);
```

`mixed` and `unreviewed` stay rejected: a directory entry is a decision, and both mean the
decision has not been made. Line 100 (the exception requirement) is unchanged.

### 2.2 `scripts/storybook-catalog.mjs:133`, the home description in the generated index

```diff
-    { id: "design-proposals", title: "Proposed design system", section: "Design proposals", description: "Staged design work for review. These examples retain capability references but do not count as current product coverage." },
+    { id: "design-proposals", title: "Proposed design system", section: "Design proposals", description: "Design directory. Canonical references for design subjects; they never count as product coverage." },
```

### 2.3 `scripts/storybook-catalog.mjs:165` and `:169`, coverage excludes the home regardless of status

```diff
-  const examples = catalog.entries.filter(entry => entry.implementation !== "guide" && !["historical", "proposed"].includes(entry.status));
+  const examples = catalog.entries.filter(entry => entry.implementation !== "guide" && !["historical", "proposed"].includes(entry.status) && storyHome(entry) !== "design-proposals");
 ...
-    `${capabilities.length} capabilities; ${missing.length} without a current, mixed or unreviewed example. Historical examples, proposals and guides do not remove gaps.`, "",
+    `${capabilities.length} capabilities; ${missing.length} without a current, mixed or unreviewed example. Historical examples, proposals, design directory entries and guides do not remove gaps.`, "",
```

`storyHome` is defined in the same module (`:70-72`). Without the new clause a `current`
directory entry silently closes a capability gap; the test in 2.4 fails on exactly that
(verified: with only this clause reverted, "1 without" becomes "0 without"). The line-169
wording keeps the generated `maps/generated/verification.md` true; no test matches that tail
(`storybook-catalog.test.mjs:98,159` match only `/2 without a current, mixed or unreviewed example/`).

### 2.4 `scripts/storybook-catalog.test.mjs:101-115`

Lines 109-114 (exception, title and folder assertions) are unchanged. `renderVerification` is
already imported at line 6.

```diff
-test("design proposal homes require proposed status, a staging reason and their own navigation", t => {
+test("design proposal homes require a directory status, a staging reason and their own navigation", t => {
   const f = mapFixture(t);
   const metadata = { home: "design-proposals", status: "proposed", capabilities: ["tasks/create"], exception: "Staged refresh for review." };
   const options = { area: "design-proposals", title: "Design proposals/Tasks/Task row" };
-  for (const status of ["current", "mixed", "unreviewed", "historical"]) {
+  for (const status of ["mixed", "unreviewed"]) {
     f.story("proposal", { ...metadata, status }, options);
-    assert.match(inspect(f).errors.join("\n"), /design proposal home requires proposed status/);
+    assert.match(inspect(f).errors.join("\n"), /design proposal home requires proposed, current or historical status/);
   }
+  f.story("proposal", { ...metadata, status: "current", capabilities: ["tasks/discussion"] }, options);
+  const current = inspect(f);
+  assert.deepEqual(current.errors, []);
+  assert.match(renderVerification(current.catalog, current.index), /1 without a current, mixed or unreviewed example/);
+  f.story("proposal", { ...metadata, status: "historical" }, options);
+  assert.deepEqual(inspect(f).errors, []);
   f.story("proposal", { ...metadata, exception: undefined }, options);
```

Why `tasks/discussion`: `mapFixture` (`scripts/map-test-fixture.mjs:31-32`) seeds `tasks` with
`create` and `discussion` and one `unreviewed` story on `tasks/create`, so `discussion` is the
one open gap. A `current` directory entry on it must leave "1 without"; "0 without" means the
entry counted as coverage.

### Part 2 verification

Run from the repo root and paste the three results into the PR's Verification section:

```sh
node --test scripts/storybook-catalog.test.mjs        # 13 tests, 13 pass, before and after (one test rewritten, none added)
node scripts/storybook-catalog.mjs --check             # "Storybook map: 316 files, 2973 stories."; all 20 directory entries are proposed, so nothing flips
cd ui && npx vitest run storybook/map-tooling.test.ts  # 1 passed; wraps the three node --test files (ui/storybook/map-tooling.test.ts:6)
```

The vitest wrapper is the CI signal (`maps/storybook-map/README.md:104-105`); a green
`node --test` alone is not. `cd ui && pnpm typecheck` also re-runs the catalog (`ui/package.json:23`);
report it as not run if `@paperclipai/plugin-sdk` is not built.

With Part 2 merged, a lab records stages as `lifecycle.md` mode B says: proposed and adopted map
to `status: "proposed"`, current to `"current"`, historical to `"historical"` plus `replacement`.
`scaffold.mjs check` then derives the expected Compare `status` from the registry stages
(`scripts/lib/modes.mjs`, `labStage`): `"proposed"` while any exploration is proposed or adopted,
`"historical"` plus `replacement` when every exploration is historical, `"current"` otherwise.
In the same PR amend README line 34 from `status: "proposed"` to "`status` of `proposed`,
`current` or `historical` (adopted entries keep `proposed`)" and drop the 1.5 clause "the catalog status stays
`proposed` while the catalog accepts only that status in this home".

## What does not change

- The literal-only rule: `parameters.paperclip` is parsed, never executed, and must follow
  spreads (`scripts/storybook-catalog.mjs:26-59`). Stage never becomes a computed value.
- The `statuses` list (`:13`) and the `home` allow-list (`:95`): no new status, no new home.
- Meta ids and exports: `stableId` is required (`:109`) and every id stays; Part 1 removes the
  move-on-adoption that used to put them at risk.
- The folder and title rules (`:107-108`): entries live in `ui/storybook/stories/design-proposals/`
  with titles under `Design proposals/`; the sidebar slot (`scripts/storybook-feature-index.mjs:11`)
  and the proposal theme scope (`ui/storybook/.storybook/preview-base.tsx:853`) key on the same home.
- The home's `title` ("Proposed design system") and `section` ("Design proposals") at `:133`:
  only the description changes, so the Overview guide and sidebar labels are untouched.
- The capability lookup (`:159`) keeps printing `(<status>)` after each entry; under mode B a
  directory entry shows `(current)` there while `verification.md` still lists the gap. Intended:
  lookup is navigation, coverage is `verification.md`.
- `doc/DEVELOPING.md` and the three commands above: no command changes.
