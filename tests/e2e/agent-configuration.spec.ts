import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test as base, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { parse, stringify } from "yaml";
import type { AgentConfigurationInput } from "@paperclipai/shared";
import { startReviewProvider } from "../fixtures/connection-review-provider";

const test = base.extend<{ toolProvider: Awaited<ReturnType<typeof startReviewProvider>>; settings: void }>({
  settings: [async ({ request }, use) => {
    const previous = await json(await request.get("/api/instance/settings/experimental"));
    try {
      await json(await request.patch("/api/instance/settings/experimental", { data: { enableBetaSkills: true, enableChatConnectors: true } }));
      await use();
    } finally {
      await json(await request.patch("/api/instance/settings/experimental", { data: {
        enableBetaSkills: previous.enableBetaSkills, enableChatConnectors: previous.enableChatConnectors,
      } }));
    }
  }, { auto: true }],
  toolProvider: async ({}, use) => {
    const provider = await startReviewProvider();
    try { await use(provider); }
    finally { await provider.close(); }
  },
});

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function setup(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Agent YAML ${Date.now()}` } }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
    name: "YAML engineer", role: "engineer", adapterType: "process", adapterConfig: { command: "true", removable: "old value" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  } }));
  return { company, agent, url: `/${company.issuePrefix}/agents/${agent.urlKey}` };
}

const editor = (page: Page) => page.getByRole("textbox", { name: "Agent YAML configuration" });
async function document(page: Page): Promise<AgentConfigurationInput> {
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  let source = "";
  // Keep the selection inside the editor across configuration rerenders.
  // Never parse a whole-page selection or a prior clipboard value as YAML.
  await expect.poll(async () => {
    await editor(page).click();
    await editor(page).press("ControlOrMeta+a");
    const selectedEditor = await editor(page).evaluate(element => {
      const selection = window.getSelection();
      return document.activeElement === element && !!selection?.anchorNode && !!selection.focusNode
        && element.contains(selection.anchorNode) && element.contains(selection.focusNode);
    });
    if (!selectedEditor) return false;
    // Capture the editor's copy event without sharing the OS clipboard with
    // other browser tests or the person using this computer.
    source = await editor(page).evaluate(element => {
      const clipboardData = new DataTransfer();
      element.dispatchEvent(new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }));
      return clipboardData.getData("text/plain");
    });
    return /^apiVersion: paperclip\/v1(?:\r?\n|$)/.test(source);
  }, { message: "Copy the current YAML from the focused editor" }).toBe(true);
  return parse(source);
}
async function edit(page: Page, change: (value: AgentConfigurationInput) => void) {
  const value = await document(page);
  change(value);
  await editor(page).press("ControlOrMeta+a");
  await page.keyboard.insertText(stringify(value, { lineWidth: 0 }));
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Reload saved", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
}

test("Secrets shows masked inline variables and preserves them when another variable is saved", async ({ page, request }) => {
  const { company, agent, url } = await setup(request);
  const secret = await json(await request.post(`/api/companies/${company.id}/secrets`, { data: {
    name: "Release credential", value: "disposable-reference-credential",
  } }));
  await json(await request.patch(`/api/agents/${agent.id}`, { data: { adapterConfig: {
    command: "true",
    env: {
      RELEASE_WEBHOOK: { type: "plain", value: "disposable-inline-credential" },
      SHARED_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" },
    },
  } } }));

  await page.goto(`${url}/secrets`);
  const variableNames = () => page.getByRole("textbox", { name: "Variable name", exact: true })
    .evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value).sort());
  await expect(page.getByRole("heading", { name: "Environment variables", exact: true })).toBeVisible();
  await expect.poll(variableNames).toEqual(["RELEASE_WEBHOOK", "SHARED_TOKEN"]);
  await expect(page.getByLabel("Variable value", { exact: true })).toHaveValue("***REDACTED***");
  await expect(page.getByText("Release credential", { exact: true }).first()).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain("disposable-inline-credential");
  const before = await json(await request.get(`/api/agents/${agent.id}/configuration`));
  expect(before.configurationRevision).toMatch(/^[a-f0-9]{64}$/);

  await page.getByRole("button", { name: "Add variable", exact: true }).click();
  await page.getByRole("textbox", { name: "Variable name", exact: true }).last().fill("RELEASE_CHANNEL");
  await page.getByLabel("Variable value", { exact: true }).last().fill("drafts");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  const config = await json(await request.get(`/api/agents/${agent.id}/configuration`));
  expect(config.adapterConfig.env).toMatchObject({
    RELEASE_WEBHOOK: { type: "plain", value: "***REDACTED***" },
    SHARED_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" },
    RELEASE_CHANNEL: { type: "plain", value: "***REDACTED***" },
  });
  await page.reload();
  await expect.poll(variableNames).toEqual(["RELEASE_CHANNEL", "RELEASE_WEBHOOK", "SHARED_TOKEN"]);
  await expect(page.getByLabel("Variable value", { exact: true }).first()).toHaveValue("***REDACTED***");
  await page.getByRole("button", { name: "Remove RELEASE_CHANNEL", exact: true }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  const after = await json(await request.get(`/api/agents/${agent.id}/configuration`));
  // The server's opaque revision includes the actual hidden values. Returning
  // to the same revision proves they survived both saves without reading them.
  expect(after.configurationRevision).toBe(before.configurationRevision);
});

test("compact YAML stays small as the company grows and preserves hidden configuration", async ({ page, request }) => {
  const { company, agent, url } = await setup(request);
  await json(await request.patch(`/api/agents/${agent.id}/instructions-bundle`, { data: { mode: "managed" } }));
  const entry = await json(await request.get(`/api/agents/${agent.id}/instructions-bundle/file?path=AGENTS.md`));
  const instructions = "Keep the agent instructions outside its YAML configuration.\n".repeat(500);
  await json(await request.put(`/api/agents/${agent.id}/instructions-bundle/file`, { data: {
    path: "AGENTS.md", content: instructions, baseHash: entry.contentHash, baseRevisionId: entry.revision?.id ?? null,
  } }));
  const profiles = [];
  for (let index = 0; index < 8; index++) profiles.push(await json(await request.post(`/api/companies/${company.id}/tools/profiles`, { data: {
    profileKey: `profile-${index}`, name: `Profile ${index}`, defaultAction: "deny",
    entries: Array.from({ length: 30 }, (_, tool) => ({ selectorType: "tool_name", effect: "include", toolName: `fixture_tool_${tool}` })),
  } })));
  await json(await request.post(`/api/companies/${company.id}/tools/profiles/${profiles[0].id}/bind`, { data: { targetType: "agent", targetId: agent.id, priority: 100 } }));
  await page.goto(`${url}/advanced`);
  const compact = await document(page);
  const source = stringify(compact);
  expect(source.split("\n").length).toBeLessThan(60);
  for (const omitted of ["observed:", "fixture_tool_", "profile-7", "Keep the agent instructions", "create:", "metadata: null"]) expect(source).not.toContain(omitted);
  expect(compact.spec.tools?.profiles).toEqual([{ profileKey: "profile-0" }]);
  expect(compact.spec.instructions).toEqual({ mode: "managed", entryFile: "AGENTS.md" });
  await edit(page, value => { value.spec = { title: "Sparse saved edit" }; });
  await save(page);
  const saved = await json(await request.get(`/api/agents/${agent.id}/configuration`));
  expect(saved.name).toBe(agent.name);
  expect(saved.adapterConfig).toMatchObject({ command: "true", removable: "old value" });
  expect((await json(await request.get(`/api/agents/${agent.id}/instructions-bundle/file?path=AGENTS.md`))).content).toBe(instructions);
  await edit(page, value => { value.spec.tools = { profiles: [{ profileKey: "profile-0" }, { profileKey: "profile-1" }] }; });
  await save(page);
  const selected = await json(await request.get(`/api/companies/${company.id}/tools/profiles`));
  expect(selected.profiles.find((profile: { id: string }) => profile.id === profiles[1].id).bindings).toContainEqual(expect.objectContaining({ targetType: "agent", targetId: agent.id }));
  for (const profile of selected.profiles.filter((profile: { id: string }) => profiles.some(created => created.id === profile.id))) expect(profile.entries).toHaveLength(30);
});

test("Advanced YAML persists settings and commands through their real resource APIs", async ({ page, request, toolProvider }, info) => {
  test.setTimeout(120_000);
  const { company, agent, url } = await setup(request);
  await json(await request.patch(`/api/agents/${agent.id}/instructions-bundle`, { data: { mode: "managed" } }));
  const skill = await json(await request.post(`/api/companies/${company.id}/skills`, { data: {
    name: "YAML proof", slug: "yaml-proof", markdown: "---\nname: yaml-proof\ndescription: Verify saved configuration.\n---\nCheck the persisted state.\n",
  } }));
  const connection = await json(await request.post(`/api/companies/${company.id}/tools/connections`, { data: {
    name: "YAML tools", transport: "mcp_remote", config: { url: toolProvider.url }, status: "draft", enabled: false,
  } }));
  await page.goto(`${url}/overview`);
  await page.getByRole("link", { name: "Advanced", exact: true }).click();
  await edit(page, value => {
    value.spec.title = "Saved YAML engineer";
    value.spec.budgetMonthlyCents = 12300;
    delete value.spec.adapterConfig!.removable;
    value.spec.adapterConfig!.env = { YAML_VARIABLE: { type: "plain", value: "saved variable" } };
    value.spec.instructions!.files = { "workflow.md": "Saved through YAML.\n" };
    value.spec.skills = [{ key: skill.key, versionId: skill.currentVersionId }];
    value.spec.tools = { connections: [{ connectionId: connection.id }] };
    value.spec.tools!.profiles = [{ profileId: null, priority: 100, metadata: null, configuration: {
      profileKey: "yaml-profile", name: "YAML profile", description: null, status: "active", defaultAction: "deny", metadata: null,
      entries: [{ selectorType: "tool_name", toolName: "read_repository", effect: "include" }],
    } }];
    value.spec.tools!.policies = [{ id: null, configuration: { name: "YAML block", policyType: "block", priority: 100, enabled: true, selectors: { agentIds: [agent.id], toolNames: ["delete_repository"] } } }];
    value.spec.permissions = { canCreateSkills: false };
    value.spec.secrets = { create: [{ secret: { name: "YAML secret", value: "disposable-yaml-secret" }, bind: { env: ["YAML_SECRET"], api: [] } }] };
    value.spec.apiKeys = { create: [{ name: "YAML automation", scope: { kind: "standard" } }] };
    value.spec.channelOperations = { create: [{ provider: "telegram" }] };
  });
  await save(page);
  const token = page.getByRole("textbox", { name: "API key: YAML automation token" });
  await expect(token).toBeVisible();
  expect(await token.inputValue()).toMatch(/^pcp_/);
  await page.reload();
  const saved = await document(page);
  expect(saved.spec).toMatchObject({ title: "Saved YAML engineer", budgetMonthlyCents: 12300, permissions: { canCreateSkills: false } });
  expect(saved.spec.adapterConfig).not.toHaveProperty("removable");
  expect(saved.spec.adapterConfig!.env).toMatchObject({ YAML_VARIABLE: { type: "plain", value: "***REDACTED***" }, YAML_SECRET: { type: "secret_ref" } });
  expect(stringify(saved)).not.toContain("disposable-yaml-secret");
  expect(saved.spec.instructions).not.toHaveProperty("files");
  expect((await json(await request.get(`/api/agents/${agent.id}/instructions-bundle/file?path=workflow.md`))).content).toBe("Saved through YAML.\n");
  expect(saved.spec.skills).toEqual([{ key: skill.key, versionId: skill.currentVersionId }]);
  expect(saved.spec.tools!.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ profileKey: "yaml-profile" })]));
  expect(saved.spec.tools!.policies).toEqual([expect.objectContaining({ id: expect.any(String), configuration: expect.objectContaining({ name: "YAML block" }) })]);
  expect(saved.spec.channels).toEqual([expect.objectContaining({ provider: "telegram" })]);
  expect(saved.spec.apiKeys).toBeUndefined();
  expect(saved.spec.secrets).toBeUndefined();
  expect(saved.spec.channelOperations).toBeUndefined();
  await edit(page, value => { value.spec.skills = [skill.key]; });
  await save(page);
  expect((await document(page)).spec.skills).toEqual([skill.key]);
  let repeatedSkillSyncs = 0;
  page.on("request", event => {
    if (event.method() === "POST" && new URL(event.url()).pathname === `/api/agents/${agent.id}/skills/sync`) repeatedSkillSyncs++;
  });
  await edit(page, value => { value.spec.title = "Unpinned skill stays unchanged"; });
  await save(page);
  expect(repeatedSkillSyncs).toBe(0);
  expect((await json(await request.get(`/api/agents/${agent.id}/configuration`))).adapterConfig.env.YAML_SECRET.type).toBe("secret_ref");
  expect((await json(await request.get(`/api/tool-connections/${connection.id}/installs`))).installs).toContainEqual(expect.objectContaining({ targetType: "agent", targetId: agent.id }));
  const key = (await json(await request.get(`/api/agents/${agent.id}/keys`))).find((row: { name: string }) => row.name === "YAML automation");
  await edit(page, value => {
    value.spec.apiKeys = { revoke: [key.id] };
    value.spec.channels![0].settings = { allowUnlinkedPeople: true };
    value.spec.instructions!.files = { "workflow.md": null };
    value.spec.tools!.profiles = [];
    value.spec.tools!.policies = [];
    value.spec.tools!.connections = [];
    value.spec.skills = [];
  });
  await save(page);
  await page.reload();
  const cleared = await document(page);
  expect((await json(await request.get(`/api/agents/${agent.id}/instructions-bundle`))).files.map((file: { path: string }) => file.path)).not.toContain("workflow.md");
  expect(cleared.spec.skills).toBeUndefined();
  expect(cleared.spec.tools).toBeUndefined();
  expect(cleared.spec.channels![0].settings.allowUnlinkedPeople).toBe(true);
  expect(cleared.spec.channels![0].settings).not.toHaveProperty("communicationInstructions");
  expect((await json(await request.get(`/api/agents/${agent.id}/keys`))).find((row: { id: string }) => row.id === key.id).revokedAt).not.toBeNull();
  await page.screenshot({ path: info.outputPath("saved-agent-yaml.png") });
});

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
  // Reproduce the observed CI failure once: a copy contains surrounding page
  // text as well as the YAML header. The read helper must reacquire a clean
  // editor copy instead of accepting the header and parsing the whole page.
  await page.evaluate(() => document.addEventListener("copy", event => {
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
