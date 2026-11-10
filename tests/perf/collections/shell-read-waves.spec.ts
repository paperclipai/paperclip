import { expect, test } from "@playwright/test";
import { freshContext, minePath, observeMineLoad, returningVisitFixture, savedQueryCache, type ReturningVisitFixture } from "./returning-visit-fixture";

// A hard load of Mine used to repeat about eight shell and inbox reads 1.5–2.5 s
// after load. With the saved query cache, the restored session has no session
// id; when the server answered with one, the live-updates socket reconnected,
// and that reconnect refreshed every active query, session and health included.
// Every API response is delayed 300 ms so the socket opens while reads are in
// flight, as on a busy hosted instance.
let fixture: ReturningVisitFixture;
test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000);
  fixture = await returningVisitFixture(request);
});

test("a returning visit makes each shell read at most once and keeps one live socket", async ({ browser, baseURL }) => {
  const storageState = await savedQueryCache(browser, baseURL, fixture);
  const context = await freshContext(browser, baseURL, storageState);
  try {
    const page = await context.newPage();
    const sockets: string[] = [];
    page.on("websocket", socket => { if (socket.url().includes("/events/ws")) sockets.push(socket.url()); });
    const { rowsAt, shellReadCounts } = await observeMineLoad(page, 300);
    await page.goto(minePath(fixture));
    await rowsAt();
    await page.waitForTimeout(5_000);
    const counts = shellReadCounts();
    // The restored session is verified exactly once; that read is what used to reconnect the socket.
    expect(counts["auth/get-session"], JSON.stringify(counts)).toBe(1);
    expect(Object.entries(counts).filter(([, count]) => count > 1), JSON.stringify(counts)).toEqual([]);
    expect(sockets, "The verified session reconnected the live socket").toHaveLength(1);
  } finally { await context.close(); }
});

// Without a saved cache the socket can open only after the company list has
// answered, so the catch-up read that covers events between a read and the
// subscription may repeat reads that answered first. It never repeats the
// session or health read, and the socket is opened once.
test("a first visit never repeats the session or health read", async ({ browser, baseURL }) => {
  const context = await freshContext(browser, baseURL);
  try {
    const page = await context.newPage();
    const sockets: string[] = [];
    page.on("websocket", socket => { if (socket.url().includes("/events/ws")) sockets.push(socket.url()); });
    const { rowsAt, shellReadCounts } = await observeMineLoad(page, 300);
    await page.goto(minePath(fixture));
    await rowsAt();
    await page.waitForTimeout(5_000);
    const counts = shellReadCounts();
    expect({ session: counts["auth/get-session"], health: counts.health }, JSON.stringify(counts)).toEqual({ session: 1, health: 1 });
    expect(Object.entries(counts).filter(([, count]) => count > 2), JSON.stringify(counts)).toEqual([]);
    expect(sockets).toHaveLength(1);
  } finally { await context.close(); }
});
