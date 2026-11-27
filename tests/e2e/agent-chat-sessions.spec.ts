import { expect, test } from "@playwright/test";

import { idle, json, send, setup } from "./agent-chat.shared";

test.use({ trace: "retain-on-failure" });
test.setTimeout(120_000);

/**
 * Agent chat session lifecycle coverage: service-worker boot, first-open
 * semantics, and retired opt-outs. Shared fixtures live in
 * ./agent-chat.shared.ts; Stop + /new reset and sidebar navigation run in
 * agent-chat-sessions-navigation.spec.ts; project/history flows run in
 * agent-chat-projects.spec.ts.
 */
test("built chat initializes after service worker takeover and reload with a slow CPU", async ({
  page,
  context,
  request,
}) => {
  const f = await setup(request);
  try {
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.goto(f.route);
      // These navigations deliberately parse and mount the shipped UI at 4x
      // CPU throttling. Bound initial readiness separately from assertions on
      // an already rendered page; the default five seconds is too short in CI.
      await expect(page.getByTestId("task-chat-composer-input")).toBeVisible({ timeout: 30_000 });
      // The failed CI traces stopped before React evaluated, while a service
      // worker forwarded the Vite module graph. Keep this test on shipped assets
      // and cover both first takeover and subsequent controlled navigations.
      const scripts = await page.locator('script[type="module"][src]').evaluateAll(
        (elements) => elements.map((element) => element.getAttribute("src")),
      );
      expect(scripts.length).toBeGreaterThan(0);
      expect(scripts.every((src) => src?.startsWith("/assets/"))).toBe(true);
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await page.reload();
      await expect(page.getByTestId("task-chat-composer-input")).toBeVisible({ timeout: 30_000 });
      expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      expect(await json(await request.get(f.chatPath))).toBeNull();
    } finally {
      await cdp.detach();
    }
  } finally {
    await f.restore();
  }
});

test("chat first open is read-only; concurrent first sends and retries share one task", async ({
  page,
  context,
  request,
}) => {
  const f = await setup(request);
  try {
    await page.goto(f.route);
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    expect(await json(await request.get(f.chatPath))).toBeNull();
    expect(
      await json(
        await request.get(`/api/companies/${f.company.id}/heartbeat-runs`),
      ),
    ).toHaveLength(0);
    const other = await context.newPage();
    await other.goto(f.route);
    await Promise.all([send(page, "Same first message"), send(other, "Same first message")]);
    const issue = await idle(request, f.chatPath, 2);
    const initialComments = await json(await request.get(`/api/issues/${issue.id}/comments`));
    expect(initialComments.filter((comment: any) => !comment.authorAgentId && comment.body === "Same first message")).toHaveLength(2);
    const resolved = await Promise.all(
      Array.from({ length: 4 }, () =>
        request.post(f.chatPath, { data: {} }).then(json),
      ),
    );
    expect(new Set(resolved.map((row) => row.id))).toEqual(new Set([issue.id]));
    const body = {
      body: "Retry once",
      clientRequestId: "00000000-0000-4000-8000-000000000001",
    };
    const replies = await Promise.all([
      request
        .post(`/api/issues/${issue.id}/comments`, { data: body })
        .then(json),
      request
        .post(`/api/issues/${issue.id}/comments`, { data: body })
        .then(json),
    ]);
    expect(replies[0].id).toBe(replies[1].id);
    await idle(request, f.chatPath, 3);
    await page.reload();
    await expect(
      page.getByText("Reply generation 0: Retry once", { exact: true }),
    ).toBeVisible();
    expect(
      await json(await request.get(`/api/companies/${f.company.id}/issues`)),
    ).toHaveLength(0);
    const dashboard = await json(
      await request.get(`/api/companies/${f.company.id}/dashboard`),
    );
    expect(dashboard.tasks).toEqual({
      open: 0,
      inProgress: 0,
      blocked: 0,
      done: 0,
    });
    const count = (
      await json(
        await request.get(`/api/companies/${f.company.id}/heartbeat-runs`),
      )
    ).length;
    await page.goto(`/${f.company.issuePrefix}/issues/${issue.identifier}`);
    await page.goto(f.route);
    expect(
      await json(
        await request.get(`/api/companies/${f.company.id}/heartbeat-runs`),
      ),
    ).toHaveLength(count);
    await other.close();
  } finally {
    await f.restore();
  }
});

test("retired Chat opt-outs allow sends and resets while preserving existing history", async ({
  page,
  request,
}) => {
  const f = await setup(request);
  try {
    await page.goto(f.route);
    await send(page, "Visible history");
    const issue = await idle(request, f.chatPath);
    await json(
      await request.patch("/api/instance/settings/experimental", {
        data: { enableAgentChat: false },
      }),
    );
    for (const body of ["Available to existing people", "/new"])
      expect(
        (
          await request.post(`/api/issues/${issue.id}/comments`, {
            data: { body, clientRequestId: crypto.randomUUID() },
          })
        ).status(),
      ).toBe(201);
    await page.reload();
    await expect(page.getByText("Visible history", { exact: true }).first()).toBeVisible();
    expect(
      (await json(await request.get(`/api/issues/${issue.id}/comments`))).some(
        (c: any) => c.body.includes("Visible history"),
      ),
    ).toBe(true);
    expect((await request.post(f.chatPath, { data: {} })).status()).toBe(200);
  } finally {
    await f.restore();
  }
});
