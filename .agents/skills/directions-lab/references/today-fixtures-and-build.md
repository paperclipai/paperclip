# Today, fixtures, build, run, capture, deploy

Reference for scaffolding a new directions lab. Worked example: the artifact lab at `ui/src/artifact-directions/` with entry `ui/artifact-directions.html` and config `ui/vite.artifact-directions.config.mjs`. Line numbers were confirmed against this checkout on 2026-10-24; cite symbols, not lines, in generated code. Tags: **GENERIC** = copy for any feature; **ARTIFACT-SPECIFIC** = redraw per feature.

## Contents

1. Today kit: the production control
2. Adapters: lab fixtures to product types
3. API stub
4. Fixture world
5. HTML entry and what main.tsx mounts
6. Lab Vite config, option by option
7. launch.json: two entries
8. Product build, tsc, vitest, token gates
9. Tests the lab carries
10. shot.cjs: capture
11. Vercel deploy
12. What a generator parameterizes

## 1. Today kit: the production control

**GENERIC.** The Today kit renders the shipped product components on the lab's fixtures, so every other direction is judged against what ships. Rules:

- One directory `directions/today/` whose `index.tsx` exports `kit: DirectionKit` (`ui/src/artifact-directions/directions/today/index.tsx:8-17`). A kit never renders chrome and never imports a frame (`ui/src/artifact-directions/kit.ts:3-14`).
- One component file per slot. Mount the shipped component when it is a standalone export. When the product markup is inline JSX inside a larger component, copy that JSX minus handlers, import the real primitives and helpers, and say so in the file header, naming the branch copied (`directions/today/ThreadAttachments.tsx:17-23` mirrors the `!artifactsV1` blocks at `ui/src/components/task-chat/TaskChatBubble.tsx:277,320`; V1 renders a different combined block at `:436`).
- Reproduce product layout constants by value and cite the string, not a line (`directions/today/Gallery.tsx:7` carries `grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3`, found once at `ui/src/pages/Artifacts.tsx:317`; the file's own comment cites a stale line).
- Register the id in `DirectionId`, `DIRECTION_IDS`, `KIT_KEYS` and `KIT_META` (`kit.ts:16,130,133-140,143-150`). The toolbar and board read `KIT_META`; the kit's own `name`/`tagline` are read only by the kinds sheet (`frames/KindsSheet.tsx:47-48`). Keeping them equal is a convention (`kit.ts:142`), not a check. A generated lab registers once, as one line in `registry.ts`: its `kit.ts` derives `DirectionId`, `DIRECTION_IDS`, `KIT_KEYS` and `KIT_META` from the registry, and `registry.test.ts` fails when a kit's `id`, `name` or `tagline` differs from the registry's (`scaffold.mjs check` compares `id` and `name`).

Kit discovery (`kit.ts:157-163`), **GENERIC** verbatim:

```ts
const KIT_LOADERS = import.meta.glob<{ kit: DirectionKit }>("./directions/*/index.tsx");

export function loadKit(id: DirectionId): Promise<DirectionKit> {
  const load = KIT_LOADERS[`./directions/${id}/index.tsx`];
  if (!load) return Promise.reject(new Error(`No kit at directions/${id}/index.tsx`));
  return load().then((module) => module.kit);
}
```

**ARTIFACT-SPECIFIC**, what the artifact Today kit mounts:

- `GalleryStacks` / `GalleryStack`: `ArtifactGroupCard` and `ArtifactCard` on the product grid (`Gallery.tsx:10-34`).
- `PanelBody`: the real `IssuePropertiesArtifactsTab`, given `{ id: registerPanel(artifacts), companyId: COMPANY.id } as Issue` and `onOpenDocument={noop}` (`PanelBody.tsx:14-19`). The tab reads only `issue.id` and `issue.companyId`; the product also passes `uploadState` (`ui/src/components/task-side-panel/TaskSidePanel.tsx:770`), which Today omits.
- `ThreadWorkProduct`: a task document becomes a `TaskChatProtocolCard` resource item with ``subtitle: `Document · rev ${artifact.revision}` ``; anything else becomes `RichWorkProductCard` with `workProductHref(workProduct)` (`ThreadWorkProduct.tsx:13-31`; the product split is `ui/src/components/TaskChatThread.tsx:1290-1312`).
- `ThreadAttachments`: mirrored; uses `@/components/ui/attachment`, `ArtifactPreview`, `fileKindForAttachment`, `formatFileSize`, `isImageAttachment`, `isVideoLikeOutput` (`ThreadAttachments.tsx:1-15`).

**GENERIC**, flag-gated components. Before mounting, grep the feature's flag hook under `ui/src/components` and `ui/src/pages`. For artifacts, `useArtifactsV1Enabled()` is called at `IssuePropertiesArtifactsTab.tsx:414`, `TaskChatBubble.tsx:149`, `TaskChatProtocolCard.tsx:1045` and in `pages/Artifacts.tsx`; it resolves `settings?.enableArtifactsV1 === true` (`ui/src/hooks/useArtifactsV1Enabled.ts:7-9`) from `GET /api/instance/settings/experimental` (`ui/src/api/instanceSettings.ts:20-21`). The artifact stub has no route for it, answers `{}`, and the flag is false: Today's panel and its task-document thread row render the flag-OFF presentation (the generic card from `TaskChatProtocolCard.tsx:1072`), while `ArtifactCard`, `ArtifactGroupCard` and `RichWorkProductCard` are flag-independent. To show a flagged presentation under Today, register a route returning `{ enableArtifactsV1: true }` for that pathname. A generated lab already has that route: `api-routes.ts` answers any pathname ending `/instance/settings/experimental` with `registry.today.flags` (`{}` as scaffolded), so set the flag in `registry.ts` (`today: { flags: { enableArtifactsV1: true } }`) or at run time with `setLabFlags`.

## 2. Adapters: lab fixtures to product types

**GENERIC pattern** (`directions/today/adapters.ts`): pure functions `LabRecord -> product type`, one per prop type the mounted components take, each mirroring what the server would produce. Pin the base object with `} satisfies Partial<IssueWorkProduct>;` (`adapters.ts:64`) so field drift against `@paperclipai/shared` fails typecheck. Deterministic ids, verbatim (`adapters.ts:14-25`):

```ts
export function guid(seed: string): string {
  let h = 0x811c9dc5;
  let hex = "";
  for (let round = 0; hex.length < 32; round += 1) {
    for (const char of `${seed}:${round}`) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193);
    hex += (h >>> 0).toString(16).padStart(8, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const agentId = (name: string) => guid(`agent:${name}`);
export const issueIdFor = (taskIdentifier: string) => guid(`issue:${taskIdentifier}`);
```

Seed conventions: `agent:<name>`, `issue:<identifier>`, `<entity>:<fixture id>` (`attachment:`, `work-product:`, `document:`, `revision:` at `adapters.ts:39,48,89,95`), `panel:<comma-joined ids>` (`panel-api.ts:18`). Product hrefs use `COMPANY.issuePrefix` (`adapters.ts:172,187,202`). The scaffold's `adapters.ts` carries `guid`, `agentId` and `issueIdFor` verbatim plus `issueHref(taskIdentifier)`; every other adapter is drawn by hand.

**ARTIFACT-SPECIFIC:** `isTaskDocument` (`:28`); `attachmentPaths`, which points media at bundled asset URLs (`:38-44`; the product's canonical-path test at `ui/src/components/task-chat/RichWorkProductCard.tsx:231` then only hides "Open in tab"); `toWorkProduct` (`:46-84`); `toIssueDocument` (`:86-108`); `toAttachmentRef` (`:113-124`); the hand-copied `previewText` (280 chars, `:127-137`) and `mediaKind` (`:143-150`) mirrors of `server/src/services/company-artifacts.ts:89-121`; `toCompanyArtifact` (`:152-189`); `toCompanyArtifactGroup` (`:191-204`). Mirrors drift (the server returns `null` for an empty preview, strips backticks differently and lowercases content types); re-read the server before relying on exact text. The plan doc fixes the direction of reuse: product code reuses the lab's code, not its types; the lab keeps its own copies (`doc/plans/2026-10-22-artifacts-mvp-v1.md:28-32`).

## 3. API stub

**GENERIC verbatim, except the two fallbacks.** `ui/src/artifact-directions/api-stub.ts` replaces `window.fetch`. No module mocks are needed because `ui/src/api/client.ts:54` calls the global ``fetch(`${BASE}${path}`, ...)`` at call time with `const BASE = "/api"` (`:5`), so every react-query `queryFn` is intercepted.

- `registerApiRoute(route)` pushes an `ApiRoute = (pathname, method) => unknown | undefined` (`:14-20`). `respond()` tries routes in registration order; the first body `!== undefined` is returned as JSON 200 (`:25-29`).
- Built-in fallbacks (`:30-33`): a pathname ending `/auth/get-session` answers a lab session and user; one ending `/companies` answers `[COMPANY]`. They satisfy `sessionQueryOptions` and `companyListQueryOptions` (`ui/src/api/companies-query.ts:55-59,19-40`); `CompanyProvider` then selects `selectableCompanies[0]?.id` (`ui/src/context/CompanyContext.tsx:81`). Keep both; swap `COMPANY`.
- Any other `/api/` path answers `{}` with status 200 after `console.debug("[artifact-directions] unhandled", method, pathname)` (`:36-37`; a generated lab logs `[<slug>-directions] unhandled`). Never a 4xx, so a missing route never breaks a frame and never trips the HTTP gate in shot.cjs. Read that debug line to find the routes a new Today kit must register.
- Matching is pathname-only: `new URL(url, window.location.origin).pathname` (`:58`). `/companies?scope=accessible` (`ui/src/api/companies.ts:28`) collapses to `/api/companies`; routes must not include query strings. A URL without `/api/` passes through (fonts, assets).

Installation, verbatim (`api-stub.ts:40-42,50-71`):

```ts
let holders = 0;
let realFetch: typeof window.fetch | null = null;
let stubFetch: typeof window.fetch | null = null;

export function installApiStub(): () => void {
  if (holders === 0) {
    const original = window.fetch;
    const real = original.bind(window);
    realFetch = original;
    stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("/api/")) return real(input as RequestInfo, init);
      const { pathname } = new URL(url, window.location.origin);
      return respond(pathname, (init?.method ?? "GET").toUpperCase());
    }) as typeof window.fetch;
    window.fetch = stubFetch;
  }
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0 && realFetch && window.fetch === stubFetch) window.fetch = realFetch;
  };
}
```

Installs are refcounted; each restore is idempotent; the last release restores only if nothing else replaced `fetch` meanwhile. The page installs once at module top, before `createRoot` (`main.tsx:25`); a Storybook story installs on mount and calls the restore on unmount.

**GENERIC pattern with ARTIFACT-SPECIFIC routes**: the per-kit `<thing>-api.ts` (`directions/today/panel-api.ts`); in a generated lab the same code goes in the lab-root `api-routes.ts`, inside its empty `registerFeatureRoutes()`, next to the experimental-settings route it already registers, and `main.tsx`, the story and `today.test.tsx` import that module. Module-level `Map` keyed by a minted id (`:13-14`); `registerPanel(list): id`, called inside the slot's `useMemo` and passed as the product entity id (`:17-25`, `PanelBody.tsx:16`); `registerApiRoute(...)` at module import time so routes go live when the kit loads (`:75-90`). Find the routes to answer by grepping the mounted component for `useQuery`/`queryFn` and following each api module to its path string. The artifact tab issues (`IssuePropertiesArtifactsTab.tsx:414-443`): `GET /api/issues/:id/attachments`; `/work-products` through `useIssueWorkProducts` (`refetchOnMount: "always"`; its second `?refreshPullRequests=true` query runs only when a row has `type === "pull_request"`, `ui/src/hooks/useIssueWorkProducts.ts:10-25`); `/documents` with no `includeSystem` (`ui/src/hooks/useIssueDocuments.ts:13-19`); `/runs`; `GET /api/companies/:companyId/agents`; `/documents/:key/annotations` per expanded document (`ui/src/api/document-annotations.ts:30`); and the experimental-settings flag above. Canned bodies: creation times a minute apart from one anchor so list order survives the tab's sort (`panel-api.ts:32`); a review document per Markdown file (`:40-50`); runs deduped by id (`:52-67`); annotation placeholders sized by `commentCount` (`:69-73`). Gotchas: import-time registration means a test importing `PanelBody` without `panel-api` (or, generated, without `./api-routes`) gets `{}`; `registerPanel` ids are hashes of the list, so equal lists share an entry and the `agents` set is global across panels.

## 4. Fixture world

**GENERIC conventions** (`ui/src/artifact-directions/fixtures.ts`):

- Record types live with the slot contract in `kit.ts`, not with the data (`kit.ts:18-97`; `fixtures.ts:1` imports them).
- `COMPANY = { id, name, issuePrefix }`, a partial `Company` sufficient for the stub and hrefs (`fixtures.ts:22`); a product component reading other `Company` fields sees `undefined`.
- People as string constants plus an `AVATARS` map of imported SVGs (`:23-25`); `TASKS` declared `as const` with `type TaskId = keyof typeof TASKS` (`:27-35`).
- A `MIME` map keyed by extension (`:37`); en-US label helpers `dateTimeLabel`, `dateLabel`, `dayLabel`; a 1024-based `sizeLabel`; `plain(markdown)` for excerpts (`:37-76`).
- Factories: `interface Seed extends Partial<Omit<LabArtifact, "updatedAt" | "kind" | "title" | "id">> { at: string; task: TaskId }`; `artifact(id, kind, title, seed)` derives `ext`, `contentType`, `sizeLabel`, `excerpt`, the labels and `taskTitle` (`:85-109`); `taskDocument` (`:111-112`); `run` (`:78-83`); `group` (`:246-255`, where `artifacts[0]` drives the label, so lists are newest-first).
- Timestamps are zone-less local ISO strings pinned to one week (2026-09-24 to 09-28) so labels do not depend on the viewer's zone (`kit.ts:77`). Labels are precomputed strings, so a kit needs no clock unless it computes relative time.
- Long bodies in a sibling `fixture-documents.ts`, imported as `import * as docs` (`fixtures.ts:2`); media as URL imports from `assets/`, typed by `ui/src/vite-env.d.ts:1`.
- One export per slot or surface the frames render (`PANEL_ARTIFACTS`, `THREAD_ATTACHMENTS`, `THREAD_WORK_PRODUCTS` at `:162-173`; `GROUPS`, `OPEN_GROUP` at `:265-266`), plus `KIND_SPECIMENS` (one per kind in `LAB_KINDS` order, then a Markdown file and a `changes_requested` specimen: 12 entries, `:269-284`) and `STACK_SPECIMENS` (small, medium, large, `:295`).

**Clock.** `fixtures.ts` defines no `LAB_NOW`. `export const LAB_NOW = new Date("2026-09-28T18:00:00")` lives in `directions/d5-v1-mvp/when.ts:6`, and `panel-api.ts:32` has its own anchor `2026-09-28T12:00:00`. A generated lab's `fixtures.ts` exports `LAB_NOW = new Date("2026-09-28T18:00:00")`; derive every other anchor from it.

**ARTIFACT-SPECIFIC, and positional contracts to keep or edit:** the ten `LabKind`s, the acmehats world (44 records, 23 bodies, 12 assets); `frames/ThreadFrame.tsx:73` destructures `const [critique, guide, pptx, pdf, image, source] = THREAD_WORK_PRODUCTS;`; `frames/AppShell.tsx:60` and `ThreadFrame.tsx:37` index `TASKS["ACM-1"]`, `["ACM-2"]`, `["ACM-3"]`; `frames/SurfaceView.tsx:17,27` pass `GROUPS`/`OPEN_GROUP`/`PANEL_ARTIFACTS`; `frames/KindsSheet.tsx:16-23,55,72,81,96` feed `KIND_SPECIMENS`/`STACK_SPECIMENS` to every slot, so `registerPanel` mints a second id for a list holding a `link` and run-less records, which adapters must tolerate.

**A new feature's lab must define, and what the scaffold already gives it:** (1) its record types in `kit.ts`: the scaffold's `LabRecord` (`id`, `title`, `author`, `updatedAt`, `updatedLabel`), `SurfaceData` (one member per surface) and a `DirectionKit` with one `<Pascal>Body` slot per surface, to retype to the props each place receives; (2) `fixtures.ts`: the scaffold exports `COMPANY` and `TASKS` from `registry.shell`, `LAB_NOW`, and one `<UPPER>_ITEMS` array per surface holding three placeholder records; specimen arrays only if it keeps a kinds sheet, which the scaffold does not emit; (3) `directions/today/`: the scaffold's `adapters.ts` and one `<Pascal>Body.tsx` stub per surface (`data-lab-stub="today-<surface>"`), plus, by hand, exactly the routes its mounted components issue, in `api-routes.ts`; (4) registration: one `directions` line in `registry.ts`, from which `kit.ts` derives the rest.

## 5. HTML entry and what main.tsx mounts

**GENERIC verbatim** (`ui/artifact-directions.html`, 38 lines): `<html lang="en" class="dark" style="color-scheme: dark">` for a dark first paint (`:2`); `<title>`, `theme-color #18181b`, `/favicon.svg` from the default publicDir (`:6-8`); `<div id="root">` and `<script type="module" src="/src/artifact-directions/main.tsx">` (`:35-36`; the absolute `/src/...` path requires Vite root `ui/`). The only style block, unlayered (`:22-31`):

```html
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

It undoes `ui/src/index.css:747-757` inside `@layer base` (`html { height: 100% }`, `body { height: 100%; overflow: hidden }`), which would stop a full-page capture at the viewport. Only `<html>` scrolls: a scrolling body becomes the scrollport of the `sticky top-0 z-50` toolbar (`frames/LabToolbar.tsx:83`). Do not copy `ui/wizard-preview.html:16-21`, which applies the rule to `html, body` together and breaks the sticky toolbar.

**main.tsx** (`ui/src/artifact-directions/main.tsx`): `import "../index.css"` before `"./lab.css"` so tokens exist (`:8-9`); `installApiStub()` (`:25`); `readLabState(window.location.search)` (`:27`); theme and animation applied to `<html>` (`:30-41`), verbatim:

```ts
function applyTheme(theme: LabTheme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}
function applyAnim(anim: boolean) {
  if (anim) document.documentElement.dataset.labAnim = "1";
  else delete document.documentElement.dataset.labAnim;
}
```

Provider stack (`:182-198`): `StrictMode > MemoryRouter > QueryClientProvider` with `new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })` `> ThemeProvider > CompanyProvider > TooltipProvider > Lab`. A generated lab keeps the same stack in `providers.tsx` as `LabProviders` with `createLabQueryClient()`, so `today.test.tsx` renders Today under it; its `main.tsx` also imports `./api-routes` and sets `window.__LAB__` (directions, surfaces, keys, names, labels, story id, build) for `shot.cjs`. Frames wrap every slot in `<div data-direction={kit.id}>` (`frames/Slot.tsx:10`), which is what a kit's `tokens.css` scopes to. **GENERIC as emitted:** `lab.css` is only `:root { --font-mono: var(--font-paper-mono); }` (`lab.css:8-10`), and the scaffold writes the same rule for every lab.

## 6. Lab Vite config, option by option

`ui/vite.artifact-directions.config.mjs` (129 lines) is **GENERIC** except the slug-bearing identifiers and the default port. Never serve the lab through `ui/vite.config.ts`: it proxies `/api` to :3100 and boots the app at `/`.

- `root`: unset, so Vite's root is cwd. Run every lab command from `ui/`. `base`: unset (`/`), so the built page links `/assets/...` absolutely and the rename below cannot break them.
- Port and out dir (`:40-56`), verbatim:

```js
const ENTRY = "artifact-directions.html";
const DEFAULT_PORT = 5180;

