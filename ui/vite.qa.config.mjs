import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = "http://paperclip-dev:3100";

// Mock the /tools/gallery endpoint (which only exists on PAP-10341 branch)
// so we can visually test the "recognized domain" shortcut against a populated gallery.
const MOCK_GALLERY = {
  apps: [
    {
      key: "zapier",
      name: "Zapier",
      tagline: "Automate things",
      authKind: "api_key",
      urlPatterns: ["https://zapier.com/*", "https://*.zapier.com/*"],
      logoUrl: null,
      credentialFields: [
        { configPath: "credentials.authorization", label: "API key", required: true },
      ],
    },
  ],
};

const galleryMockPlugin = {
  name: "qa-mock-gallery",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url && /\/api\/companies\/[^/]+\/tools\/gallery(\?|$)/.test(req.url)) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(MOCK_GALLERY));
        return;
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [galleryMockPlugin, react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5179,
    strictPort: true,
    proxy: {
      "/api": {
        target: BACKEND,
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("origin", BACKEND);
          });
        },
      },
    },
  },
});
