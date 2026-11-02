import { defineConfig } from "@playwright/test";

/** Browser-only harness regressions: no Paperclip instance or provider credentials. */
export default defineConfig({
  testDir: ".",
  testMatch: ["hire-delegate-composer.spec.ts", "question-resume-ui.spec.ts", "clarification-readback.spec.ts", "project-context-readback.spec.ts", "skill-studio-flow.spec.ts", "native-task-reply.spec.ts", "screenshot-readiness.spec.ts", "service-worker-reload.spec.ts", "lost-send.spec.ts", "chat-restart.spec.ts", "settings-toggle.spec.ts", "browser-bootstrap-diagnostics.spec.ts", "service-worker-module-loading.spec.ts", "browser-bootstrap-recovery.spec.ts", "blocker-input.spec.ts", "native-blocker-visible.spec.ts", "copilot-permission-card.spec.ts", "kimi-permission-card.spec.ts", "github-review-check.spec.ts", "antigravity-journey-browser.spec.ts", "task-search-filter.spec.ts", "task-document-navigation.spec.ts"],
  workers: 1,
  retries: 0,
  timeout: 10_000,
  use: {
    headless: true,
    ...(process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL }
      : {}),
  },
  outputDir: "./results/browser-support",
  reporter: "list",
});
