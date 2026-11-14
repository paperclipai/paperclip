import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectResults, taskSearchBacklogCheckbox, taskSearchResultIds } from "./product-journeys/task-search-filter.js";
import type { SearchTask } from "./product-journeys/task-search-evidence.js";

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

const searchTasks: SearchTask[] = ["target", "status-control", "search-control"].map((name, index) => ({
  id: name, identifier: `QA-${index + 1}`, companyId: "company", title: name, description: `${name} context`,
  status: index === 1 ? "done" : "backlog", assigneeUserId: "board", assigneeAgentId: null,
}));
const taskLink = (task: SearchTask) => `<a data-inbox-issue-link href="https://paperclip.example.test/QA/issues/${task.identifier}">${task.title}</a>`;

test("task search readback survives a search rerender that removes an observed row", async ({ page }) => {
  page.setDefaultTimeout(150); // Bound only the reproduced stale-index wait.
  await page.setContent(`<main id="main-content">${searchTasks.map(taskLink).join("")}</main>`);
  let transitions = 0;
  let batches = 0;
  let detachedReads = 0;
  let invalidReads = 0;
  const transition = async () => {
    if (transitions++) return;
    await page.locator("main#main-content").evaluate((main, html) => { main.innerHTML = html; }, searchTasks.slice(0, 2).map(taskLink).join(""));
  };
  // Keep browser operations and the journey's poll real. Hold actual DOM nodes
  // across the first render so the reader must recover from a detached batch.
  const withTransition = (source: Locator): Locator => new Proxy(source, {
    get(object, property, receiver) {
      if (property === "all") return async () => (await object.all()).map((row, index) => index !== 2 ? row : new Proxy(row, {
        get(element, operation, elementReceiver) {
          if (operation === "isVisible") return async (...args: Parameters<Locator["isVisible"]>) => {
            const visible = await element.isVisible(...args);
            if (visible) await transition();
            return visible;
          };
          const value = Reflect.get(element, operation, elementReceiver);
          return typeof value === "function" ? value.bind(element) : value;
        },
      }));
      if (property === "filter") return (...args: Parameters<Locator["filter"]>) => withTransition(object.filter(...args));
      if (property === "evaluateAll") return async (...args: Parameters<Locator["evaluateAll"]>) => {
        batches++;
        if (batches === 1) {
          const held = await page.evaluateHandle(() => Array.from(document.querySelectorAll<HTMLAnchorElement>("main#main-content a[data-inbox-issue-link]")));
          try {
            await transition();
            const detached = await held.evaluate(...args);
            expect(detached).toBeNull();
            detachedReads++;
            // A later connected snapshot can still be wrong. The same poll
            // must reject its extra control before accepting the final pair.
            await page.locator("main#main-content").evaluate((main, html) => { main.innerHTML = html; }, searchTasks.map(taskLink).join(""));
            return detached;
          } finally { await held.dispose(); }
        }
        const result = await object.evaluateAll(...args);
        if (batches === 2) {
          expect(result).toHaveLength(3);
          invalidReads++;
          await page.locator("main#main-content").evaluate((main, html) => { main.innerHTML = html; }, searchTasks.slice(0, 2).map(taskLink).join(""));
        }
        return result;
      };
      const value = Reflect.get(object, property, receiver);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  const observedPage = new Proxy(page, {
    get(object, property, receiver) {
      if (property === "locator") return (...args: Parameters<Page["locator"]>) => withTransition(object.locator(...args));
      const value = Reflect.get(object, property, receiver);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  await expect(expectResults(observedPage, searchTasks, ["target", "status-control"]))
    .resolves.toEqual(["status-control", "target"]);
  expect(transitions).toBe(1);
  expect(detachedReads).toBe(1);
  expect(invalidReads).toBe(1);
  expect(batches).toBe(3);
  await expect(page.locator("a[data-inbox-issue-link]")).toHaveCount(2);
});

for (const fixture of [
  { name: "extra owned control", html: searchTasks.map(taskLink).join(""), ids: ["search-control", "status-control", "target"] },
  { name: "duplicate target", html: [...searchTasks.slice(0, 2), searchTasks[0]!].map(taskLink).join(""), ids: ["status-control", "target", "target"] },
  { name: "unknown destination", html: searchTasks.slice(0, 2).map(taskLink).join("") + taskLink({ ...searchTasks[2]!, identifier: "QA-99" }), ids: ["status-control", "target", "unknown:QA-99"] },
  { name: "wrong target destination", html: taskLink(searchTasks[1]!) + taskLink({ ...searchTasks[0]!, identifier: "QA-2" }), ids: ["status-control", "status-control"] },
]) {
  test(`task search snapshot preserves invalid evidence: ${fixture.name}`, async ({ page }) => {
    await page.setContent(`<main id="main-content">${fixture.html}</main>`);
    const ids = await taskSearchResultIds(page, searchTasks);
    expect(ids).toEqual(fixture.ids);
    expect(ids).not.toEqual(["status-control", "target"]);
  });
}

test("task search snapshot retains the existing visible-link scope", async ({ page }) => {
  await page.setContent(`<main id="main-content">${searchTasks.slice(0, 2).map(taskLink).join("")}
    <div hidden>${taskLink(searchTasks[2]!)}</div></main>
    ${taskLink({ ...searchTasks[2]!, identifier: "QA-99" })}`);
  expect(await taskSearchResultIds(page, searchTasks)).toEqual(["status-control", "target"]);
});
