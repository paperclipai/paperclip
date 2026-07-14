import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export default defineConfig({
  resolve: {
    alias: [
      { find: "@paperclipai/plugin-sdk/testing", replacement: path.join(repoRoot, "packages/plugins/sdk/src/testing.ts") },
      { find: "@paperclipai/plugin-sdk/ui", replacement: path.join(repoRoot, "packages/plugins/sdk/src/ui/index.ts") },
      { find: "@paperclipai/plugin-sdk", replacement: path.join(repoRoot, "packages/plugins/plugin-paperclip-ee/tests/sdk-worker-shim.ts") },
      { find: "react/jsx-runtime", replacement: path.join(repoRoot, "ui/node_modules/react/jsx-runtime.js") },
      { find: "react/jsx-dev-runtime", replacement: path.join(repoRoot, "ui/node_modules/react/jsx-dev-runtime.js") },
      { find: /^react$/, replacement: path.join(repoRoot, "ui/node_modules/react") },
      { find: /^react-dom$/, replacement: path.join(repoRoot, "ui/node_modules/react-dom") },
      { find: /^react-dom\/client$/, replacement: path.join(repoRoot, "ui/node_modules/react-dom/client.js") },
    ],
  },
  test: {
    include: ["tests/**/*.spec.ts", "tests/**/*.spec.tsx"],
    environment: "jsdom",
  },
});
