export default (ctx) => `import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ENTRY = "${ctx.entry}";
const DEFAULT_PORT = ${ctx.ports.dev};

function portFromArgv() {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port" && argv[i + 1]) return Number(argv[i + 1]);
    if (argv[i].startsWith("--port=")) return Number(argv[i].slice("--port=".length));
  }
  return null;
}

function buildCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: __dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

const PORT = portFromArgv() || Number(process.env.${ctx.envPort}) || DEFAULT_PORT;
const OUT_DIR = process.env.${ctx.envOutDir}
  ? path.resolve(process.env.${ctx.envOutDir})
  : path.resolve(__dirname, "dist-${ctx.slug}-directions");

const LAB_WATCH_PATHS = [
  path.resolve(__dirname, "src/${ctx.slug}-directions"),
  path.resolve(__dirname, "src/index.css"),
  path.resolve(__dirname, ENTRY),
];

function outsideLab(watchedPath) {
  const target = path.resolve(__dirname, String(watchedPath));
  if (LAB_WATCH_PATHS.some((lab) => target === lab || target.startsWith(lab + path.sep))) return false;
  return !LAB_WATCH_PATHS.some((lab) => lab.startsWith(target + path.sep));
}

const entryAsRoot = {
  name: "${ctx.slug}-directions-entry-as-root",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const [pathname, query] = (req.url || "").split("?");
      if (pathname === "/" || pathname === "/index.html") {
        req.url = \`/\${ENTRY}\${query ? \`?\${query}\` : ""}\`;
      }
      next();
    });
  },
};

const htmlAsIndex = {
  name: "${ctx.slug}-directions-html-as-index",
  closeBundle() {
    const built = path.resolve(OUT_DIR, ENTRY);
    if (!fs.existsSync(built)) return;
    fs.renameSync(built, path.resolve(OUT_DIR, "index.html"));
  },
};

export default defineConfig({
  appType: "mpa",
  plugins: [react(), tailwindcss(), entryAsRoot, htmlAsIndex],
  define: { ${ctx.buildDefine}: JSON.stringify(buildCommit()) },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  cacheDir: path.resolve(__dirname, \`node_modules/.vite-${ctx.slug}-directions-\${PORT}\`),
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
`;
