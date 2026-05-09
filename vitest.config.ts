import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/shared",
      "packages/db",
      "packages/adapter-utils",
      "packages/adapters/acpx-local",
      "packages/adapters/claude-local",
      "packages/adapters/codex-local",
      "packages/adapters/cursor-local",
      "packages/adapters/gemini-local",
      "packages/adapters/opencode-local",
      "packages/adapters/pi-local",
      "server",
      "ui",
      "cli",
      "tests/aj-ai-services",
      "tests/cloudops-pro",
      "tests/support-genius",
      "tests/cybershield-ai",
      "tests/devlaunch-studio",
      "tests/apiconnect-services",
    ],
  },
});