function portFromArgv() {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port" && argv[i + 1]) return Number(argv[i + 1]);
    if (argv[i].startsWith("--port=")) return Number(argv[i].slice("--port=".length));
  }
  return null;
}

const PORT = portFromArgv() || Number(process.env.ARTIFACT_DIRECTIONS_PORT) || DEFAULT_PORT;
const OUT_DIR = process.env.ARTIFACT_DIRECTIONS_OUT_DIR
  ? path.resolve(process.env.ARTIFACT_DIRECTIONS_OUT_DIR)
  : path.resolve(__dirname, "dist-artifact-directions");
```

  A config cannot see resolved CLI options, hence argv. A relative env value resolves against cwd (`ui/`); the default resolves against the config's directory. `ui/dist-artifact-directions/` is not gitignored (`.gitignore:5-7` covers only `dist/`, `dist-preview/`, `dist-flow-preview/`): always set the env var; `scaffold.mjs new` adds `ui/dist-<slug>-directions/` to `.gitignore` after `dist-flow-preview/`, and `check` fails when that line is missing.
- Watcher (`:66-77`): `LAB_WATCH_PATHS = [src/<slug>, src/index.css, ENTRY]`; `outsideLab(p)` returns false for anything inside those paths and for their ancestor directories (`lab.startsWith(target + path.sep)`), true otherwise. Reason: macOS FSEvents exhaustion makes `fs.watch` fail with EMFILE and Vite's watcher goes silent; polling a few hundred lab files is cheap. Edits to product components, `ui/public` or other `src/` files do not reach the page; restart the server.
- Plugins (`:79-103`), verbatim:

```js
const entryAsRoot = {
  name: "artifact-directions-entry-as-root",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const [pathname, query] = (req.url || "").split("?");
      if (pathname === "/" || pathname === "/index.html") {
        req.url = `/${ENTRY}${query ? `?${query}` : ""}`;
      }
      next();
    });
  },
};

