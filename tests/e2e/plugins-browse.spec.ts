import { expect, test } from "@playwright/test";

test("browse shows capped category blocks that open a full category page", async ({ page, request }) => {
  const res = await request.post("/api/companies", { data: { name: `plugins browse ${Date.now()}` } });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  const prefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";
  try {
    await page.goto(`/${prefix}/apps`);
    await expect(page.getByRole("radio", { name: "All", exact: true })).toBeChecked({ timeout: 30_000 });
    await expect(page.getByRole("radio", { name: "Paperclip", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Most used" })).toBeVisible();

    // A category block holds at most nine plugins, states its full size and links to the rest.
    const block = page.getByRole("region", { name: /^Developer tools \([\d,]+\)$/ });
    await expect(block).toBeVisible();
    await expect(block.getByRole("listitem")).toHaveCount(9);
    const total = Number((await block.getByRole("heading", { level: 2 }).textContent())?.match(/\(([\d,]+)\)/)?.[1].replace(/,/g, ""));
    expect(total).toBeGreaterThan(9);

    await block.getByRole("button", { name: "See all Developer tools" }).click();
    await expect(page).toHaveURL(new RegExp(`/${prefix}/apps/category/developer$`));
    await expect(page.getByText(`Developer tools (${total.toLocaleString("en-US")})`)).toBeVisible();
    await expect(page.getByRole("list", { name: "Connector list" }).getByRole("listitem").nth(9)).toBeVisible();
    await expect(page.getByRole("radio", { name: "All", exact: true })).toHaveCount(0);

    // The Categories list has no counts and opens the same pages.
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    const categories = page.getByRole("navigation", { name: "Categories" });
    await expect(categories.getByRole("button", { name: "Commerce", exact: true })).toBeVisible();
    await categories.getByRole("button", { name: "Commerce", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${prefix}/apps/category/commerce$`));
  } finally {
    await request.delete(`/api/companies/${company.id}`).catch(() => undefined);
  }
});

test("search matches plugin titles, not their descriptions", async ({ page, request }) => {
  const res = await request.post("/api/companies", { data: { name: `plugins search ${Date.now()}` } });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  const prefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";
  try {
    await page.goto(`/${prefix}/apps`);
    const search = page.getByRole("searchbox", { name: "Search plugins" });
    const tiles = page.getByRole("list", { name: "Connector list" }).getByRole("listitem");

    await search.fill("GitHub");
    await expect(tiles.filter({ has: page.getByRole("heading", { name: "GitHub", exact: true }) })).toBeVisible({ timeout: 30_000 });

    // "repositories" appears only in GitHub's description, so it no longer finds GitHub.
    await search.fill("repositories");
    await expect(tiles.filter({ has: page.getByRole("heading", { name: "GitHub", exact: true }) })).toHaveCount(0);
  } finally {
    await request.delete(`/api/companies/${company.id}`).catch(() => undefined);
  }
});
