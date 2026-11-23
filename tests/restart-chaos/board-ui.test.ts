import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BoardUi, UI_RETRY_BLOCKED_BY_MODAL, UI_RETRY_BUTTON_MISSING, UI_RETRY_NO_REQUEST, isRetryRequestFor } from "./board-ui.js";

const retry = (issue: string) => `fetch('/api/issues/${issue}/retry',{method:'POST'})`;
const modal = (buttons: string) => `<div role="dialog" data-state="open" aria-modal="true" style="position:fixed;inset:30%;background:#fff;z-index:2">
  <h2>You completed 5 tasks!</h2>${buttons}</div>`;
const coveredRetry = (issue: string) => `<main aria-hidden="true">
  <div role="status">Couldn’t finish this attempt. <button onclick="${retry(issue)}">Retry</button></div></main>`;
const closeModal = "document.querySelector('[role=dialog]').remove();document.querySelector('main').removeAttribute('aria-hidden')";
const lateModal = `<div role="dialog" data-state="open" aria-modal="true" style="position:fixed;inset:0;background:#fff;z-index:2">
  <h2>You completed 5 tasks!</h2><button onclick="this.parentElement.remove();document.querySelector('main').removeAttribute('aria-hidden')">Not now</button></div>`;
const openLateModal = `document.querySelector('main').setAttribute('aria-hidden','true');document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(lateModal).replace(/"/g, "&quot;")})`;
const pages: Record<string, string> = {
  "/issues/CHA-8": coveredRetry("i8") + modal(`<button onclick="${closeModal}">Not now</button>`),
  "/issues/CHA-9": coveredRetry("i9") + modal(`<span>No way out</span>`),
  "/issues/CHA-11": `<main><div role="status">Couldn’t finish this attempt.
    <button onmouseover="if (!window.prompted) { window.prompted = true; ${openLateModal} }" onclick="${retry("i11")}">Retry</button></div></main>`,
  "/issues/CHA-10": coveredRetry("i10") + modal(`<span>Press Escape</span>`)
    + `<script>document.addEventListener('keydown', event => { if (event.key === 'Escape') { ${closeModal} } })</script>`,
  "/issues/CHA-1": `<div role="status">Couldn’t finish this attempt. <button onclick="${retry("i1")}">Retry</button></div>`,
  "/issues/CHA-2": `<div role="status">Saving files from the previous attempt</div>`,
  "/issues/CHA-7": `<div role="status">Couldn’t finish this attempt. <button style="display:none">Retry</button></div>`,
  "/issues/CHA-3": `<div role="status">Automatic recovery stopped. <button>Retry</button></div>`,
  "/issues/CHA-4": `<section><p>Couldn’t load the subtasks.</p><button onclick="window.reloaded=true">Retry</button></section>
    <div role="status">Couldn’t finish this attempt. <button onclick="${retry("i4")}">Retry</button></div>`,
  "/issues/CHA-5": `<div role="status">Couldn’t finish this attempt. <button onclick="${retry("other")}">Retry</button></div>`,
  "/issues/CHA-6": `<button style="width:0;height:0;padding:0;border:0;overflow:hidden">Retry</button>
    <div role="status">Couldn’t finish this attempt. Your message is saved. <button onclick="${retry("i6")}">Retry</button></div>`,
};
let server: Server;
let baseUrl: string;
const posts: string[] = [];

beforeAll(async () => {
  server = createServer((incoming, outgoing) => {
    if (incoming.method === "POST") {
      posts.push(incoming.url ?? "");
      outgoing.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ accepted: true }));
      return;
    }
    const body = pages[incoming.url ?? ""];
    outgoing.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${body ?? ""}</body></html>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); server.close(); });

async function withBoard<T>(run: (board: BoardUi) => Promise<T>): Promise<T> {
  const board = new BoardUi(baseUrl);
  try { return await run(board); } finally { await board.close(); }
}