const htmlAsIndex = {
  name: "artifact-directions-html-as-index",
  closeBundle() {
    const built = path.resolve(OUT_DIR, ENTRY);
    if (!fs.existsSync(built)) return;
    fs.renameSync(built, path.resolve(OUT_DIR, "index.html"));
  },
};
```

  `entryAsRoot` hooks `configureServer` only (dev). Under `vite preview` and on the deploy the root resolves because `htmlAsIndex` renamed the file; `/<slug>.html` 404s there, so link with `/?d=...`, never the html filename. The rename runs in `closeBundle`, not `generateBundle`, because Vite's HTML plugin emits the document after user plugins' turn.
- `defineConfig` (`:105-129`), verbatim:

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

  - `appType: "mpa"` disables the SPA fallback. With it, `/` would serve the shared root's `index.html` and boot the real app, which calls `/api` and registers the service worker on this origin. Unknown paths 404.
  - No `server.proxy`: an HTTP request to `/api/*` 404s; only in-page fetches are answered, by the stub.
  - Aliases must equal `ui/vite.config.ts` and `ui/vitest.config.ts:5-10`, or product components do not resolve.
  - `cacheDir` per port: the default `node_modules/.vite` is shared and concurrent dev servers race on dependency metadata. Each new port pays dependency optimisation once.
  - `emptyOutDir: true` (`:123`) is explicit so Vite also wipes an out dir outside the project root (the Vercel recipe) without a warning. A wrong env value deletes that directory's contents.
  - `minify: "esbuild"` with no `esbuild.drop`: the lab keeps `console` so shot.cjs can fail on console errors. The sibling `vite.preview.config.mjs` and `vite.flow-preview.config.mjs` drop console; copying them silences the gate.
  - Deliberately absent, though `ui/vite.config.ts` has them: `serviceWorkerBuildIdPlugin()`, `preloadIssueDetail()`, `define.__PAPERCLIP_BUILD_COMMIT__`, `rolldownOptions.output.codeSplitting`. Vite is 8.2.2 (rolldown); `rollupOptions.input` still builds without a deprecation warning. A generated config adds its own `define`, `__<SLUG>_DIRECTIONS_BUILD_COMMIT__` from `git rev-parse --short HEAD` (`"unknown"` when git fails), which `build-info.ts` exposes as `LAB_BUILD` (`"dev"` when undefined) for the toolbar tooltip.
  - `publicDir` unset, so `ui/public` is copied verbatim into `OUT_DIR`, including `sw.js`. Do not set `publicDir: false`: `ui/src/index.css:110-128` loads `/fonts/InterVariable*.woff2` and `/fonts/PaperMono-Variable.woff2` from it, and the entry loads `/favicon.svg`.
  - Extra html files inside the lab dir (such as `directions/d2-tint/specimen.html`) are inert unless added to `rollupOptions.input`.

## 7. launch.json: two entries

`.claude/launch.json:27-44` is tracked, so new entries ship in the PR. **GENERIC** shape, parameterized names and ports; the two `runtimeArgs` commands:

```sh
cd ui && npx vite --config vite.artifact-directions.config.mjs --port 5180 --strictPort
cd ui && export ARTIFACT_DIRECTIONS_OUT_DIR=node_modules/.artifact-directions-dist && npx vite build --config vite.artifact-directions.config.mjs && npx vite preview --config vite.artifact-directions.config.mjs --port 5190 --strictPort
```

`artifact-directions-dev` (5180) is for editing with HMR. `artifact-directions` (5190) builds into `ui/node_modules/.artifact-directions-dist` (gitignored through `**/node_modules/`) and serves it statically, never live-reloading. `scaffold.mjs new` writes the same two entries as `<slug>-directions-dev` and `<slug>-directions` (slug, config file, env var and ports substituted); `check` fails when either is missing. Both exist because the in-page board (`s=board`) is 4 or 24 live iframes of the lab at `FRAME_WIDTH` 1440 (`frames/Board.tsx:12`; a generated board is kits × surfaces iframes, and `--landing auto` lands on it only when that is 8 or fewer) and never settles on an unbundled dev server. The build step in the second command carries no `--port`, so its cacheDir is the 5180 one. `preview.host` falls back to `server.host`, so preview binds 127.0.0.1. `ui/package.json` has no lab scripts on purpose: CODEOWNERS owns `package.json` at every depth (`.github/CODEOWNERS:19-20`), so the lab is invoked with `npx vite --config ...` directly.

## 8. Product build, tsc, vitest, token gates

- The product build excludes the lab structurally, not by configuration: `ui/vite.config.ts` has no exclusion; the lab is simply unreachable from `ui/index.html` and `src/main.tsx`. Before each PR, grep the slug outside the lab dir (today: the config, the html, launch.json, three Storybook stories, a plan doc). `scaffold.mjs check` is that guard for a generated lab: it fails when `<slug>-directions` appears in a `.ts`, `.tsx`, `.css`, `.cjs`, `.mjs` or `.html` file under `ui/` outside the lab, its html, its config, its story, `launch.json` and `.gitignore`.
- `tsc -b` covers the lab (`ui/tsconfig.json:19` includes `src`; `.cjs` is not typechecked). Vitest covers it (`ui/vitest.config.ts` has no include filter), so a half-finished lab breaks `pnpm test`, which is why `new` runs the lab's Vitest files and rolls back on failure.
- `scripts/check-token-gates.mjs:80` scans only `components` and `pages`; lab CSS is not gated.

## 9. Tests the lab carries

Six files: `lab-state.test.ts`, `api-stub.test.ts`, and `directions/d5-v1-mvp/Thread.test.tsx`, `MediaPrint.test.ts`, `kinds.test.ts`, `when.test.ts`. **GENERIC:** `api-stub.test.ts` (reuse verbatim; three cases: the `/api/companies` fallback answers `[COMPANY]` and restore puts `fetch` back; a registered route answers and an unregistered POST gets `{}`; nested installs share one stub, a repeated restore is a no-op, the last release restores) and `lab-state.test.ts`. `ui/vitest.config.ts:12` sets `environment: "node"`, so any test touching `window` or `fetch` starts with `// @vitest-environment jsdom` (`api-stub.test.ts:1`); it is the one comment line the generator's no-comment rule allows, on line 1 only (`api-stub.test.ts`, `today.test.tsx`). Run one file with `cd ui && npx vitest run src/artifact-directions/api-stub.test.ts` (3 pass; durations vary, do not record them). Run full ui suites one at a time. `scaffold.mjs new` ships five tests: `registry.test.ts`, `lab-state.test.ts`, `motion-contract.test.ts`, `today.test.tsx` and this `api-stub.test.ts` (same three cases, comment removed); `check` runs `motion-contract.test.ts` and `check --run` the whole lab directory.

