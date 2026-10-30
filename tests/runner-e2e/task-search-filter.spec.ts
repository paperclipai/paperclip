import { expect, test } from "@playwright/test";
import { taskSearchBacklogCheckbox } from "./product-journeys/task-search-filter.js";

// Reproduce the observed Radix checkbox + StatusIcon + visible text label.
// No app server, provider, browser profile, or target credentials are involved.
for (const presentation of ["legacy", "spaced-legacy", "refreshed"] as const) {
  test(`task search selects Status/Backlog with ${presentation} labels`, async ({ page }) => {
    const explicit = presentation === "refreshed" ? 'aria-label="Backlog"' : "";
    const gap = presentation === "spaced-legacy" ? " " : "";
    await page.setContent(`<div role="dialog" aria-label="Filters">
      <button type="button">Backlog</button>
      <div><span>Status</span><div><label>
        <button id="status-backlog" type="button" role="checkbox" aria-checked="false" ${explicit}></button><svg role="img" aria-label="Backlog"><title>Backlog</title></svg>${gap}<span>Backlog</span>
      </label></div></div>
      <div><span>Responsible</span><label><input id="assignee-backlog" type="checkbox">Backlog</label></div>
    </div><script>
      document.getElementById('status-backlog').addEventListener('click', event => {
        const button = event.currentTarget;
        button.setAttribute('aria-checked', button.getAttribute('aria-checked') !== 'true' ? 'true' : 'false');
      });
    </script>`);
    const filters = page.getByRole("dialog", { name: "Filters", exact: true });
    const statusGroup = filters.getByText("Status", { exact: true }).locator("..");
    // The old exact-name lookup fails for the duplicated legacy label.
    await expect(statusGroup.getByRole("checkbox", { name: "Backlog", exact: true }))
      .toHaveCount(presentation === "refreshed" ? 1 : 0);
    const status = taskSearchBacklogCheckbox(filters);
    await expect(status).toHaveCount(1);
    await status.check();
    await expect(status).toBeChecked();
    await expect(page.locator("#assignee-backlog")).not.toBeChecked();
  });
}