describe("BoardUi.clickRetry", () => {
  it("clicks the visible Retry button and reports the retry request it sent", async () => {
    await withBoard(async board => {
      expect(await board.clickRetry("CHA-1", "i1", 10_000)).toMatchObject({ clicked: true, httpStatus: 202, accepted: true, error: null,
        bannerText: expect.stringContaining("Couldn’t finish this attempt") });
    });
    expect(posts).toContain("/api/issues/i1/retry");
  }, 60_000);

  it("reports a missing Retry button with the status text the user sees", async () => {
    await withBoard(async board => {
      expect(await board.clickRetry("CHA-2", "i2", 1_500)).toMatchObject({ clicked: false, error: UI_RETRY_BUTTON_MISSING,
        bannerText: "Saving files from the previous attempt" });
    });
  }, 60_000);

  it("saves a screenshot and the banner's HTML when no visible Retry appears", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "chaos-retry-diagnostics-"));
    const board = new BoardUi(baseUrl, undefined, directory);
    try {
      const result = await board.clickRetry("CHA-2", "i2", 1_500);
      expect(result).toMatchObject({ clicked: false, error: UI_RETRY_BUTTON_MISSING,
        diagnostics: { screenshot: expect.stringMatching(/\.png$/), dom: expect.stringMatching(/\.json$/) } });
      expect((await readdir(directory)).sort()).toHaveLength(2);
      const dom = JSON.parse(await readFile(result.diagnostics!.dom!, "utf8"));
      expect(dom).toMatchObject({ url: expect.stringContaining("/issues/CHA-2"), retryButtons: [],
        banners: [expect.stringContaining("Saving files from the previous attempt")] });
    } finally {
      await board.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("records a hidden Retry with its visibility and box", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "chaos-retry-hidden-"));
    const board = new BoardUi(baseUrl, undefined, directory);
    try {
      const result = await board.clickRetry("CHA-7", "i7", 1_500);
      expect(result).toMatchObject({ clicked: false, error: UI_RETRY_BUTTON_MISSING });
      const dom = JSON.parse(await readFile(result.diagnostics!.dom!, "utf8"));
      expect(dom.retryButtons).toEqual([expect.objectContaining({ visible: false, box: null, inBanner: true })]);
    } finally {
      await board.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("dismisses a prompt that covers the Retry with Not now, then clicks Retry", async () => {
    await withBoard(async board => {
      expect(await board.clickRetry("CHA-8", "i8", 5_000, 1_000)).toMatchObject({ clicked: true, httpStatus: 202, accepted: true, error: null,
        dismissedDialogs: [expect.stringContaining("You completed 5 tasks!")] });
    });
    expect(posts).toContain("/api/issues/i8/retry");
  }, 60_000);

  it("closes a prompt without a Not now button with Escape", async () => {
    await withBoard(async board => {
      expect(await board.clickRetry("CHA-10", "i10", 5_000, 1_000)).toMatchObject({ clicked: true, accepted: true,
        dismissedDialogs: [expect.stringContaining("You completed 5 tasks!")] });
    });
    expect(posts).toContain("/api/issues/i10/retry");
  }, 60_000);

  it("closes a prompt that opens after Retry appeared, then clicks Retry", async () => {
    await withBoard(async board => {
      expect(await board.clickRetry("CHA-11", "i11", 5_000, 1_500)).toMatchObject({ clicked: true, httpStatus: 202, accepted: true, error: null,
        dismissedDialogs: [expect.stringContaining("You completed 5 tasks!")] });
    });
    expect(posts).toContain("/api/issues/i11/retry");
  }, 60_000);

  it("names a modal that keeps a visible Retry unreachable", async () => {
    await withBoard(async board => {
      expect(await board.clickRetry("CHA-9", "i9", 2_000, 500)).toMatchObject({ clicked: false, error: UI_RETRY_BLOCKED_BY_MODAL,
        bannerText: expect.stringContaining("Couldn’t finish this attempt") });
    });
    expect(posts).not.toContain("/api/issues/i9/retry");
  }, 60_000);

  it("reports a Retry button whose click sends no retry request", async () => {
    await withBoard(async board => {
      expect(await board.clickRetry("CHA-3", "i3", 1_500, 500)).toMatchObject({ clicked: true, httpStatus: null, error: UI_RETRY_NO_REQUEST });
    });
  }, 60_000);

  it("prefers the recovery banner's Retry over another Retry earlier on the page", async () => {
    await withBoard(async board => {
      expect(await board.clickRetry("CHA-4", "i4", 10_000, 500)).toMatchObject({ clicked: true, httpStatus: 202, accepted: true });
    });
    expect(posts).toContain("/api/issues/i4/retry");
  }, 60_000);

  it("finds the visible banner Retry when an earlier Retry match has no box", async () => {
    await withBoard(async board => {
      expect(await board.clickRetry("CHA-6", "i6", 3_000, 500)).toMatchObject({ clicked: true, httpStatus: 202, accepted: true, error: null });
    });
    expect(posts).toContain("/api/issues/i6/retry");
  }, 60_000);

  it("does not count a retry request for a different issue", async () => {
    await withBoard(async board => {
      expect(await board.clickRetry("CHA-5", "i5", 1_500, 500)).toMatchObject({ clicked: true, error: UI_RETRY_NO_REQUEST });
    });
  }, 60_000);

  it("reports a browser that cannot launch and still closes cleanly", async () => {
    const board = new BoardUi(baseUrl, () => Promise.reject(new Error("browser missing")));
    expect(await board.clickRetry("CHA-1", "i1", 1_000)).toMatchObject({ clicked: false, error: "browser missing" });
    await expect(board.close()).resolves.toBeUndefined();
  });

  it("matches retry requests by the issue's identifier or id only", () => {
    expect(isRetryRequestFor(["CHA-1", "i1"], "POST", "http://x/api/issues/i1/retry")).toBe(true);
    expect(isRetryRequestFor(["CHA-1", "i1"], "POST", "http://x/api/issues/CHA-1/retry")).toBe(true);
    expect(isRetryRequestFor(["CHA-1", "i1"], "POST", "http://x/api/issues/i2/retry")).toBe(false);
    expect(isRetryRequestFor(["CHA-1", "i1"], "GET", "http://x/api/issues/i1/retry")).toBe(false);
  });
});