## 10. shot.cjs: capture

`ui/src/artifact-directions/shot.cjs` (263 lines, CommonJS, no TS imports). Usage: `node ui/src/artifact-directions/shot.cjs --port <p> --d <kit|all> --out <dir> [--s thread,panel,gallery,stack,kinds,board] [--theme dark,light]`. It does not start a server. **GENERIC:** `parseArgs` (`--key value` or `--key=value`), `list()` validation, `loadChromium()` trying `@playwright/test` then `playwright` (`:67-78`; it resolves the root-hoisted `@playwright/test` from `package.json:100`), `settleFrame` (`:85-118`: set lazy images eager, await `document.fonts.ready`, a 400 ms MutationObserver quiet window, every image complete, every video `readyState >= 2` or 3.5 s, quiet again; network-idle says nothing about React under a fetch stub), the problem collectors (console errors, `pageerror`, `requestfailed`, any response `>= 400`), exit codes (2 usage, 1 any failure, after writing everything). Capture flags, verbatim (`:121-125,143-148`):

```js
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  const url = `${base}/?d=${shot.kit}&s=${shot.surface}&theme=${shot.theme}&chrome=0`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
  for (const frame of page.frames()) await frame.evaluate(settleFrame);
  const file = path.join(outDir, `${shot.kit}__${shot.surface}__${shot.theme}.png`);
  await page.screenshot({ path: file, fullPage: true });
```

