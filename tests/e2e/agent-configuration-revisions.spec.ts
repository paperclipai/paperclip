import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { document, edit, expect, json, save, setup, test } from "./agent-configuration.shared";

test("stale drafts and invalid commands leave saved configuration unchanged", async ({ page, request }) => {
  const { agent, url } = await setup(request);
  await page.goto(`${url}/advanced`);
  await edit(page, value => { value.spec.title = "Local draft"; });
  await json(await request.patch(`/api/agents/${agent.id}`, { data: { title: "Other operator" } }));
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("changed while you were editing");
  expect((await document(page)).spec.title).toBe("Local draft");
  expect((await json(await request.get(`/api/agents/${agent.id}/configuration`))).title).toBe("Other operator");
  await page.getByRole("button", { name: "Reload saved", exact: true }).click();
  await expect.poll(async () => (await document(page)).spec.title).toBe("Other operator");
  await edit(page, value => { value.observed = {}; });
  await expect(page.getByRole("alert")).toContainText("observed is read-only");
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
});

test("renaming an agent keeps newly created key tokens visible through the route change", async ({ page, request }) => {
  const { agent, url } = await setup(request);
  await page.goto(`${url}/advanced`);
  await edit(page, value => {
    value.spec.name = "Renamed YAML engineer";
    value.spec.apiKeys = { create: [{ name: "Rename key", scope: { kind: "standard" } }] };
  });
  await save(page);
  await expect(page).toHaveURL(/\/agents\/renamed-yaml-engineer\/advanced$/);
  const token = page.getByRole("textbox", { name: "API key: Rename key token" });
  await expect(token).toBeVisible();
  const created = await token.inputValue();
  expect(created).toMatch(/^pcp_/);
  expect(stringify(await document(page))).not.toContain(created);
  expect(await json(await request.get(`/api/agents/${agent.id}/keys`))).toHaveLength(1);
  await edit(page, value => { value.spec.title = "Another saved edit"; });
  await save(page);
  await expect(token).toHaveValue(created);
});

test("a lost creation response requires reload and cannot blindly replay commands", async ({ page, request }) => {
  const { agent, url } = await setup(request);
  let creates = 0;
  await page.route(`**/api/agents/${agent.id}/keys?*`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    creates++;
    if (creates === 1) return route.continue();
    await route.fetch();
    return route.abort("failed");
  });
  await page.goto(`${url}/advanced`);
  await edit(page, value => {
    value.spec.name = "Partially renamed YAML engineer";
    value.spec.title = "Saved before lost response";
    value.spec.apiKeys = { create: ["First key", "Second key"].map(name => ({ name, scope: { kind: "standard" } })) };
  });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Reload saved before saving again");
  await expect(page.getByRole("textbox", { name: "API key: First key token" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect((await json(await request.get(`/api/agents/${agent.id}/configuration`))).title).toBe("Saved before lost response");
  expect(await json(await request.get(`/api/agents/${agent.id}/keys`))).toHaveLength(2);
  await page.evaluate(() => window.document.addEventListener("copy", event => {
    event.clipboardData?.setData("text/plain", "Skip to Main Content\napiVersion: paperclip/v1\nCopied surrounding page text");
    event.preventDefault();
  }, { capture: true, once: true }));
  expect((await document(page)).spec.apiKeys!.create).toHaveLength(2);
  await page.getByRole("button", { name: "Reload saved", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/partially-renamed-yaml-engineer\/advanced$/);
  await expect(page.getByRole("button", { name: "Reload saved", exact: true })).toBeEnabled();
  expect((await document(page)).spec.apiKeys).toBeUndefined();
  await expect(page.getByRole("textbox", { name: "API key: First key token" })).toBeVisible();
  await edit(page, value => { value.spec.title = "Recovered save"; });
  await save(page);
  expect(creates).toBe(2);
  expect(await json(await request.get(`/api/agents/${agent.id}/keys`))).toHaveLength(2);
});

test("switching instructions location loads existing destination files without overwriting them", async ({ page, request }) => {
  const { agent, url } = await setup(request);
  await json(await request.patch(`/api/agents/${agent.id}/instructions-bundle`, { data: { mode: "managed" } }));
  const destination = await mkdtemp(path.join(os.tmpdir(), "agent-yaml-instructions-"));
  await writeFile(path.join(destination, "AGENTS.md"), "Keep destination instructions.\n");
  await page.goto(`${url}/advanced`);
  await edit(page, value => { value.spec.instructions!.mode = "external"; value.spec.instructions!.rootPath = destination; });
  await save(page);
  expect((await document(page)).spec.instructions).not.toHaveProperty("files");
  expect(await readFile(path.join(destination, "AGENTS.md"), "utf8")).toBe("Keep destination instructions.\n");
});

test("revision restore is an explicit separate save and reloads the restored configuration", async ({ page, request }) => {
  const { agent, url } = await setup(request);
  await page.goto(`${url}/advanced`);
  await edit(page, value => { value.spec.title = "Before restore"; });
  await save(page);
  const revisions = await json(await request.get(`/api/agents/${agent.id}/config-revisions`));
  const revision = revisions.find((row: { changedKeys: string[] }) => row.changedKeys.includes("title"));
  expect(revision).toBeTruthy();
  await edit(page, value => { value.spec.title = "After restore target"; });
  await save(page);
  await edit(page, value => { value.spec.revisions = { restore: revision.id }; value.spec.title = "Conflicting edit"; });
  await expect(page.getByRole("alert")).toContainText("Restore a revision in its own save");
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await edit(page, value => { value.spec.title = "After restore target"; });
  await save(page);
  await page.reload();
  const restored = await document(page);
  expect(restored.spec.title).toBe("Before restore");
  expect(restored.spec.revisions).toBeUndefined();
});
