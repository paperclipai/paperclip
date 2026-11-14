import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { markReturningBrowser, RETURNING_BROWSER_SEEN_KEYS } from "./chat-returning-browser.js";

it("uses the product's own star prompt seen key", () => {
  const source = readFileSync(new URL("../../ui/src/components/GitHubStarPrompt.tsx", import.meta.url), "utf8");
  const key = /export const STAR_PROMPT_SEEN_KEY = "([^"]+)"/.exec(source)?.[1];
  expect(key).toBeTruthy();
  expect(RETURNING_BROWSER_SEEN_KEYS).toContain(key);
});

function fakePage(url: string) {
  const storage = new Map<string, string>([["paperclip.github-star-prompt.seen", "kept"]]);
  const scripts: Array<{ script: (arg: never) => void; arg: unknown }> = [];
  const run = (script: (arg: never) => void, arg: unknown, origin: string) => {
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { location: { origin }, localStorage: {
      getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } } };
    try { script(arg as never); } finally { (globalThis as { window?: unknown }).window = previous; }
  };
  const page = {
    url: () => url,
    context: () => ({ addInitScript: async (script: (arg: never) => void, arg: unknown) => { scripts.push({ script, arg }); } }),
    evaluate: async (script: (arg: never) => void, arg: unknown) => run(script, arg, new URL(url).origin),
  };
  return { page: page as never, storage, scripts, load: (origin: string) => { for (const row of scripts) run(row.script, row.arg, origin); } };
}

it("marks the prompt seen for later app documents and the open app page, never other origins", async () => {
  const open = fakePage("http://127.0.0.1:3100/COM/issues/COM-1"); open.storage.clear();
  await markReturningBrowser(open.page, "http://127.0.0.1:3100");
  expect(open.storage.get("paperclip.github-star-prompt.seen")).toBeTruthy();
  expect(open.scripts).toHaveLength(1);

  const blank = fakePage("about:blank"); blank.storage.clear();
  await markReturningBrowser(blank.page, "http://127.0.0.1:3100");
  expect(blank.storage.size).toBe(0);
  blank.load("https://github.com"); expect(blank.storage.size).toBe(0);
  blank.load("http://127.0.0.1:3100"); expect(blank.storage.get("paperclip.github-star-prompt.seen")).toBeTruthy();
});

it("keeps a choice the browser already saved", async () => {
  const open = fakePage("http://127.0.0.1:3100/");
  await markReturningBrowser(open.page, "http://127.0.0.1:3100");
  expect(open.storage.get("paperclip.github-star-prompt.seen")).toBe("kept");
});

it("does nothing for a page stand-in without a browser context", async () => {
  await expect(markReturningBrowser({ url: () => "http://127.0.0.1:3100/" } as never, "http://127.0.0.1:3100")).resolves.toBeUndefined();
  await expect(markReturningBrowser(undefined as never, "http://127.0.0.1:3100")).resolves.toBeUndefined();
});