Per-surface PNGs are `<kit>__<surface>__<theme>.png`. `reducedMotion: "reduce"` means every capture shows a resting state: the lab's only motion rules sit under `@media (prefers-reduced-motion: no-preference)` keyed on `html[data-lab-anim="1"]` (`directions/d5-v1-mvp/tokens.css:84-97`), and the URL never passes `anim`. A hover or animation frame needs a context without `reducedMotion` plus `page.hover` before the shot; a generated `shot.cjs` has this as `--hover`, which hovers the first `[data-direction] button`, waits 350 ms and writes `<kit>__<surface>__<theme>__hover.png`. Board (`:153-200`): non-board shots run first; `captureBoard` captures any missing `BOARD_SURFACES` PNG, writes a temporary HTML contact sheet (grid `150px repeat(3,minmax(0,1fr))`, tiles cropped to 1100/1100/542/542 px), screenshots it from `file://` at 2880x1200 with `deviceScaleFactor: 1` as `<kit>__board__<theme>.png`, then unlinks the sheet. **ARTIFACT-SPECIFIC:** `KITS`, `SURFACES`, `BOARD_SURFACES`, `KIT_NAMES` (`:22-24,153-154`; hand-duplicated from `kit.ts` and `lab-state.ts`, edit both sides), the tile crops, the stale "sixteen" in the comment at `:159`, and `isShippedNestingWarning` (`:210-213`), which excuses the product `ArtifactCard` nested-anchor warning. Start a new lab with no excuses. A generated `shot.cjs` has none of them: it reads `window.__LAB__` (directions, surfaces, names, labels) from a first `chrome=0` load and fails with "page did not expose window.__LAB__" when `main.tsx` did not run; `--d` defaults to `today` and `--s` to every surface plus `board`; every tile is cropped to 1100 px on a `150px repeat(<surfaces>, minmax(0,1fr))` grid; there is no excuse list.

