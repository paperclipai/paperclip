import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const sdkSrc = path.resolve(pluginRoot, "../sdk/src");
const sharedSrc = path.resolve(pluginRoot, "../../shared/src");

export default defineConfig({
  resolve: {
    alias: {
      "@paperclipai/plugin-sdk/testing": path.join(sdkSrc, "testing.ts"),
      "@paperclipai/plugin-sdk/ui": path.join(sdkSrc, "ui/index.ts"),
      "@paperclipai/plugin-sdk": path.join(sdkSrc, "index.ts"),
      "@paperclipai/shared": path.join(sharedSrc, "index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
});
