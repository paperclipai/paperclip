# Lab anatomy

How a directions lab page is put together, with the artifact lab on master
(`ui/src/artifact-directions/`, merged as def4726be / PR #17213) as the worked
example. Every line number below was confirmed against this checkout.

Markers: **GENERIC** = copy and rename for any feature. **ARTIFACT-SPECIFIC** =
belongs to the artifact lab; redraw it per feature.

## Contents

1. Files and the page entry
2. State lives in the URL
3. Bootstrap: API stub, theme, animation
4. The DirectionKit contract
5. Kit discovery and the "how many directions" parameters
6. Toolbar
7. Slot scoping and theme idioms
8. Frames and surfaces
9. Parked-branch extras (not on master)
10. Capture flags

## 1. Files and the page entry

| Path (under `ui/` unless absolute) | Marker | Role |
|---|---|---|
| `artifact-directions.html` | GENERIC, rename | MPA entry, 38 lines |
| `vite.artifact-directions.config.mjs` | GENERIC, rename | lab-only Vite config, 129 lines |
| `src/artifact-directions/main.tsx` | GENERIC | bootstrap, `Lab`, providers |
| `lab-state.ts`, `lab-state.test.ts` | GENERIC; defaults are parameters | URL state |
| `kit.ts` | contract ARTIFACT-SPECIFIC; registry GENERIC in shape | `DirectionKit`, ids, loader |
| `lab.css` | GENERIC | `:root { --font-mono: var(--font-paper-mono); }` (8-10) |
| `api-stub.ts` | GENERIC; routes ARTIFACT-SPECIFIC | answers every `/api/` fetch |
| `fixtures.ts`, `fixture-documents.ts`, `assets/` | ARTIFACT-SPECIFIC | data the frames feed the slots |
| `frames/Slot.tsx`, `LabToolbar.tsx`, `Board.tsx` | GENERIC | scoping, lab chrome, overview |
| `frames/SurfaceView.tsx` | GENERIC shape, ARTIFACT-SPECIFIC content | `s=` to frame |
| `frames/AppShell.tsx` | GENERIC pattern with hard-coded data | sidebar + main column |
| `frames/ThreadFrame.tsx`, `PanelFrame.tsx`, `GalleryFrame.tsx`, `thread-parts.tsx`, `KindsSheet.tsx` | ARTIFACT-SPECIFIC | static mocks of product screens |
| `directions/<id>/index.tsx` | ARTIFACT-SPECIFIC | one kit per directory |
| `shot.cjs` | GENERIC; its `KITS`/`SURFACES` mirrors are per lab | Playwright capture |
| `/.claude/launch.json:27-44` | GENERIC, rename and pick free ports | dev :5180, build + preview :5190 |

Entry (`artifact-directions.html`): `<html>` is pre-set dark so the default theme never flashes (line 2). The inline `<style>` (9-32) is unlayered on purpose: `index.css` pins `body { height: 100%; overflow: hidden }` inside `@layer base` (index.css:717, 747-757), which would stop the page growing to the height of its frames, and only `<html>` may scroll, because a scrolling `<body>` becomes the sticky toolbar's scrollport. `#root` is line 35, the module script line 36. Line 2 is `<html lang="en" class="dark" style="color-scheme: dark">`.

```css
html {
  height: auto;
  min-height: 100%;
  overflow-y: auto;
}
body {
  height: auto;
  min-height: 100%;
  overflow: visible;
}
```

Vite config (`vite.artifact-directions.config.mjs`): `ENTRY` and `DEFAULT_PORT` (40-41); `PORT = portFromArgv() || Number(process.env.ARTIFACT_DIRECTIONS_PORT) || DEFAULT_PORT` (44-53; argv because a config cannot see resolved CLI options); `OUT_DIR` from `ARTIFACT_DIRECTIONS_OUT_DIR` else `dist-artifact-directions` (54-56, not git-ignored: build into `node_modules/` as launch.json:41 does, or add the directory to `.gitignore`); a polling watcher limited to the lab's paths (66-77, macOS FSEvents exhaustion otherwise kills HMR silently); `entryAsRoot`, a `configureServer` middleware that rewrites `/` and `/index.html` to `/${ENTRY}` keeping the query (79-90); `htmlAsIndex`, which renames the built entry to `index.html` in `closeBundle` (96-103). Three things are load-bearing: no `server.proxy`, `appType: "mpa"` plus the root rewrite, and a cache directory per port (28-37). Rename `ENTRY`, the env vars, the `cacheDir` prefix and the plugin names.

```js
export default defineConfig({
  appType: "mpa",
  plugins: [react(), tailwindcss(), entryAsRoot, htmlAsIndex],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  cacheDir: path.resolve(__dirname, `node_modules/.vite-artifact-directions-${PORT}`),
  server: {
    host: "127.0.0.1",
    port: PORT,
    strictPort: true,
    watch: { usePolling: true, interval: 250, ignored: outsideLab },
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    minify: "esbuild",
    rollupOptions: {
      input: path.resolve(__dirname, ENTRY),
    },
  },
});
```

## 2. State lives in the URL

Everything the toolbar can change is in `window.location.search`; React state only mirrors it. Schema (lab-state.ts:8): `?d=<DirectionId|all>&s=<thread|panel|gallery|stack|kinds|board>&theme=<dark|light>&chrome=<1|0>&anim=<1|0>`.

| Param | Allowed | Default | Notes |
|---|---|---|---|
| `d` | any `DIRECTION_IDS` entry, `all` | `d5-v1-mvp` with no `s`; `today` when `s` is set | `all` is the every-kit contact sheet, URL-only since 2026-10-21 |
| `s` | `LAB_VIEWS` = `[...SURFACE_IDS, "kinds", "board"]` | `board` with no `d` or `d=all`; `thread` for any other `d` | `kinds`, the vocabulary sheet, is URL-only |
| `theme` | `dark`, `light` | `dark` | anything else reads as dark |
| `chrome` | `1`, `0` | `1` | `0` hides the LabToolbar and nothing else (main.tsx:168) |
| `anim` | `1`, `0` | `1` | written only when off |

GENERIC: the types (18-29), validators built from the id arrays (31-33), a reader with defaults, a short-form serializer, and `kitIdOf` (57: `all` renders as `today` in any non-board view). The landing kit `"d5-v1-mvp"` and the asymmetric defaults are this lab's decision; set yours at lines 41-42. A generated lab reads them from `registry.landing` (`--landing`) and `SURFACE_IDS[0]`. A generated lab also reads and writes a sixth param, `proposal` (written only when `1`): it wraps the page in `AvatarInitialProvider` + `.design-proposal-theme` and has no toolbar control; `today-fixtures-and-build.md` §12 and `generator.md` give the generated form.

```ts
export function readLabState(search: string): LabState {
  const params = new URLSearchParams(search);
  const d = params.get("d");
  const s = params.get("s");
  return {
    // A bare URL opens V1 MVP's overview: it is what the shared link should land on.
    direction: d === "all" ? "all" : isDirection(d) ? d : s ? "today" : "d5-v1-mvp",
    view: isView(s) ? s : d && d !== "all" ? "thread" : "board",
    theme: params.get("theme") === "light" ? "light" : "dark",
    chrome: params.get("chrome") !== "0",
    anim: params.get("anim") !== "0",
  };
}

export function labSearch(state: LabState): string {
  const params = new URLSearchParams({ d: state.direction, s: state.view, theme: state.theme });
  if (!state.chrome) params.set("chrome", "0");
  if (!state.anim) params.set("anim", "0");
  return `?${params.toString()}`;
}
```

Write-back: `change(patch)` in `Lab` (main.tsx:138-148) merges the patch and replaces the URL, after `keepScroll()` so the viewport stays put across a toggle (`useScrollKeeper`, 108-130: restore now, next frame, and at +200 ms). No navigation, no reload.

```ts
      setState((current) => {
        const next = { ...current, ...patch };
        window.history.replaceState(null, "", labSearch(next));
        return next;
      });
```

`lab-state.test.ts` (54 lines, 10 tests) pins the defaults, the fallbacks for unknown `d`/`s`, the short form and round-trips. `new` writes one per lab against the registry's landing; run it with `cd ui && npx vitest run src/<slug>-directions/lab-state.test.ts`.

## 3. Bootstrap: API stub, theme, animation (`main.tsx`)

Module-load order (25-41): install the fetch stub, read the URL, apply theme and animation to `<html>` before React mounts.

```ts
installApiStub();

const initial = readLabState(window.location.search);

function applyTheme(theme: LabTheme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}
applyTheme(initial.theme);

function applyAnim(anim: boolean) {
  if (anim) document.documentElement.dataset.labAnim = "1";
  else delete document.documentElement.dataset.labAnim;
}
applyAnim(initial.anim);
```

- Theme: `.dark` on `<html>` is what `index.css`'s `.dark {}` block (591, top-level and unlayered) and Tailwind's `@custom-variant dark (&:is(.dark *))` (134) key on; `style.colorScheme` keeps native controls and scrollbars in step. `ThemeSync` (44-50) pushes the URL theme into the app's `ThemeProvider` so `useTheme()` consumers agree. The comment at main.tsx:29 cites `index.css:393`; the block is at 591. `ThemeProvider.setTheme` persists to the app's `paperclip.theme` localStorage key, harmless on the lab's own origin.
- Animation: `data-lab-anim="1"` on `<html>` is the only signal; kits opt in with CSS (section 7). Both toggles are re-applied in effects on state change (150-151).
- API stub (`api-stub.ts`): every `/api/` fetch is answered locally and never reaches the network. `registerApiRoute((pathname, method) => body | undefined)` adds routes (18-20); built-ins answer `*/auth/get-session` and `*/companies` (30-33); anything else returns `{}` with a `console.debug` (34-37), so a frame can look empty without an error. `installApiStub()` is reference-counted and returns a restore (50-71) for Storybook. The routes a Today kit needs are ARTIFACT-SPECIFIC (`directions/today/panel-api.ts`).
- Containment: `useKit` loads a kit lazily and keeps the previous one mounted while the next loads (82-98); `KitBoundary`, keyed by `shownKitId`, shows a render error in place (56-73, 174). Providers (182-198): `StrictMode > MemoryRouter > QueryClientProvider({ retry: false, refetchOnWindowFocus: false }) > ThemeProvider > CompanyProvider > TooltipProvider > Lab`. CSS imports are `../index.css` then `./lab.css` (8-9); lab.css wins because it is unlayered, not because of order.

## 4. The DirectionKit contract (`kit.ts:99-127`)

A direction is one directory `directions/<id>/` whose `index.tsx` exports `kit: DirectionKit`. A kit never renders chrome and never imports a frame (kit.ts:6-9), so a direction can be rewritten wholesale without touching a shared file.

- Metadata, GENERIC: `id: DirectionId`, `name`, `tagline` (100-102); `name`/`tagline` repeat `KIT_META`.
- Required slots, ARTIFACT-SPECIFIC: `ThreadWorkProduct: FC<{ artifact: LabArtifact }>`, `ThreadAttachments: FC<{ artifacts: LabArtifact[] }>`, `PanelBody: FC<{ artifacts: LabArtifact[] }>`, `GalleryStacks: FC<{ groups: LabGroup[] }>`, `GalleryStack: FC<{ group: LabGroup }>` (104-112). Each JSDoc names the surface and what the frame fixes around the slot ("the pane is 434px wide; the body has 16px of padding").
- Optional overrides, pattern GENERIC and names ARTIFACT-SPECIFIC: `GalleryView?: FC<{ groups; open }>` when a kit owns a whole region including chrome the frame normally mocks (119); `threadAttachmentsAfterFooter?: boolean` when a kit only moves where a slot renders (126). A frame checks `kit.X ? <kit.X /> : fallback` (GalleryFrame.tsx:103-113; ThreadFrame.tsx:119, 123).

Slots are typed per surface because a slot's props are the data that place receives in the product and the frame fixes that place's width and position. The frame mounts `<kit.PanelBody artifacts={…} />` without knowing the kit, TypeScript flags a kit that misses a surface, and the constraints of each place live in one JSDoc. For a new lab: one slot per place the feature appears, props = the fixture type that place receives, fixture types beside the contract in `kit.ts` (`LabArtifact`, `LabGroup`, `LabRun`, `LabKind` at 18-97 are ARTIFACT-SPECIFIC).

Kit module shape: `directions/today/index.tsx:1-17` is the production baseline (shipped components, no tokens.css); an exploration adds `import "./tokens.css"` (d1-solid/index.tsx:6, d5-v1-mvp/index.tsx:5) and the optional members (d5-v1-mvp/index.tsx:44, 46).

## 5. Kit discovery and the "how many directions" parameters

Kits are found by a literal glob and loaded on demand, so a half-written kit cannot take the others down (kit.ts:152-163). Keep the glob string literal; Vite needs a static pattern.

```ts
const KIT_LOADERS = import.meta.glob<{ kit: DirectionKit }>("./directions/*/index.tsx");

export function loadKit(id: DirectionId): Promise<DirectionKit> {
  const load = KIT_LOADERS[`./directions/${id}/index.tsx`];
  if (!load) return Promise.reject(new Error(`No kit at directions/${id}/index.tsx`));
  return load().then((module) => module.kit);
}
```

Id convention: `today` for the shipped baseline, `d<N>-<slug>` for exploration N (`d1-solid` … `d5-v1-mvp`). Directory name = id = `DirectionId` member (16); `DIRECTION_IDS` is `["d1-solid", "d2-tint", "d3-tactile", "d4-hybrid", "d5-v1-mvp", "today"]` (130).

Adding or removing a direction touches exactly these (in `kit.ts` unless noted):

1. The `DirectionId` union (16).
2. `DIRECTION_IDS` (130): toolbar order, explorations in numeric order, **Today last** (comment 129).
3. `KIT_KEYS` (133-140): the digit in the label, `today: "0"`. One digit per kit, so at most ten kits.
4. `KIT_META` (143-150): `name` in the form `"N.Name"` (`"0.Today"`, `"1.Solid"`, `"5.MVP V1"`) plus a tagline; the toolbar label and hint come from here.
5. `directions/<id>/index.tsx` exporting `kit` with the same `id`, `name` and `tagline`.
6. The landing kit in `readLabState` (lab-state.ts:41) and the test expectations (lab-state.test.ts:6, 10, 14, 23-24, 35, 43, 51-52).
7. The toolbar footer hint `0–5 kit · t theme · a animation` (LabToolbar.tsx:100) and the Animation "on" hint, which names a kit (70).
8. `shot.cjs` mirrors `KITS` (22) and `KIT_NAMES` (154); CJS cannot import kit.ts. `KITS` lists Today first while `DIRECTION_IDS` puts it last, so choose the order deliberately. An unknown kit fails with `Unknown --d` (224).

In a generated lab 1–4 are one `registry.ts` line (`kit.ts` derives the ids and maps from it) and 8 falls away (`shot.cjs` reads `window.__LAB__`); `scaffold.mjs add-direction --slug <slug> --name <Name>` writes that line, the kit directory and the `D<N>` story export, then runs `check`. Still by hand: 6 (`registry.landing` and the lab's tests); 7 is derived at run time (`LEGEND` in `frames/LabToolbar.tsx` takes the largest digit in `KIT_KEYS`). Renaming a direction has no subcommand: the directory, the registry `id`/`name`, `kit.id`, `[data-direction="<id>"]` and the `--<p>-` prefix in `tokens.css`.

## 6. Toolbar (`frames/LabToolbar.tsx`)

GENERIC apart from the two row titles and the option labels. Deliberately not the product's look (monospace, `text-(length:--text-micro)`, sticky), one grid with `max-content 1fr` columns so both row labels sit flush left and both option sets start on the same column (75-79).

- Row 1: label `Artifact directions`; the Kit segmented control, options from `DIRECTION_IDS` with label `KIT_META[id].name` and hint `${tagline} (${KIT_KEYS[id]})` (51-55); then, right-aligned by `ml-auto`, Theme (`dark` | `light`, hint "Toggle with t", 64-67) and the word `animation` with the Animation control (`off` | `on`, 68-71).
- Row 2: label `Artifact surfaces`; the Surface segmented control, `VIEW_OPTIONS` in display order Overview (`board`) first, then `Task-thread`, `Right-panel`, `Tab-gallery`, `Tab-closeup` (57-63); right-aligned hint `0–5 kit · t theme · a animation`, hidden below `lg` (100).
- `Segmented` (16-48): `role="radiogroup"` with `role="radio"` buttons, `aria-checked`, `title={hint}`; selected = `bg-background text-foreground shadow-xs`.
- `VIEW_OPTIONS` is a hand-maintained literal. `LAB_VIEWS` is imported (3) but unused; it only validates `s=` in lab-state.ts:33. `KIT_OPTIONS` is typed `Option<DirectionId | "all">[]` with no `all` entry, so under `?d=all` no radio is checked.

```tsx
export function LabToolbar({ state, onChange }: { state: LabState; onChange: (patch: Partial<LabState>) => void }) {
  return (
    <div
      className="sticky top-0 z-50 grid items-center gap-x-4 gap-y-2 border-b border-border bg-background px-4 py-2 font-mono text-(length:--text-micro) text-muted-foreground"
      style={{ gridTemplateColumns: "max-content 1fr" }}
    >
      <span className={TITLE}>Artifact directions</span>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented label="Kit" options={KIT_OPTIONS} value={state.direction} onChange={(direction) => onChange({ direction })} />
        <div className="ml-auto flex items-center gap-4">
          <Segmented label="Theme" options={THEME_OPTIONS} value={state.theme} onChange={(theme) => onChange({ theme })} />
          <span className="flex items-center gap-1.5">
            <span>animation</span>
            <Segmented label="Animation" options={ANIM_OPTIONS} value={state.anim ? "on" : "off"} onChange={(value) => onChange({ anim: value === "on" })} />
          </span>
        </div>
      </div>
      <span className={TITLE}>Artifact surfaces</span>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented label="Surface" options={VIEW_OPTIONS} value={state.view} onChange={(view) => onChange({ view })} />
        <span className="ml-auto hidden lg:inline">0–5 kit · t theme · a animation</span>
      </div>
    </div>
  );
}
```

Keyboard shortcuts (main.tsx:153-163): `t` toggles theme, `a` toggles animation, a digit selects the kit whose `KIT_KEYS` entry matches; ignored with meta/ctrl/alt or while typing (`isTyping`, 52-54). `event.key` is compared case-sensitively (Shift+T does nothing); the numpad works.

```ts
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "t") change({ theme: state.theme === "dark" ? "light" : "dark" });
      if (event.key === "a") change({ anim: !state.anim });
      const direction = DIRECTION_IDS.find((id) => KIT_KEYS[id] === event.key);
      if (direction) change({ direction });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [change, state.theme, state.anim]);
```

## 7. Slot scoping and theme idioms

Every kit slot renders inside `Slot` (frames/Slot.tsx:8-14), which stamps `data-direction={kit.id}`; a kit's `tokens.css` scopes everything to `[data-direction="<id>"]`, so two kits' tokens never collide and a kit never leaks into the frame. The only `Slot` given a `className` is the thread attachments block, `flex w-full flex-col gap-1` (ThreadFrame.tsx:75, KindsSheet.tsx:71).

```tsx
export function Slot({ kit, className, children }: { kit: DirectionKit; className?: string; children: ReactNode }) {
  return (
    <div data-direction={kit.id} className={className}>
      {children}
    </div>
  );
}
```

Two light/dark idioms coexist on master:

- `.dark [data-direction="<id>"] { … }`: light values in the base block, dark overrides after (d1-solid/tokens.css:90, d2-tint:95, d3-tactile:184, d4-hybrid:105).
- `html:not(.dark) [data-direction="<id>"] { … }`: dark values in the base block, light overrides after (d5-v1-mvp/tokens.css:56; its values were measured from a dark mock).

Use the first. It matches `index.css` (light at `:root`, dark in `.dark {}` at 591), four of five kits use it, it reads as an override, and the generator's `tokens.css` template writes it. Both work because `.dark {}` is top-level and unlayered, so a kit rule in the same layer wins on specificity (`@layer base` only opens at 717).

Animation opt-in, the V1 MVP values to carry over (d5-v1-mvp/tokens.css:68-97, under the comment at 67; the skill keeps them as `assets/motion/v1-mvp-motion.css`, which `new` and `add-direction` append to every exploration's `tokens.css`): a resting transform `[data-direction="<id>"] [data-rotate] { transform: rotate(var(--v1-base, 0deg)); }` (68-70); one shared curve on the scope, `--v1-hover-ease: 300ms cubic-bezier(0.3, 0, 0.1, 1)` (80-82); every moving rule under `@media (prefers-reduced-motion: no-preference) { html[data-lab-anim="1"] [data-direction="<id>"] … }` (84-97): `button:hover [data-front] { transform: translateY(-6px); }`, `[data-spread="left"]` turns `+5deg` and `"right"` `-5deg` from `--v1-base`. Colour hovers stay outside the gate so captures are stable. On master only d5 reacts to the toggle; the other kits ignore it.

## 8. Frames and surfaces

A frame is a static, behaviour-free mock of the product chrome around one place the feature appears; the kit supplies only the slot. Frames copy the product's class strings and cite the source file and line inline. One deliberate difference from the product: nothing scrolls internally. `AppShell` uses `min-h-225` (900px) where `Layout.tsx:583` uses `h-dvh`, `PanelFrame` renders the pane body as a plain `p-4` div (63-67), `ComposerShell` is not sticky, so the page grows and a full-page capture (and the Board's height measurement) sees everything.

Fixed widths and where they come from. Re-derive these; three frame comments have already drifted.

| Frozen in the frame | Value | Product source |
|---|---|---|
| `AppShell.tsx:100` `w-60` | 240px | `components/SidebarShell.tsx:16` `DEFAULT_SIDEBAR_WIDTH = 240` (resizable 208–420 at 17-19; the frame freezes the default; the frame comment says :15) |
| top bars `h-(--sz-60px)` (ThreadFrame.tsx:24, GalleryFrame.tsx:22, AppShell.tsx:102) | 60px | `index.css:2866` |
| `ThreadFrame.tsx:86` `max-w-(--tc-shell-max-w)` | 960px | `index.css:575` `--tc-shell-max-w: 60rem` |
| `PanelFrame.tsx:19` `TASK_DETAIL_PANE_WIDTH = 434` | 434px | `components/PropertiesPanel.tsx:88` `TASK_DETAIL_DEFAULT_PANE_WIDTH` (the frame comment says :85) |
| `GalleryFrame.tsx:102` `max-w-6xl` | 1152px | `pages/Artifacts.tsx:248` (the frame comment says :249) |
| `KindsSheet.tsx:14` `THREAD_COLUMN_WIDTH = 835` | 835px | measured from reference screenshots, beside an open pane |
| `Board.tsx:12-13` `FRAME_WIDTH`, `FRAME_MIN_HEIGHT` | 1440 × 900 | the viewport every surface is designed against |

Shipped components the frames reuse (everything else is hand-drawn): `AppShell` reuses `Avatar`, `AvatarFallback`, `cn` and lucide icons; `ThreadFrame` reuses `StatusIcon` and `Breadcrumb*`, `thread-parts` only `StatusIcon`; `PanelFrame` reuses `SidePanelFrame`, `SidePanelWindowControls`, `SidePanelTabs`, `SidePanelTabItem` and `Button` (`presentation="docked" contentMode="full-bleed" headerSize="task-detail" className="flex-1 border-l-0"`, 33-37; `border-l-0` because docked adds its own left border, `side-panel/SidePanelFrame.tsx:53`); `GalleryFrame` reuses `Breadcrumb*`, `Button`, `Input`, `cn`. `AppShell` is a GENERIC pattern with ARTIFACT-SPECIFIC data baked in: `COMPANY`/`TASKS` (22, 60, 111), the `A` badge (109), the `TO` avatar and e-mail (144, 146), and `ShellNav = "tasks" | "artifacts"` (33) tied to the WORK entries (48, 51).

`SurfaceView` (frames/SurfaceView.tsx) maps `s=` to a frame. `SurfaceId = "thread" | "panel" | "gallery" | "stack"` (9), `SURFACE_IDS` (11). `gallery`/`stack` render `<AppShell nav="artifacts"><GalleryFrame kit groups={GROUPS} open={surface === "stack" ? OPEN_GROUP : null} /></AppShell>` (14-20); `thread`/`panel` render `<AppShell nav="tasks">` with a `streamlined-task-detail-surface` row (`Layout.tsx:676`) holding `ThreadFrame` and, for `panel`, `PanelFrame` (21-29). Fixtures are imported by the frame, not passed from main (2). `main.tsx:169-177` routes `board` to `Board`, `kinds` to `KindsSheet`, everything else to `SurfaceView`.

`chrome=0` removes the toolbar and nothing else (main.tsx:168); theme and animation come from the URL regardless, so an iframe or a capture shows the exact view.

Board (frames/Board.tsx, GENERIC mechanism): the overview is not a second implementation. Each `Tile` (26-75) is this same page in a same-origin `<iframe src={labSearch({ …, chrome: false })}>` (54), laid out at 1440px and CSS-scaled to its column (ResizeObserver, 32-38); the height is measured from the framed `#root` (44-52) because the framed document's height follows the iframe's own; the wrapping `<a href={labSearch({ …, chrome: true })}>` (59) opens the full view. The iframe is `pointer-events-none`, `tabIndex={-1}`, `scrolling="no"` (67-70), so a tile never receives hover: hover motion cannot be judged on the Board, open the tile instead. `KitBoard` hard-codes the four views and `grid grid-cols-4` (83, 85) with `maxHeight` 1800 (89); `AllBoard` hard-codes `7rem repeat(3, minmax(0, 1fr))`, three column heads and the gallery + stack pairing (99-115). `d=all` is 6 kits × 4 = 24 live iframes; view it from the static build (launch entry `artifact-directions`, :5190) or let `shot.cjs` compose it from PNGs (`captureBoard`, 162-200).

A kit flag honoured by a frame (ThreadFrame.tsx:119-123): the attachments block is built once (74-78) and placed inside the bubble or 12px under the footer.

```tsx
              {kit.threadAttachmentsAfterFooter ? null : attachments}
              <MessageFooter timestamp="11:08 AM" />
            </Bubble>
            {/* A kit may hang the block under the footer instead, 12px below it (the V1 mock does). */}
            {kit.threadAttachmentsAfterFooter ? <div className="mt-3">{attachments}</div> : null}
```

`KindsSheet` honours neither override: it always calls `GalleryStack`/`GalleryStacks` and renders `ThreadAttachments` standalone (71-73, 89-98), so a kit with `GalleryView` must still provide both.

Adding or removing a surface. Nothing derives automatically except `LabView`/`LAB_VIEWS` (lab-state.ts:18, 21):

1. `SurfaceId` and `SURFACE_IDS` (SurfaceView.tsx:9, 11) and the switch (13-31), with a frame and its fixtures.
2. The `VIEW_OPTIONS` label (LabToolbar.tsx:57-63) and the Overview hint (58).
3. `Board.tsx`: the `KitBoard` views literal and `grid-cols-N` (83, 85); the `AllBoard` template columns, heads and pairing (99-115).
4. `shot.cjs`: `SURFACES` (23), `BOARD_SURFACES` (153), the sheet's columns and crops (177-179, 184, 189).
5. A `KindsSheet` unit, if the lab keeps a vocabulary sheet.
6. A kit slot per new surface (section 4) in every kit, Today included.

A generated lab has no `add-surface`: add the `registry.surfaces` line, then by hand `frames/<Pascal>Frame.tsx` and its `FRAMES` entry (SurfaceView.tsx), the `SurfaceData` and `DirectionKit` members (kit.ts), `<UPPER>_ITEMS` (fixtures.ts), for a lab scaffolded with one surface row 2 (LabToolbar.tsx), a `<Pascal>Body.tsx` in every kit and a `today.test.tsx` case; `SURFACE_IDS`, `LAB_VIEWS`, the toolbar's `VIEW_OPTIONS`, Overview hint and legend, the Board and `shot.cjs` derive from the registry.

Single-surface lab: drop row 2, the `Artifact surfaces` label and the Surface `Segmented` (LabToolbar.tsx:97-101), and move the shortcut hint into row 1. Keep the `s=` parameter with two values, `board` and the surface, so Board tiles and `shot.cjs` can still address the surface by URL. With one view `KitBoard` is a single column; the every-direction grid (`AllBoard`'s shape, one row per kit) is the more useful overview.

## 9. Parked-branch extras (not on master)

Branch `claude/artifact-lab-new-surfaces` (one commit, ec6bab4c1) adds surfaces that only some kits draw. Read it with `git show claude/artifact-lab-new-surfaces:ui/src/artifact-directions/<path>`. The optional pattern:

- Two optional slots, `MediaPreview?: FC<{ items; index; onClose }>` and `PanelCloseup?: FC<{ document }>` (parked kit.ts:134, 139), with `KITS_WITH_EXTRAS = ["d5-v1-mvp", "today"]` and `kitHasExtras(id)` (143-144); both kits' `index.tsx` add the two members.
- `SurfaceId` gains `media` | `closeup`, with `EXTRA_SURFACE_IDS`/`isExtraSurface` (parked SurfaceView.tsx:15-19); `viewFor(direction, view)` redirects an extra surface to `board` for a kit that does not draw it, applied in both `readLabState` and `change()` (parked lab-state.ts:37-48, main.tsx:139-150).
- Toolbar options gain `disabled` and an `EXTRAS_HINT`; `frames/NotDrawn.tsx:1-15` renders `{kit.name} does not draw the {surface}; {who} do.` in place of a missing slot (`floating` for the overlay); `frames/LabNavigation.ts:1-10` is a `LabNavigationContext` so an overlay's close can call the toolbar's `change`.
- `KitBoard` lists six views for a kit with extras while the grid stays `grid-cols-4`, so the extras wrap.

Take `api-stub.ts`, `lab.css`, `d5-v1-mvp/kinds.ts` and `tokens.css` from master, not from this branch; the parked copies are pre-merge.

## 10. Capture flags (`shot.cjs`)

Captures load the lab with `chrome=0` and never pass `anim`, so the lab's default (on) applies; stills are motion-free because the Playwright context asks for reduced motion, which the kit's `@media` gate honours (121-125, 143). Any console error, page error, failed request or HTTP ≥ 400 fails the capture (130-141). Defaults: `--d today` (223), every `SURFACES` entry (23, 33), both themes (24, 34). The page URL is `` `${base}/?d=${shot.kit}&s=${shot.surface}&theme=${shot.theme}&chrome=0` `` (143). A generated `shot.cjs` takes its kits and surfaces from `window.__LAB__` and adds `--hover`, a rest/hover pair per surface from a second context without reduced motion.

```js
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
```
