import { expect, test } from "@playwright/test";

async function finished(page: import("@playwright/test").Page) {
  await expect.poll(() => page.evaluate(() => {
    const channel = (window as unknown as { __STORYBOOK_ADDONS_CHANNEL__?: { data: Record<string, Array<{ status?: string }>> } }).__STORYBOOK_ADDONS_CHANNEL__;
    return channel?.data.storyFinished?.[0]?.status;
  })).toBe("success");
  expect(await page.evaluate(() => (window as unknown as {
    __STORYBOOK_ADDONS_CHANNEL__?: { data: Record<string, unknown[]> };
  }).__STORYBOOK_ADDONS_CHANNEL__?.data.playFunctionThrewException ?? [])).toEqual([]);
}

async function useRealPreviewRequests(page: import("@playwright/test").Page) {
  // Keep the rest of Storybook's fixture API, but count preview requests at
  // the browser HTTP boundary. The saved cache itself is production code.
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    let activeFetch = realFetch;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      get: () => activeFetch,
      set: (fixtureFetch: typeof fetch) => {
        activeFetch = (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          return url.includes("/link-preview?") ? realFetch(input, init) : fixtureFetch(input, init);
        };
      },
    });
  });
}

for (const theme of ["light", "dark"]) {
  for (const state of ["open", "merged", "conflicts", "draft", "closed", "loading", "unavailable", "failed-read", "narrow"]) {
    test(`PR preview ${state} in ${theme}`, async ({ page }, testInfo) => {
      if (state === "narrow") await page.setViewportSize({ width: 390, height: 844 });
      const errors: string[] = [];
      const requests: string[] = [];
      const remote: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => {
        if (request.url().includes("/link-preview?")) requests.push(request.url());
        if (["github.com", "api.github.com"].includes(new URL(request.url()).hostname)) remote.push(request.url());
      });
      await page.goto(`/iframe.html?id=tasks-link-previews--${state}&viewMode=story&globals=theme:${theme}`);
      await finished(page);
      const first = page.getByTestId("first-mention").getByRole("link");
      const second = page.getByTestId("second-mention").getByRole("link");
      const card = page.getByRole("tooltip");
      await expect(first).toHaveAttribute("data-link-state", "unknown");
      const mutedColor = await page.getByText("Hover or focus a link for context. Repeated links share what we learn.")
        .evaluate(element => getComputedStyle(element).color);
      await expect(first).toHaveCSS("color", mutedColor);
      await first.hover({ position: { x: 5, y: 8 } });
      await expect(card).toBeVisible();
      if (["loading", "unavailable", "failed-read"].includes(state)) {
        if (state === "loading") await expect(card.getByRole("status")).toHaveText("Loading pull request…");
        else await expect(card.getByRole("status")).toHaveCount(0);
        await expect(first).toHaveAttribute("data-link-state", "unknown");
      } else {
        await expect(first).toHaveAttribute("data-link-state", state === "narrow" ? "merged" : state);
        await expect(second).toHaveAttribute("data-link-state", state === "narrow" ? "merged" : state);
        if (["draft", "closed"].includes(state)) await expect(first).toHaveCSS("color", mutedColor);
      }
      // Fixture fetches are handled inside the browser and do not become network requests.
      expect(remote).toEqual([]);
      expect(requests).toEqual([]);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (state !== "narrow") {
        const trigger = await first.evaluate(element => element.getClientRects()[0]!.toJSON());
        const before = await card.boundingBox();
        expect(Math.abs(before!.x - trigger!.x)).toBeLessThanOrEqual(2);
        await page.mouse.move(trigger.x + trigger.width - 2, trigger.y + trigger.height / 2);
        const after = await card.boundingBox();
        expect(after!.x).toBeCloseTo(before!.x, 0);
        expect(after!.y).toBeCloseTo(before!.y, 0);
      }
      await expect(second).toHaveAttribute("href", "https://www.github.com/Acme/Web/pull/241/files?diff=split#discussion_r123");
      await page.screenshot({ path: testInfo.outputPath(`pr-preview-${state}-${theme}.png`), fullPage: true });
      await first.press("Escape");
      await expect(card).toBeHidden();
      await second.focus();
      await expect(card).toBeVisible();
      await expect(second).toHaveAttribute("aria-describedby");
    });
  }
}

