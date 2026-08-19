import path from "path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { visualizer } from "rollup-plugin-visualizer";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";
import { createApiProxy } from "./src/lib/vite-api-proxy";

const apiProxy = createApiProxy();

// The issue page (IssueDetail) is the perf-critical route. Route
// splitting via React.lazy carves every page into its own chunk, but that would
// otherwise regress the issue page's open — the shell can only discover the
// IssueDetail chunk after React renders the route. Inject a
// `<link rel="modulepreload">` for the IssueDetail chunk directly into the HTML
// shell so the browser fetches it in parallel with the entry, in flight before
// the router resolves. Runs post-bundle so the hashed filename is known.
function preloadIssueDetailChunkPlugin(): Plugin {
  return {
    name: "paperclip-preload-issue-detail-chunk",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        const issueDetailChunk = Object.values(bundle).find(
          (item) =>
            item.type === "chunk" &&
            typeof item.facadeModuleId === "string" &&
            /[\\/]pages[\\/]IssueDetail\.tsx$/.test(item.facadeModuleId),
        );
        if (!issueDetailChunk || issueDetailChunk.type !== "chunk") return html;
        const href = `/${issueDetailChunk.fileName}`;
        const tag = `    <link rel="modulepreload" href="${href}" />\n`;
        return html.replace("</head>", `${tag}  </head>`);
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    preloadIssueDetailChunkPlugin(),
    // Bundle analyzer: emits dist/stats.html (treemap, gzip + brotli sizes) on
    // every production build so we can inspect the issue-page critical path.
    visualizer({
      filename: "dist/stats.html",
      template: "treemap",
      gzipSize: true,
      brotliSize: true,
      open: false,
    }) as Plugin,
  ],
  build: {
    minify: "esbuild",
    rollupOptions: {
      output: {
        // Split the eager framework vendors into stable, long-cached chunks.
        //
        // We deliberately only manualChunk react/router and @tanstack/query —
        // libraries that are on every route's critical path anyway, so naming
        // them just improves cross-deploy caching without changing what loads.
        //
        // We do NOT manualChunk the editor (@mdxeditor/lexical) or
        // @assistant-ui/react: those are reached only through dynamically
        // imported chunks (the lazy MarkdownEditor / IssueChatThread), and
        // Rollup's automatic code-splitting already isolates them into deferred
        // chunks. Forcing them into named manualChunks instead pulls their
        // shared UI dependencies (e.g. Radix) onto the critical path and
        // regresses the issue-page open — the exact opposite of this work's
        // goal. See dist/stats.html (rollup-plugin-visualizer) to verify the
        // editor/assistant-ui chunks stay off the entry's modulepreload set.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return "vendor-react";
          }
          if (id.includes("/node_modules/@tanstack/")) return "vendor-query";
          return undefined;
        },
      },
    },
  },
  esbuild:
    mode === "production"
      ? {
          drop: ["console", "debugger"],
          legalComments: "none",
        }
      : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: apiProxy,
  },
  preview: {
    port: 3101,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: apiProxy,
  },
}));
