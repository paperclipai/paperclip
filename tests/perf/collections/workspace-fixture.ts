import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { sql } from "../../../server/node_modules/drizzle-orm/index.js";
import { closeRegisteredClients, createDb, executionWorkspaces, issues, projects } from "../../../packages/db/src/index.js";

// A company shaped like a long-lived instance: thousands of execution
// workspaces, most of them created for (now finished) tasks, and a few Mine
// rows that each run in their own isolated workspace. The API has no route to
// create execution workspaces, so the bulk rows are written to the disposable
// instance database directly. Mine rows are created through the API so Mine
// selects them exactly as it selects any board-created task.
export const WORKSPACE_COUNT = 6_000;
export const LINKED_WORKSPACE_COUNT = 4_000;
export const MINE_ROW_COUNT = 12;
export type WorkspaceFixture = {
  company: { id: string; issuePrefix: string };
  mine: Array<{ id: string; identifier: string; workspaceId: string; workspaceName: string }>;
};
export const workspaceFixturePath = "test-results/collections/workspace-fixture.json";
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"];

async function databaseUrl() {
  let url = process.env.PAPERCLIP_COLLECTION_PERF_DATABASE_URL;
  if (!url && process.env.PAPERCLIP_CONFIG) {
    const config = JSON.parse(await fs.readFile(process.env.PAPERCLIP_CONFIG, "utf8"));
    url = config.database.mode === "postgres" ? config.database.connectionString
      : `postgres://paperclip:paperclip@127.0.0.1:${(await fs.readFile(
        path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8")).split("\n")[3]}/paperclip`;
  }
  if (!url) {
    throw new Error("Workspace-scale checks seed execution workspaces directly. Set PAPERCLIP_COLLECTION_PERF_DATABASE_URL "
      + "to the disposable instance database, or PAPERCLIP_CONFIG to its config.json.");
  }
  if (!LOOPBACK_HOSTS.includes(new URL(url).hostname)) throw new Error("Workspace-scale seeding only supports a loopback database.");
  return url;
}

async function seed(request: APIRequestContext): Promise<WorkspaceFixture> {
  const created = await request.post("/api/companies", { data: { name: "Mine workspace scale fixture" } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const company = await created.json() as { id: string; issuePrefix: string };
  const preference = await request.put(`/api/companies/${company.id}/workspace-preferences/me`, {
    data: { coordinatorWorkspaceEnabled: true },
  });
  expect(preference.ok(), await preference.text()).toBeTruthy();
  const mineTasks: Array<{ id: string; identifier: string; issueNumber: number }> = [];
  for (let index = 0; index < MINE_ROW_COUNT; index++) {
    const response = await request.post(`/api/companies/${company.id}/issues`, { data: {
      title: `Workspace-scale Mine task ${index}`, status: "todo",
    } });
    expect(response.ok(), await response.text()).toBeTruthy();
    mineTasks.push(await response.json());
  }

  const url = await databaseUrl();
  const db = createDb(url);
  try {
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: company.id, name: "Workspace scale project", status: "in_progress" });
    const firstNumber = Math.max(...mineTasks.map(task => task.issueNumber)) + 1;
    const now = Date.now();
    // Finished tasks, each with the workspace it ran in. The remaining
    // workspaces have no source task (reused, imported or orphaned).
    const sourceTasks = Array.from({ length: LINKED_WORKSPACE_COUNT }, (_, index) => ({
      id: randomUUID(), companyId: company.id, projectId, title: `Finished workspace task ${index}`, status: "done",
      issueNumber: firstNumber + index, identifier: `${company.issuePrefix}-${firstNumber + index}`,
      createdAt: new Date(now - (index + 60) * 60_000), updatedAt: new Date(now - (index + 60) * 60_000),
    }));
    const workspace = (index: number, sourceIssueId: string | null, name = `scale-ws-${index}`) => ({
      id: randomUUID(), companyId: company.id, projectId, sourceIssueId, mode: "isolated_workspace", strategyType: "git_worktree",
      providerType: "git_worktree", name, status: index % 3 === 0 ? "idle" : "archived", cwd: `/tmp/collections-perf/${name}`,
      branchName: `perf/${name}`, lastUsedAt: new Date(now - (index + 60) * 60_000),
      metadata: sourceIssueId ? { _issuePrivacySources: { [sourceIssueId]: true } } : null,
    });
    const bulk = Array.from({ length: WORKSPACE_COUNT - MINE_ROW_COUNT }, (_, index) =>
      workspace(index, sourceTasks[index]?.id ?? null));
    const mineWorkspaces = mineTasks.map((task, index) => ({
      ...workspace(index, task.id, `mine-isolated-${index}`), status: "active", lastUsedAt: new Date(now - index * 1_000),
    }));
    for (let index = 0; index < sourceTasks.length; index += 500) await db.insert(issues).values(sourceTasks.slice(index, index + 500));
    const allWorkspaces = [...mineWorkspaces, ...bulk];
    for (let index = 0; index < allWorkspaces.length; index += 500) {
      await db.insert(executionWorkspaces).values(allWorkspaces.slice(index, index + 500));
    }
    await db.execute(sql`update issues set execution_workspace_id = w.id
      from execution_workspaces w where w.source_issue_id = issues.id and w.company_id = ${company.id}`);
    await db.execute(sql`update companies set issue_counter = ${firstNumber + LINKED_WORKSPACE_COUNT - 1} where id = ${company.id}`);
    await db.execute(sql`analyze issues`);
    await db.execute(sql`analyze execution_workspaces`);
    const [counts] = await db.execute(sql`select
      (select count(*)::int from execution_workspaces where company_id = ${company.id}) as workspaces,
      (select count(*)::int from issues where company_id = ${company.id} and execution_workspace_id is not null) as linked`) as unknown as Array<{ workspaces: number; linked: number }>;
    expect(counts).toEqual({ workspaces: WORKSPACE_COUNT, linked: LINKED_WORKSPACE_COUNT + MINE_ROW_COUNT });
    return {
      company: { id: company.id, issuePrefix: company.issuePrefix },
      mine: mineTasks.map((task, index) => ({
        id: task.id, identifier: task.identifier, workspaceId: mineWorkspaces[index]!.id, workspaceName: mineWorkspaces[index]!.name,
      })),
    };
  } finally {
    await closeRegisteredClients(url);
  }
}

// Retained like the main collection fixture: reused while its company exists,
// replaced only when the company is gone (404). Other errors fail.
export async function workspaceFixture(request: APIRequestContext): Promise<WorkspaceFixture> {
  const saved = await fs.readFile(workspaceFixturePath, "utf8").then(JSON.parse).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  }) as WorkspaceFixture | null;
  if (saved) {
    const existing = await request.get(`/api/companies/${saved.company.id}`);
    if (existing.ok()) return saved;
    expect(existing.status(), await existing.text()).toBe(404);
  }
  const fixture = await seed(request);
  await fs.mkdir(path.dirname(workspaceFixturePath), { recursive: true });
  await fs.writeFile(workspaceFixturePath, JSON.stringify(fixture));
  return fixture;
}

// Turns on isolated workspaces for this page only, so other specs keep the
// instance's real feature settings.
export async function isolatedWorkspaceSettings(page: Page) {
  await page.route("**/api/instance/settings/experimental", async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), enableIsolatedWorkspaces: true } });
  });
}
