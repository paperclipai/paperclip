# Lifecycle: proposed, adopted, current, historical

How a direction moves from exploration to canonical, and what you edit by hand at each move. This
version of the skill scaffolds (`new`, `add-direction`), verifies (`check`) and lists (`list`); every
move below is a hand edit. Mechanics already written elsewhere are linked, not repeated:
`design-proposals-storybook.md` §1 (catalog rules) and §5 (the long-form lifecycle), `repo-gates.md`
§8 (hand-off commands), `motion-spec.md` §4.2 (product motion), `canonical-directory.md` (the
governance diff that enables mode B). Line numbers were opened at `5e26b733b`; re-check after the
cited files change. Working directory: repo root.

## 1. Where the stage lives

The catalog annotation is a closed field set with no stage field (`scripts/storybook-catalog.mjs:16`),
and under `home: "design-proposals"` it accepts only `status: "proposed"` (`:98-101`). So a direction's
stage is carried outside the annotation, in three places you keep in step by hand:

1. `ui/src/<slug>-directions/registry.ts`: each exploration's `stage` (`proposed | adopted | current |
   historical`); Today is `shipped`. The lab toolbar appends ` · <stage>` to a direction's hint when it
   is adopted or current, so the page says what shipped without a new control.
2. The per-direction story `ui/storybook/stories/design-proposals/<slug>-directions-<digit>.stories.tsx`:
   the first sentence of `docs.description.component` states the stage (sections 4 to 6). The Compare
   story's description does not change; it describes every direction.
3. The feature-home story's `status`, once product code exists (sections 4 and 5).

`node .agents/skills/directions-lab/scripts/scaffold.mjs check --slug <slug>` reads 1 and checks only
the Compare story's `status` against it under the detected mode (section 2): `proposed` in mode A; in
mode B the lab's stage: `proposed` while any exploration is `proposed` or `adopted`, `historical` when
every exploration is `historical` (then the story must also carry `replacement`, naming an existing story
file), else `current` (every exploration shipped, or the ones that did not were retired). It never opens 2 or 3; compare their
sentences with 1 by hand. Run it after every move. Run `scaffold.mjs list` first to see the labs in the
repo with their direction ids, surfaces, ports and story id; the stage is read in `registry.ts`.

| Stage | Registry entry | Directory stories (`design-proposals/`) | Feature-home story | Code |
| --- | --- | --- | --- | --- |
| proposed | `stage: "proposed"` | Compare (and per-direction, when written): `status: "proposed"`, `home: "design-proposals"`, `exception` | none | lab only |
| adopted | `stage: "adopted"` (flag and PR in the story sentence) | unchanged | `implementation: "production"`, `status: "proposed"`, no `home`, no `exception` | lab + `ui/src/components/<feature>/` behind `enable<Feature>` |
| current | `stage: "current"` | mode A unchanged; mode B per-direction `status: "current"`, Compare `"current"` once no exploration is still proposed or adopted | `status: "current"` | product; the lab stays the reference |
| historical | `stage: "historical"` (replacement in the story) | mode A: file moved out of the folder, `status: "historical"`, `replacement`; mode B: same fields, file in place, Compare too once every exploration is historical | unchanged | lab kept while its stories import it |

## 2. The two modes

Mode A, "staged until shipped", is what the repo runs today. `storybook-catalog.mjs:99` rejects any
status but `proposed` under the proposals home, and `scripts/storybook-catalog.test.mjs:101-108`
asserts that `current`, `mixed`, `unreviewed` and `historical` all fail there. Every directory entry is
therefore `proposed` for as long as it lives in the folder, whatever the direction's real stage; the
stage lives in the registry, the toolbar hint and the per-direction story sentence. The folder is framed
as a review section, not an authority (`DESIGN.md:297-304`; `maps/storybook-map/README.md:34-35`).

Mode B exists after `canonical-directory.md` is applied, as its own PR, only on Tonio's yes. Then line
99 accepts `proposed | current | historical` under the home, line 165 keeps excluding the home from
coverage whatever the status, and a directory entry may say `current` or `historical` without moving.
Detect the mode by reading the script, never by date: mode A while `scripts/storybook-catalog.mjs`
contains the text `design proposal home requires proposed status`, else mode B. Never apply the
governance diff inside a lab PR; offer it once, in one line of the PR body.

## 3. Proposed: what `new` writes

`new` writes the directory story `<slug>-directions.stories.tsx` with meta `id: "design-<slug>-directions"`,
`status: "proposed"`, `home: "design-proposals"`, `implementation: "prototype"`, `boundary: "fixtures"`
and the derived `exception`, and sets `stage: "proposed"` on every exploration in `registry.ts`
(`shipped` on Today). `add-direction` inserts another `proposed` entry before Today and a `D<digit>`
export in that story. No per-direction story exists yet; write one by hand only when a direction needs
surface and slot deep dives before adoption, following `design-proposals-storybook.md` §4
("Per-direction deep dives"): file `<slug>-directions-<digit>.stories.tsx`, digit-keyed id
`design-<slug>-directions-<digit>`. Why digits: a rename of the direction never changes a story id, and
story ids are what Playwright specs and review links pin. `check` admits the slug in the Compare story alone: a
per-direction story, in the folder or moved out, fails it with `names <slug>-directions outside the lab`
until the scan admits those files; read that line as expected and judge the rest of the report.

Nothing else to edit at this stage. Approval is visual and human: "It remains proposed until visual
approval." (`DESIGN.md:150-151`).

## 4. Adopted: product code lands behind an experimental setting

Precondition: Tonio chose the direction. Then, in one product PR plus one lab PR, or together:

1. Product code under `ui/src/components/<feature>/` by the rules in section 9, gated by a new setting
   `enable<Feature>` built end to end like `enableArtifactsV1`: type `packages/shared/src/types/instance.ts:93`,
   validator `packages/shared/src/validators/instance.ts:67`, catalog entry
   `packages/shared/src/feature-catalog.ts:202-209`, hook `ui/src/hooks/useArtifactsV1Enabled.ts:24-41`
   (`resolveArtifactsV1Enabled`, `:7-9`), toggle `ui/src/pages/InstanceExperimentalSettings.tsx:310`.
   Why a setting: the old presentation stays the fallback until the setting is removed in a later
   cleanup (`doc/plans/2026-10-22-artifacts-mvp-v1.md:19-22`).
2. A feature-home story modelled on `ui/storybook/stories/documents-artifacts/artifact-v1-primitives.stories.tsx:43-62`:
   meta id under the feature (`:44`, `components-artifact-v1-primitives`), title under the feature prefix
   (`:45`), a description that names the setting (`:51`, "behind Settings > Experimental > Artifacts V1"),
   and `paperclip` with `capabilities` (`:55`), `status: "proposed"` (`:56`), `implementation: "production"`
   (`:57`), `boundary: "fixtures"` (`:58`), `notes` (`:59`); no `home`, no `exception`. Why `proposed`
   there: the status is legal anywhere (only the proposals home forces it, `storybook-catalog.mjs:99`) and it
   keeps a flagged presentation out of coverage counts (`:165`) until the flag goes.
3. The lab. In `registry.ts` set the entry's `stage` to `"adopted"` and nothing else: `LabDirection`
   (`define-lab.ts`) has no `flag`, `pr` or `product` field, and the exact-line parser behind `check`,
   `list` and `add-direction` refuses an entry that carries one (`direction line not in generator form`).
   The flag and PR go in the per-direction story's first sentence and the product path in its `notes`:
   write the story if it is absent (section 3) and make the sentence exactly:
   ``Stage: adopted behind `enable<Feature>` (#<pr>).``
   Keep `status: "proposed"` and the home in both modes: adopted maps to `proposed`.
4. Optional, when Today should show the shipped flag-on presentation: set
   `today: { flags: { enable<Feature>: true } }` in `registry.ts`; the generated `api-routes.ts` already
   answers `/instance/settings/experimental` with those flags, and `setLabFlags()` switches them at run
   time (`today-fixtures-and-build.md` §1 explains the flag-OFF default). A second Today kit beside the
   flag-off one is not registrable: `defineLab` admits one baseline, `today` keyed `0`, and every other
   entry must be `d<N>-<name>` with a digit key.

The lab stays the visual reference (`doc/plans/2026-10-22-artifacts-mvp-v1.md:14`): when the port and
the drawing differ, fix the port. Do not redraw the adopted direction to match product code. `check`
does not compare tokens: after adoption diff each `--<p>-<name>` value in that direction's `tokens.css`
against `--<feature>-<name>` in `ui/src/index.css` by hand (section 9) and record drift in the PR.

## 5. Current: the flag is removed

1. Remove the setting end to end (the files in section 4, item 1) and the fallback presentation.
2. Feature-home story: `status: "current"`. It now counts as coverage (`storybook-catalog.mjs:165`).
3. Lab: `stage: "current"` in `registry.ts`; per-direction story first sentence exactly:
   `Current: shipped as <feature-home meta id>.`
   Mode A: every directory entry stays `status: "proposed"`; the Compare story stays in the proposals
   folder as the visual reference while any direction is unshipped, and only a retirement (section 6)
   moves a file out of it. Mode B: set the per-direction story to `status: "current"`. Compare stays
   `proposed` while another exploration is still `proposed` or `adopted`, and becomes `"current"` once
   none is (the others retired per section 6): `check` derives this from the registry stages
   (`lib/modes.mjs`, `labStage` and `expectedStoryStatus`).

## 6. Historical: retiring a direction or a whole lab

Two catalog rules shape this move. `status: "historical"` may carry `replacement`, which must name an
existing story file (`storybook-catalog.mjs:110`, "replacement story is missing"). Under the proposals
home `historical` is rejected in mode A (`:99`), so the story must leave the folder: the home is then
derived from `capabilities[0]` (`storyHome`, `:70-72`), the file must live under
`ui/storybook/stories/<area>/` (`:107`) and the title must start with that feature's sidebar prefix
(`:108`). The meta `id` and every export name stay, so `<id>--<export>` links and specs keep working
(`maps/storybook-map/README.md:68-69, 73-75`).

Precedents, all outside the proposals folder, all `status: "historical"` with `replacement`:
`ui/storybook/stories/agent-chat/chat-entry.stories.tsx:6-7` (id `design-explorations-chat-entry`, title
`.../Design explorations/Chat entry`), `:17`, `:21`; `chat-channels/github-chat.stories.tsx:22, 26`;
`agents/new-agent-onboarding.stories.tsx:16, 20`; `steering/paused-composer.stories.tsx:20, 24`;
`onboarding/onboarding-connect-model.stories.tsx:29, 33`.

One direction, mode A:

1. `registry.ts`: `stage: "historical"` only; `replacement` is a story field, not a registry one (section
   4, item 3). In the story it names `<repo-relative .stories.tsx>` (the feature-home story of the
   direction that shipped, or the story that superseded it).
2. `git mv` the per-direction story to
   `ui/storybook/stories/<area>/design-explorations/<slug>-directions-<digit>.stories.tsx`. Drop `home`
   and `exception`; set `status: "historical"` and `replacement`; retitle to
   `<Section>/<Feature>/Design explorations/<Title> directions/<N>.<Name>` (section and feature labels
   are the ones the catalog derives for that area, `:86, :108`; copy them from a neighbouring story in
   the folder). First sentence: `Historical: superseded by <replacement meta id>.` Keep the id and the
   exports. Leave the kit directory in place: Compare still renders it and `registry.test.ts` still
   expects it.
3. Mode B instead: the file stays in the folder; change only `status` and `replacement`; keep `home`
   and `exception`.

A whole lab: every exploration goes `historical` with one `replacement`. Mode B: Compare stays in the
folder with `status: "historical"` and that `replacement`; `check` expects both once every exploration
is `historical` and fails without the field or when the named file is missing (another lab's story may
name this lab's story as its `replacement`; `check` skips `replacement:` lines when it scans for
`<slug>-directions` outside the lab). Mode A: move Compare and every
per-direction file together, keeping every id (Compare's title becomes
`.../Design explorations/<Title> directions/Compare`). With `capabilities: []` there is no area and
`storyHome` falls back to `foundations` (`:71`): add a real capability first rather than filing design
history under Foundations. `check` then reports the Compare story missing at its proposals path and the
moved files naming `<slug>-directions`; both are expected for a retired lab. The lab code stays until the
moved stories stop importing `@/<slug>-directions/*` (`kit`, `api-stub`, `api-routes`,
`frames/SurfaceView`); removing `ui/src/<slug>-directions/`, `ui/<slug>-directions.html`,
`ui/vite.<slug>-directions.config.mjs`, the two `.claude/launch.json` entries and the `.gitignore`
line is a later PR. Never delete a story because it is old or duplicated by name
(`design-proposals-storybook.md` §5, item 7). After any move run `pnpm build-storybook` before and
after and diff the ids in `ui/storybook-static/index.json`: the set must be unchanged.

## 7. Theme pairing: Storybook themes by default, the page is production by default

The proposals decorator at `ui/storybook/.storybook/preview-base.tsx:853` wraps a story whose
`parameters.paperclip.home` is `"design-proposals"` in `<AvatarInitialProvider><div className="design-proposal-theme">`
unless `parameters.designProposalTheme === false`. The marker's CSS is scoped `html:has(...)`, so the
whole iframe is themed, Today included, and Radix portals with it (`design-proposals-storybook.md` §2).
Why that is right for Compare: every kit sits under one palette, so a difference between two cells is a
difference between directions, never between palettes. The `TodayProductionPalette` export is the
opt-out, `parameters: { designProposalTheme: false }`, so the shipped baseline can also be judged on
the production palette from the same story file.

The standalone page inverts the default: production palette unless `?proposal=1`, which wraps the page
in the same two elements; there is no toolbar control and no key for it. Both hosts key dark/light on
`html.dark` and motion on `html[data-lab-anim]`, so a kit's `.dark [data-direction="<id>"]` tokens and
the motion block resolve identically in Storybook, on the page and in the Board iframes. Do not copy
d5's `html:not(.dark)` idiom (`motion-spec.md` §4.3); it inverts the pairs on the way to product.

## 8. Sandbox: the step between Storybook and production

`VITE_PAPERCLIP_DESIGN_SANDBOX=true` in a dev app (`ui/src/context/DesignSandboxContext.tsx:14`) adds
the same `design-proposal-theme` marker to `<body>` (`:23-25`) and a bottom-right "Design proposals:
On/Off" button (`:31-37`); `DESIGN.md:724-727` names the switch and `:755` its status: "an integration
experiment, not permission, scale or release acceptance". The sandbox mounts no lab kit. It themes the
real app on real data, so use it twice: before adoption, to check that the proposal-theme values a
direction leans on resolve on the real pages the lab's frames mock (missing token mappings show up
here, not on fixtures); after adoption, with `enable<Feature>` on in Settings > Experimental, to see
the ported component under both palettes with real records. The documented launch is at
`DESIGN.md:791-799`. Nothing seen in the sandbox changes a stage; record findings in the PR.

## 9. Graduation of code

Rules for the product PR of section 4, item 1. `pnpm run check:token-gates` applies to everything under
`ui/src/components/**` and `ui/src/pages/**` (`repo-gates.md` §3) and would fail the lab code as it
stands; that is the point of the port.

- Reuse the lab's code, not its types. Product components take product types through small adapters
  (`ui/src/components/artifacts/v1/adapters.ts:1-8, 27`, `subjectFromIssueDocument(doc: IssueDocument)`);
  the lab keeps its own copies and is a reference, not a dependency
  (`doc/plans/2026-10-22-artifacts-mvp-v1.md:28-32`). Never import `@/<slug>-directions/*` from product.
- Tokens: every value in the adopted direction's `tokens.css` becomes `--<feature>-<name>` in
  `ui/src/index.css`, light values in `:root` beside the feature's other tokens (precedent
  `--artifact-*` at `:495-531`) and dark overrides in `.dark` (`:591-600`). The kit's dark/light pairs
  map one to one; a value that exists only in one theme in the kit is a drawing bug to fix first.
  `DESIGN.md:17` forbids a second token source, `DESIGN.md:30` any raw value in components.
- Motion in product form (`motion-spec.md` §4.2; precedent `index.css:4808-4824`): drop the
  `html[data-lab-anim="1"]` gate, key on `.<feature>-tile`, rename the hooks to `data-<feature>-front`,
  `data-<feature>-rotate`, `data-<feature>-spread`, inline `--<feature>-base`, and declare
  `--<feature>-hover-ease: 300ms cubic-bezier(0.3, 0, 0.1, 1)` in `:root` beside the feature tokens
  (`:531`); the reduced-motion gate stays (`doc/plans/2026-10-22-artifacts-mvp-v1.md:37-38`). The curve,
  the 6px rise and the 5 degree fan do not change in the port.
- A component test asserts the hooks on every treatment branch, as
  `ui/src/components/artifacts/v1/ArtifactTile.test.tsx:50` (two `[data-artifact-spread]`) and `:97`
  (`[data-artifact-front]` present) do. Why every branch: a front rendered without its hook stands
  still while the backings turn (`motion-spec.md` §7, the bare-print lesson).
- Feature-home story as in section 4, item 2; `status: "current"` only when the flag is removed.

## 10. The DESIGN.md directory row

`DESIGN.md` has no `## Design directory` section today; `canonical-directory.md` adds one with the table
`| Subject | Entry | Stage |`. Until that PR lands, and in any lab PR after it, offer the row as text in
the PR body and never write it:

```
| <Subject> | design-<slug>-directions | <stage> |
```

Why offered, not applied: `DESIGN.md:9` makes the document the source of truth and asks for review
before it changes, so a lab or product PR that edits it mixes a design decision into an implementation
diff. The row's second column is the stable meta id, not a URL, because ids survive renames and the
Vercel alias does not. Update the stage in the offered row at every move of sections 4 to 6.

## 11. Verify after every move

```sh
node .agents/skills/directions-lab/scripts/scaffold.mjs check --slug <slug>
node scripts/storybook-catalog.mjs --check
cd ui && pnpm typecheck
```

Then the hand-off list in `repo-gates.md` §8. A move that touched product code also runs
`pnpm run check:token-gates` and the component tests; a move that moved a story file also diffs the
built `index.json` ids (section 6). Evidence goes in the PR, never in the annotation.