## 11. Vercel deploy

**GENERIC recipe.** The deploy steps come from a memory note, not the repo; no Vercel deploy config (`vercel.json` at the root or `ui/`, `.vercel/`) is tracked, and the project link lives in the out-of-repo deploy directory.

```sh
cd ui
ARTIFACT_DIRECTIONS_OUT_DIR=<dir>/paperclip-artifact-directions npx vite build --config vite.artifact-directions.config.mjs
rm <dir>/paperclip-artifact-directions/sw.js
cd <dir>
vercel deploy paperclip-artifact-directions --prod --yes
```

The directory basename names the Vercel project; a generated lab's registry pins `publicUrl` to `https://paperclip-<slug>-directions.vercel.app`, so build into `<dir>/paperclip-<slug>-directions` with `<SLUG>_DIRECTIONS_OUT_DIR`. The alias `https://<project>.vercel.app` is public; the per-deployment `*-<hash>.vercel.app` URL is behind Vercel Authentication. Build the lab alone so the app's main chunk never lands in the deployed directory (every file there is publicly fetchable), and expect the whole `ui/public` tree in the output. `sw.js` is the product's worker copied unstamped (`__PAPERCLIP_BUILD_ID__` literal at `ui/public/sw.js:7`): its fetch handler returns at once (`:105`), but if registered it would `skipWaiting()`, delete every cache and `clients.claim()` (`:88-99`); removing it is hygiene. The lab never registers a worker (registration is the load listener at `ui/src/main.tsx:45`, which the lab does not import). A bare URL lands on `readLabState`'s default (`lab-state.ts:41-42`); in a generated lab that default is `registry.landing`, written from `--landing` (`auto`: `d=all&s=board` when kits × surfaces is 8 or fewer, else `d=all&s=<first surface>`), so edit `registry.ts` to change the view the shared link opens.