test("one deferred HTTP lookup updates repeated links and is reused on later hover", async ({ page }) => {
  let count = 0;
  await page.route("**/api/companies/company-storybook/link-preview?*", async route => {
    count++;
    const canonicalUrl = new URL(route.request().url()).searchParams.get("url");
    await route.fulfill({ json: {
      preview: { target: { provider: "github", kind: "pull_request", canonicalUrl, label: "acme/web#241" }, title: "Shared result", state: "merged", author: "octocat", updatedAt: null },
      maxAgeMs: 60_000,
    } });
  });
  // Neutral has no opening play step. Replace fixture fetch only for this read
  // so it crosses the browser's real HTTP boundary and can be counted.
  await useRealPreviewRequests(page);
  await page.goto("/iframe.html?id=tasks-link-previews--neutral&viewMode=story");
  await finished(page);
  expect(count).toBe(0);
  const links = page.locator("a[data-link-state]");
  await links.first().hover({ position: { x: 5, y: 8 } });
  await expect(links.first()).toHaveAttribute("data-link-state", "merged");
  await expect(links.nth(1)).toHaveAttribute("data-link-state", "merged");
  expect(count).toBe(1);
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toBeHidden();
  await links.nth(1).hover({ position: { x: 5, y: 8 } });
  await expect(page.getByRole("tooltip")).toBeVisible();
  expect(count).toBe(1);
});

for (const available of [true, false]) {
  test(`PR cache survives reload and refreshes only on stale interest (available=${available})`, async ({ page }, testInfo) => {
    let count = 0;
    await page.route("**/api/companies/company-storybook/link-preview?*", async route => {
      count++;
      const canonicalUrl = new URL(route.request().url()).searchParams.get("url");
      await route.fulfill({ json: {
        preview: available ? {
          target: { provider: "github", kind: "pull_request", canonicalUrl, label: "acme/web#241" },
          title: "Saved PR status", state: count === 1 ? "merged" : "open", author: "octocat", updatedAt: null,
        } : null,
        maxAgeMs: 60_000,
      } });
    });
    await useRealPreviewRequests(page);
    await page.clock.install();
    await page.goto("/iframe.html?id=tasks-link-previews--reload-cache&viewMode=story");
    await finished(page);
    const links = page.locator("a[data-link-state]");
    const expectedState = available ? "merged" : "unknown";
    await expect(links.first()).toHaveAttribute("data-link-state", "unknown");
    expect(count).toBe(0);
    await links.first().hover({ position: { x: 5, y: 8 } });
    await expect(page.getByRole("tooltip")).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(links.nth(1)).toHaveAttribute("data-link-state", expectedState);
    expect(count).toBe(1);
    // pagehide must flush even if reload beats the normal debounce.
    await page.reload();
    await finished(page);
    await expect(links.first()).toHaveAttribute("data-link-state", expectedState);
    await expect(links.nth(1)).toHaveAttribute("data-link-state", expectedState);
    expect(count).toBe(1);
    await links.nth(1).focus();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    expect(count).toBe(1);
    await page.screenshot({ path: testInfo.outputPath(`pr-cache-after-reload-${available}.png`), fullPage: true });
    await links.nth(1).blur();
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toBeHidden();
    await page.clock.setSystemTime(new Date(Date.now() + 120_000));
    await page.reload();
    await finished(page);
    // Expiry preserves the last known display. It never fetches on render.
    await expect(links.first()).toHaveAttribute("data-link-state", expectedState);
    expect(count).toBe(1);
    await links.first().focus();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await expect.poll(() => count).toBe(2);
    await expect(links.nth(1)).toHaveAttribute("data-link-state", available ? "open" : "unknown");
  });
}
