// @vitest-environment jsdom

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPostHogInitOptions } from "./product-analytics";
import { maskReplayText } from "./privacy";

// Session replay masks all text by default. Text shows only inside the
// unmask allowlist, so this file is the review point for that allowlist.
//
// Connected-account content (Gmail bodies, Calendar events, Slack messages in
// tasks, chat, tool results and previews) is Google user data / Slack data:
// no human may read it in a replay (Google API Limited Use). It must never sit
// inside an unmasked element. Before adding any entry below, confirm the
// element renders fixed product copy only, never connected-account or other
// customer content.

const UI_SRC = join(import.meta.dirname, "../..");

/** Files that may spread the unmask attribute: shared components, behind an opt-in prop. */
const UNMASK_PROPS_FILES = [
  "components/EmptyState.tsx",
  "components/SidebarNavItem.production.tsx",
  "components/SidebarNavItem.tsx",
  "components/ui/button.tsx",
  "components/ui/label.tsx",
  "components/ui/tabs.tsx",
  "lib/analytics/privacy.ts",
];

/**
 * Reviewed `analyticsChrome` opt-ins on Button, Label, TabsTrigger or
 * EmptyState, as "file: component". Empty today: none opts in.
 */
const REVIEWED_CHROME_OPT_INS: string[] = [];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|stories)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles(UI_SRC).map((path) => ({ name: relative(UI_SRC, path), source: readFileSync(path, "utf8") }));

describe("session replay unmask allowlist", () => {
  it("spreads the unmask attribute only in the reviewed shared components", () => {
    const users = files
      .filter((file) => /ANALYTICS_UNMASK_PROPS|data-analytics-unmask/.test(file.source))
      .map((file) => file.name)
      .sort();
    expect(users).toEqual(UNMASK_PROPS_FILES);
  });

  it("opts in sidebar items only when the label is a fixed string", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const match of file.source.matchAll(/<SidebarNavItem\b[^>]*?\banalyticsChrome\b[\s\S]*?\/>/g)) {
        if (!/\slabel="[^"]+"/.test(match[0])) offenders.push(`${file.name}: ${match[0].slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no unreviewed analyticsChrome opt-in on other shared components", () => {
    const optIns: string[] = [];
    for (const file of files) {
      for (const match of file.source.matchAll(/<(Button|Label|TabsTrigger|EmptyState)\b[^>]*?\banalyticsChrome\b/g)) {
        optIns.push(`${file.name}: ${match[1]}`);
      }
    }
    expect(optIns.sort()).toEqual(REVIEWED_CHROME_OPT_INS);
  });

  it("masks connected-account content in replays and keeps it out of autocapture", () => {
    document.body.innerHTML = `
      <nav data-analytics-unmask><span id="nav">Tasks</span></nav>
      <div class="task-chat">
        <div class="tool-result"><p id="gmail">Re: Q3 contract — please sign by Friday</p></div>
        <div class="tool-result"><p id="calendar">Board meeting with Acme, 3pm</p></div>
        <div class="slack-preview"><p id="slack">#deals: we lost the Globex renewal</p></div>
      </div>`;
    const text = (id: string) => {
      const element = document.getElementById(id)!;
      return maskReplayText(element.textContent!, element);
    };
    expect(text("nav")).toBe("Tasks");
    expect(text("gmail")).not.toMatch(/[A-Za-z0-9]/);
    expect(text("calendar")).not.toMatch(/[A-Za-z0-9]/);
    expect(text("slack")).not.toMatch(/[A-Za-z0-9]/);
    // Autocapture never records element text or attribute values anywhere.
    const options = buildPostHogInitOptions(
      { token: "t", apiHost: "/_ph", uiHost: null, environment: "production", stackId: "s", replayEnabled: true },
      "acme.paperclip.app",
    );
    expect(options.mask_all_text).toBe(true);
    expect(options.mask_all_element_attributes).toBe(true);
    document.body.innerHTML = "";
  });
});
