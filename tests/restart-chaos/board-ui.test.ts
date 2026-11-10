import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BoardUi, UI_RETRY_BUTTON_MISSING, UI_RETRY_NO_REQUEST, isRetryRequestFor } from "./board-ui.js";

const retry = (issue: string) => `fetch('/api/issues/${issue}/retry',{method:'POST'})`;
const pages: Record<string, string> = {
  "/issues/CHA-1": `<div role="status">Couldn’t finish this attempt. <button onclick="${retry("i1")}">Retry</button></div>`,
  "/issues/CHA-2": `<div role="status">Saving files from the previous attempt</div>`,
  "/issues/CHA-3": `<div role="status">Automatic recovery stopped. <button>Retry</button></div>`,
  "/issues/CHA-4": `<section><p>Couldn’t load the subtasks.</p><button onclick="window.reloaded=true">Retry</button></section>
    <div role="status">Couldn’t finish this attempt. <button onclick="${retry("i4")}">Retry</button></div>`,
  "/issues/CHA-5": `<div role="status">Couldn’t finish this attempt. <button onclick="${retry("other")}">Retry</button></div>`,
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
