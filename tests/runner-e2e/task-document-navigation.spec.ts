import { expect, test } from "@playwright/test";
import { reopenTaskDocument } from "./product-journeys/task-document-flow.js";
import type { JourneyContext } from "./product-journeys/types.js";

for (const layout of ["collapsed", "artifacts", "launcher", "classic"] as const) {
  test(`document reopen waits for the ${layout} task controls after reload`, async ({ page }) => {
    const issue = { title: "Journey QA document navigation" };
    let taskLoads = 0;
    await page.route("https://document-navigation.test/**", async route => {
      if (new URL(route.request().url()).pathname.endsWith("/issues")) {
        await route.fulfill({ contentType: "text/html", body: `<a href="/QA/issues/QA-201">${issue.title}</a>` });
        return;
      }
      taskLoads++;
      await route.fulfill({ contentType: "text/html", body: `<main><div id="controls"></div></main><script>
        const controls = document.querySelector('#controls');
        function authoring() { controls.innerHTML = '<button>New document</button><section id="document-qa-note">Saved revision two</section>'; }
        function panel() {
          controls.innerHTML = ${JSON.stringify(layout === "artifacts" ? '<button role="tab">Artifacts</button>' : '<button>Open a new tab</button>')};
          controls.querySelector('button').onclick = ${layout === "artifacts" ? "authoring" : `() => { controls.innerHTML = '<div role="option">Artifacts</div>'; controls.querySelector('[role="option"]').onclick = authoring; }`};
        }
        setTimeout(() => {
          ${layout === "classic" ? "authoring();" : layout === "collapsed" ? `controls.innerHTML = '<button>Show properties</button>'; controls.querySelector('button').onclick = () => setTimeout(panel, 100);` : "panel();"}
        }, 200);
        </script>` });
    });
    const context = { page, api: { origin: "https://document-navigation.test" }, company: { issuePrefix: "QA" } } as JourneyContext;
    await reopenTaskDocument(context, issue);
    await expect(page.locator("#document-qa-note")).toHaveText("Saved revision two");
    expect(taskLoads).toBe(2);
  });
}

test("document reopen fails when the task has no authoring controls", async ({ page }) => {
  await page.route("https://document-navigation.test/**", async route => {
    const list = new URL(route.request().url()).pathname.endsWith("/issues");
    await route.fulfill({ contentType: "text/html", body: list ? '<a href="/QA/issues/QA-201">Journey QA document navigation</a>' : '<main>Task without document permissions</main>' });
  });
  const context = { page, api: { origin: "https://document-navigation.test" }, company: { issuePrefix: "QA" } } as JourneyContext;
  await expect(reopenTaskDocument(context, { title: "Journey QA document navigation" })).rejects.toThrow();
  await expect(page.getByRole("button", { name: "New document", exact: true })).toHaveCount(0);
});