## 12. What a generator parameterizes

- **slug** (`--slug`, kebab-case, never ending in `-directions`; the suffix is added everywhere): `ui/<slug>-directions.html`, `ui/vite.<slug>-directions.config.mjs`, `ui/src/<slug>-directions/`, the story `ui/storybook/stories/design-proposals/<slug>-directions.stories.tsx` with meta id `design-<slug>-directions`, plugin names `<slug>-directions-entry-as-root` and `<slug>-directions-html-as-index`, `cacheDir node_modules/.vite-<slug>-directions-${PORT}`, default out dir `dist-<slug>-directions` plus the `.gitignore` line `ui/dist-<slug>-directions/`, launch entries `<slug>-directions-dev` and `<slug>-directions`, static dir `node_modules/.<slug>-directions-dist`, the `console.debug("[<slug>-directions] unhandled", ...)` tag, Vercel project `paperclip-<slug>-directions`.
- **env var names**: `<SLUG>_DIRECTIONS_OUT_DIR`, `<SLUG>_DIRECTIONS_PORT` and the define `__<SLUG>_DIRECTIONS_BUILD_COMMIT__` (upper snake case of the slug).
- **two free ports**: dev and static preview (5180/5190 here). `--ports dev,preview`, or the first pair from 5200/5210 in steps of 20 that avoids the reserved list (3100, 3101, 3121, 4173, 5173, 5180, 5190, 6006, 6016), every port in `.claude/launch.json` and any `ui/node_modules/.vite-*-<port>` already on disk; sockets are not probed.
- **page title** (`<Title> directions`, from `--title`, default the slug in sentence case) and **COMPANY** from `--company name:PREFIX` (default `acmehats:ACM`): `{ id: "company-<name>", name, issuePrefix }` in `registry.shell`, three shell tasks `<PREFIX>-1..3`, and the stub user `lab@<name>.example`. **LAB_NOW** and the pinned week are not flags: every lab gets `2026-09-28T18:00:00` and placeholder records on 09-24, 09-26 and 09-28.
- **kit ids, digit keys, KIT_META** from `--directions 2|3` and `--names` (`d<N>-<kebab name>`, key `N`, name `N.Name`, placeholder taglines for Refine, Rework and Rethink, else `Direction N`), the **surface list** from `--surfaces id:Label:width@nav` (1 to 6, `nav` one of `tasks|artifacts|other`, never `board`), and the **bare-URL default** from `--landing auto|all|today|<id>`. The URL shape is fixed: `d/s/theme/chrome/anim` plus `proposal`.
- **shot.cjs**: nothing; the generated script reads `window.__LAB__` at run time and carries no excuse list.
- **routes**: none; `api-routes.ts` registers only the experimental-settings route, and the routes the Today kit needs are added by hand in `registerFeatureRoutes()`, found by grepping the mounted components and from the `unhandled` debug lines.
