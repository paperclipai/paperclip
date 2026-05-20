import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const STORY_INDEX_PATH = path.resolve(process.cwd(), "ui/storybook-static/index.json");

interface StoryEntry {
  id: string;
  title: string;
  name: string;
  importPath?: string;
  tags?: string[];
}

interface StoryIndex {
  entries: Record<string, StoryEntry>;
  v?: number;
}

const storyIndex: StoryIndex = JSON.parse(fs.readFileSync(STORY_INDEX_PATH, "utf-8"));
const storyEntries = Object.values(storyIndex.entries);

// Group stories by component title for organized test runs
const storiesByTitle = new Map<string, StoryEntry[]>();
for (const entry of storyEntries) {
  const existing = storiesByTitle.get(entry.title) ?? [];
  existing.push(entry);
  storiesByTitle.set(entry.title, existing);
}

const skipStories = new Set<string>([
  // Stories that require real-time data or external services
  "product-data-visualization-misc--kanban-board-populated",
  "product-data-visualization-misc--kanban-board-empty",
  // Stories with dynamic content that changes every render
  "product-chat-comments--live-run-chat",
]);

test.describe("Storybook visual regression", () => {
  for (const [title, entries] of storiesByTitle) {
    test.describe(title, () => {
      for (const entry of entries) {
        const storyId = entry.id;
        if (skipStories.has(storyId)) {
          test.skip(entry.name, () => {});
          continue;
        }

        test(entry.name, async ({ page }) => {
          await page.goto(`/iframe.html?id=${storyId}&viewMode=story`);
          await page.waitForSelector("#storybook-root", { timeout: 15_000 });
          // Wait for fonts and images to load
          await page.waitForLoadState("networkidle");
          // Extra time for any CSS animations or transitions
          await page.waitForTimeout(500);

          const root = page.locator("#storybook-root");
          await expect(root).toBeVisible();

          await expect(page).toHaveScreenshot(`${entry.id}.png`, {
            fullPage: true,
            animations: "disabled",
            threshold: 0.02,
          });
        });
      }
    });
  }
});
