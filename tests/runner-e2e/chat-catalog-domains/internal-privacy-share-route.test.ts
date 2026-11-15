import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { addProjectAccessMember, projectRouteKey, settleProjectRoute } from "./internal-privacy.js";

const executablePath = process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ?? chromium.executablePath();
const origin = "https://paperclip.example";
const project = { id: "4cc4ccc5-3631-4f96-b650-b892198fcd6f", name: "Acquisition research", urlKey: "acquisition-research" };

// Cohort 15 (projects.share-project): the agent linked /COM/projects/<id>/configuration. The app later replaced that
// route with /COM/projects/acquisition-research/configuration and redrew, which closed the access dialog and detached
// Riley's picker option. Search results render 600 ms after typing. `closePickerOnce` closes the picker panel while
// its first results render, detaching Riley's option the way the cohort-15 redraw did, so the selection must retry.
const page = (redirectAfterMs: number, closePickerOnce: boolean) => `<main id="main"></main><script>
  let pickerClosed = false;
  const draw = () => {
    const main = document.querySelector("#main");
    main.innerHTML = '<button id="manage">Manage access</button><div id="dialogs"></div>';
    document.querySelector("#manage").onclick = () => {
      const dialogs = document.querySelector("#dialogs");
      dialogs.innerHTML = '<div role="dialog" aria-label="Private project access"><button role="combobox" id="picker">Add a person or agent</button>'
        + '<button id="add" disabled>Add</button><div id="panel-host"></div></div>';
      const picker = document.querySelector("#picker"); const add = document.querySelector("#add");
      const openPanel = () => {
        const host = document.querySelector("#panel-host");
        host.innerHTML = '<div role="dialog" aria-label="Add a person or agent"><input placeholder="Search people and agents" id="search"><div id="options"></div></div>';
        document.querySelector("#search").oninput = event => {
          const value = event.target.value; const options = document.querySelector("#options"); options.innerHTML = "";
          setTimeout(() => {
            if (!value.includes("Riley") || !document.body.contains(options)) return;
            const option = document.createElement("div"); option.setAttribute("role", "option"); option.textContent = "Riley";
            option.onclick = () => { picker.textContent = "Riley"; add.disabled = false; host.innerHTML = ""; };
            // The first results are still animating in (not yet visible) when the panel closes and detaches them.
            if (${closePickerOnce} && !pickerClosed) { pickerClosed = true; option.style.visibility = "hidden"; setTimeout(() => { host.innerHTML = ""; }, 200); }
            options.append(option);
          }, 600);
        };
      };
      picker.onclick = () => { if (document.querySelector("#search")) document.querySelector("#panel-host").innerHTML = ""; else openPanel(); };
      add.onclick = () => { document.title = "added:" + location.pathname; };
      openPanel();
    };
  };
  draw();
  setTimeout(() => { history.replaceState(null, "", "/COM/projects/acquisition-research/configuration"); draw(); }, ${redirectAfterMs});
</script>`;

it("uses the app's project route key", () => {
  expect(projectRouteKey(project)).toBe("acquisition-research");
  expect(projectRouteKey({ id: project.id, name: "Acquisition research" })).toBe("acquisition-research");
});

it.skipIf(!existsSync(executablePath))("adds Riley only after the project settles on its canonical route, retrying a closed picker", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const [redirectAfterMs, closePickerOnce] of [[0, false], [400, false], [1_500, false], [0, true]] as const) {
      const label = `${redirectAfterMs}ms${closePickerOnce ? " + closed picker" : ""}`;
      const tab = await browser.newPage({ baseURL: origin });
      await tab.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: page(redirectAfterMs, closePickerOnce) }));
      await tab.goto(`/COM/projects/${project.id}/configuration`);
      await settleProjectRoute(tab, project);
      await tab.getByRole("button", { name: "Manage access", exact: true }).click();
      await addProjectAccessMember(tab, "Riley", { timeout: 10_000 });
      expect(await tab.title(), label).toBe("added:/COM/projects/acquisition-research/configuration");
      await tab.close();
    }
  } finally {
    await browser.close();
  }
}, 60_000);
