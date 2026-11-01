import { defineConfig } from "vitest/config";
export default defineConfig({ test: { name: "@paperclipai/plugin-slack-control", include: ["tests/**/*.test.ts"], environment: "node" } });
