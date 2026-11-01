import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 1100 } });
async function openToolbars(page: Page, story = "playground") {
  await page.goto(`/iframe.html?id=design-toolbars--${story}&viewMode=story&globals=theme:dark`);
  await expect(page.getByTestId("toolbars-preview")).toBeVisible();
  return page.getByTestId("toolbars-preview");
}

test("canonical toolbar stories mount the shared components under the proposal theme", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const [story, count] of [["playground", 6], ["tasks", 1], ["decisions", 1], ["skills", 1], ["artifacts", 1], ["projects", 1], ["routines", 1], ["narrow", 6]] as const) {
    const preview = await openToolbars(page, story);
    await expect(page.locator(".design-proposal-theme")).toBeVisible();
    await expect(preview.getByRole("toolbar")).toHaveCount(count);
  }
  expect(errors).toEqual([]);
});

test("task toolbar retains real view, search, layout, expansion and filter controls", async ({ page }) => {
  const preview = await openToolbars(page, "tasks");
  const toolbar = preview.getByRole("toolbar", { name: "Task list controls" });

  await toolbar.getByRole("button", { name: "Task view: All tasks", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Unread", exact: true }).click();
  await expect(toolbar.getByRole("button", { name: "Task view: Unread", exact: true })).toBeVisible();
  await toolbar.getByRole("textbox", { name: "Search tasks", exact: true }).fill("connector");
  await toolbar.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(toolbar.getByRole("textbox", { name: "Search tasks", exact: true })).toHaveValue("");
  await toolbar.getByRole("button", { name: "Board view", exact: true }).click();
  await expect(toolbar.getByRole("button", { name: "Board view", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(toolbar.getByRole("button", { name: /all tasks/ })).toBeDisabled();
  await toolbar.getByRole("button", { name: "List view", exact: true }).click();
  await toolbar.getByRole("button", { name: "Collapse all tasks", exact: true }).click();
  await expect(toolbar.getByRole("button", { name: "Expand all tasks", exact: true })).toBeEnabled();
  await toolbar.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Filters", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await toolbar.getByRole("button", { name: "New Task", exact: true }).click();
  await expect(preview.getByRole("status")).toContainText("New Task requested · local preview only");
});

test("decision menus update local state", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", request => { if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && request.url().includes("/api/")) writes.push(request.url()); });
  const preview = await openToolbars(page);
  const decisions = preview.getByRole("region", { name: "Decisions toolbar", exact: true });
  await decisions.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("button", { name: "Severity", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(decisions.getByRole("status")).toContainText("Group: severity");
  await decisions.getByRole("button", { name: "Sort", exact: true }).click();
  await page.getByRole("button", { name: "Oldest first", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(decisions.getByRole("status")).toContainText("Sort: oldest");
  await decisions.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("button", { name: "Critical", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(decisions.getByRole("status")).toContainText("1 active filters");
  expect(writes).toEqual([]);
});

test("width controls expose narrow wrapping and keyboard focus", async ({ page }) => {
  const preview = await openToolbars(page);
  await preview.getByRole("combobox", { name: "Toolbar container width", exact: true }).selectOption("narrow");
  const specimens = preview.getByTestId("toolbar-specimens");
  await expect(specimens).toHaveAttribute("data-container-width", "narrow");
  expect(await specimens.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const search = preview.getByRole("textbox", { name: "Search tasks", exact: true });
  await search.focus();
  await page.keyboard.press("Tab");
  const list = preview.getByRole("button", { name: "List view", exact: true });
  await expect(list).toBeFocused();
  await expect(list).not.toHaveCSS("box-shadow", "none");
});

test("Skills and Artifacts use their shared production controls with local preview state", async ({ page }) => {
  let preview = await openToolbars(page, "skills");
  await preview.getByRole("textbox", { name: "Search installed skills", exact: true }).fill("review");
  await preview.getByRole("button", { name: "Sort Most agents", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Alphabetical", exact: true }).click();
  await expect(preview.getByRole("status")).toContainText("Search: review · Sort: alphabetical");
  await preview.getByRole("button", { name: "Source All", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "GitHub", exact: true }).click();
  await expect(preview.getByRole("status")).toContainText("Source: github");
  const scan = preview.getByRole("button", { name: "Scan project workspaces for skills", exact: true });
  await scan.click();
  await expect(scan).toBeDisabled();
  await preview.getByRole("button", { name: "Complete simulated scan", exact: true }).click();
  await expect(scan).toBeEnabled();
  await preview.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Create new skill", exact: true }).click();
  await expect(preview.getByRole("status")).toContainText("Create skill requested");
  await preview.getByRole("button", { name: "New folder", exact: true }).click();
  await expect(preview.getByRole("status")).toContainText("New folder requested");
  preview = await openToolbars(page, "artifacts");
  await preview.getByRole("textbox", { name: "Search artifacts", exact: true }).fill("mockup");
  await preview.getByRole("radio", { name: "Images", exact: true }).click();
  await expect(preview.getByRole("radio", { name: "Images", exact: true })).toHaveCSS("font-size", "14px");
  await expect(preview.getByRole("radio", { name: "Images", exact: true })).toHaveCSS("height", "32px");
  await preview.getByTestId("artifact-group-control").click();
  await page.getByTestId("artifact-group-option-parent_task").click();
  await expect(preview.getByRole("status")).toHaveText("Search: mockup · Group: parent_task · Type: image");
  await preview.getByRole("button", { name: "Clear artifact search", exact: true }).click();
  await expect(preview.getByRole("textbox", { name: "Search artifacts", exact: true })).toHaveValue("");
});

test("canonical toolbars share control geometry and keep the requested keyboard order", async ({ page }) => {
  const preview = await openToolbars(page);
  const geometry = await preview.locator("[data-canonical-toolbar]").evaluateAll(toolbars => toolbars.map(toolbar => {
    const search = toolbar.querySelector<HTMLElement>("[data-toolbar-search]")!;
    const first = toolbar.querySelector("input, button")!;
    const controls = [...toolbar.querySelectorAll<HTMLElement>("button:not([data-toolbar-clear], .canonical-tab), [data-toolbar-control]")].filter(button => !button.closest(".design-view-toggle"));
    const style = getComputedStyle(search);
    return { name: toolbar.getAttribute("data-canonical-toolbar"), searchHeight: search.getBoundingClientRect().height, gap: getComputedStyle(toolbar).columnGap,
      border: style.borderColor, radius: style.borderRadius, first: first.getAttribute("aria-label"),
      controls: controls.map(button => ({ height: button.getBoundingClientRect().height, border: getComputedStyle(button).borderColor, radius: getComputedStyle(button).borderRadius })) };
  }));
  expect(geometry).toHaveLength(6);
  for (const toolbar of geometry) {
    expect(toolbar.searchHeight).toBe(44);
    expect(toolbar.gap).toBe("8px");
    expect(toolbar.first).toBe(toolbar.name === "tasks" ? "Task view: All tasks" : toolbar.name === "skills" ? "Search installed skills" : `Search ${toolbar.name}`);
    for (const control of toolbar.controls) {
      expect(control.height).toBe(toolbar.searchHeight);
      expect(control.border).toBe(toolbar.border);
      expect(control.radius).toBe(toolbar.radius);
    }
  }
  const skills = preview.getByRole("toolbar", { name: "Skills controls", exact: true });
  const skillViews = skills.getByRole("navigation", { name: "Skills views" });
  await expect(skillViews.getByRole("link")).toHaveText(["Installed", "Discover", "My Skills"]);
  await expect(skillViews.getByRole("link", { name: "Installed", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(skillViews.getByRole("link", { name: "My Skills", exact: true })).toHaveAttribute("href", /\/skills\/studio$/);
  await expect(skillViews.getByRole("link", { name: "Sources", exact: true })).toHaveCount(0);

  await expect(skills.getByRole("button").last()).toHaveAccessibleName("New");
  const decisions = preview.getByRole("region", { name: "Decisions toolbar", exact: true });
  await decisions.getByRole("textbox", { name: "Search decisions", exact: true }).fill("des-3");
  await expect(decisions.locator("[data-toolbar-count]")).toHaveText("1 decision");
  await decisions.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(decisions.locator("[data-toolbar-count]")).toHaveText("2 decisions");
});

test("Projects toolbar searches, sorts and reports creation locally", async ({ page }) => {
  const preview = await openToolbars(page, "projects");
  await preview.getByRole("textbox", { name: "Search projects", exact: true }).fill("design");
  await preview.getByRole("button", { name: "Sort: Name", exact: true }).click();
  await page.getByRole("button", { name: "Updated", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(preview.getByRole("status")).toContainText("Search: design · Sort: updated · Direction: desc");
  await preview.getByRole("button", { name: "Add Project", exact: true }).click();
  await expect(preview.getByRole("status")).toContainText("Add Project requested · local preview only");
});


test("routines toolbar updates search, sort, group and creation intent", async ({ page }) => {
  const preview = await openToolbars(page, "routines");
  await preview.getByRole("textbox", { name: "Search routines", exact: true }).fill("review");
  await expect(preview.locator("output")).toContainText("Search: review");
  await preview.getByRole("button", { name: "Sort", exact: true }).click();
  await page.getByRole("button", { name: "Title", exact: true }).click();
  await expect(preview.locator("output")).toContainText("Sort: title · Direction: asc");
  await preview.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(preview.locator("output")).toContainText("Group: assignee");
  await expect(preview.getByRole("button", { name: "New folder" })).toHaveCount(0);
  await preview.getByRole("button", { name: "Create routine" }).click();
  await expect(preview.locator("output")).toContainText("Create routine requested");
});
