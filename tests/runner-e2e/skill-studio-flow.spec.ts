import { expect, test } from "@playwright/test";
import { editCreatedSkillThroughStudio } from "./skill-studio-flow.js";

for (const hydrationMs of [0, 1500]) test(`Studio preserves the loaded file before editing (${hydrationMs}ms hydration)`, async ({ page }) => {
  const skillId = "owned-skill", skillName = "owned-qa-skill", marker = "Studio edit marker: owned-campaign";
  let saved = "Verify checks.", saves = 0;
  await page.exposeFunction("saveSkill", (body: string) => { saved = body; saves++; });
  await page.route("https://fixture.test/**", async route => {
    const studio = new URL(route.request().url()).pathname.includes("/skills/studio/");
    const body = studio ? `<button role="combobox">${skillName}</button>
      <div role="textbox" aria-label="editable markdown" contenteditable="true"></div>
      <button id="save">Save</button>
      <script>
        const editor=document.querySelector('[contenteditable]');
        setTimeout(()=>{editor.innerText=${JSON.stringify(saved)}},${hydrationMs});
        document.querySelector('#save').onclick=()=>window.saveSkill(editor.innerText);
      </script>` : `<article aria-label="Skill created: ${skillName}"><button id="card">View skill</button></article>
      <section id="detail" hidden><h2>${skillName}</h2>${saved.split(/\n+/).map(line => `<p>${line}</p>`).join("")}
      <a role="button" href="/QA/skills/studio/${skillId}">Open in Skill Studio</a></section>
      <script>document.querySelector('#card').onclick=()=>document.querySelector('#detail').hidden=false</script>`;
    await route.fulfill({ contentType: "text/html", body });
  });
  await page.goto("https://fixture.test/QA/issues/QA-1");
  await editCreatedSkillThroughStudio({ page, skillId, skillName, marker, deadlineAt: Date.now() + 8000,
    read: async () => ({ content: saved }) });
  expect(saves).toBe(1);
  expect(saved).toContain("Verify checks.");
  expect(saved).toContain(marker);
});

test("Studio never edits or saves an unhydrated file", async ({ page }) => {
  let saves = 0, inputs = 0;
  await page.exposeFunction("savedUnloadedFile", () => { saves++; });
  await page.exposeFunction("editedUnloadedFile", () => { inputs++; });
  await page.route("https://fixture.test/**", route => route.fulfill({ contentType: "text/html", body:
    `<article aria-label="Skill created: owned"><button onclick="document.querySelector('section').hidden=false">View</button></article>
    <section hidden><h2>owned</h2><p>Verify checks.</p><a role="button" href="/QA/skills/studio/id">Open in Skill Studio</a></section>
    <button role="combobox">owned</button><div contenteditable="true" role="textbox" aria-label="editable markdown" oninput="window.editedUnloadedFile()"></div>
    <button onclick="window.savedUnloadedFile()">Save</button>` }));
  await page.goto("https://fixture.test/QA/issues/QA-1");
  await expect(editCreatedSkillThroughStudio({ page, skillId: "id", skillName: "owned", marker: "New content", deadlineAt: Date.now() + 7000,
    read: async () => ({}) })).rejects.toThrow();
  expect(inputs).toBe(0);
  expect(saves).toBe(0);
});
