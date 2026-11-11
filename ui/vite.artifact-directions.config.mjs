import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The artifact-directions lab: a backend-free page that renders artifact
 * designs for the thread, the task side panel and the Artifacts page inside
 * static mocks of their real surroundings (`src/artifact-directions/`).
 *
 * Dev (any free port; several servers can run side by side):
 *
 *   cd ui && npx vite --config vite.artifact-directions.config.mjs --port <p> --strictPort
 *
 * then open http://127.0.0.1:<p>/ (or /artifact-directions.html).
 *
 * Build (this page alone, landed as index.html):
 *
 *   cd ui && npx vite build --config vite.artifact-directions.config.mjs
 *
 * Invoked directly rather than through a package.json script, as
 * `vite.flow-preview.config.mjs` is and for the same reason.
 *
 * Three things here are load-bearing:
 *
 * - No `server.proxy`. The app's config forwards `/api` to whatever listens on
 *   :3100; the lab answers every `/api/` fetch from a stub in its entry and
 *   must never reach a real instance.
 * - `appType: "mpa"` plus the root rewrite. The Vite root also holds the app's
 *   `index.html`; with the default SPA fallback `/` would boot the real app,
 *   which calls `/api` and registers the service worker on this origin.
 * - A cache directory per port. The default `node_modules/.vite` is shared, and
 *   concurrent dev servers race on its dependency metadata.
 */

const ENTRY = "artifact-directions.html";
const DEFAULT_PORT = 5180;

/** A config cannot see the resolved CLI options, so the flag is read from argv. */
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

/**
 * Live reload polls the lab's own files instead of waiting for native file
 * events. When macOS runs out of FSEvents watchers — every long-running watch
 * process on the machine holds some — `fs.watch` on a directory fails with
 * EMFILE, and Vite's watcher, which uses FSEvents whenever the module loads,
 * goes silent without an error: edits never reach the page. Polling only the
 * lab (a few hundred files) keeps the cost negligible.
 */
const LAB_WATCH_PATHS = [
  path.resolve(__dirname, "src/artifact-directions"),
  path.resolve(__dirname, "src/index.css"),
  path.resolve(__dirname, ENTRY),
];

function outsideLab(watchedPath) {
  const target = path.resolve(__dirname, String(watchedPath));
  if (LAB_WATCH_PATHS.some((lab) => target === lab || target.startsWith(lab + path.sep))) return false;
  // Keep the directories on the way down to the lab, or the watcher never reaches it.
  return !LAB_WATCH_PATHS.some((lab) => lab.startsWith(target + path.sep));
}

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

/**
 * Renamed on disk in `closeBundle`, not rekeyed in `generateBundle`: Vite's
 * HTML plugin emits the document after user plugins have had that turn.
 */
const htmlAsIndex = {
  name: "artifact-directions-html-as-index",
  closeBundle() {
    const built = path.resolve(OUT_DIR, ENTRY);
    if (!fs.existsSync(built)) return;
    fs.renameSync(built, path.resolve(OUT_DIR, "index.html"));
  },
};

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
