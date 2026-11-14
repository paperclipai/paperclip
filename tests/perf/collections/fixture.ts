import fs from "node:fs/promises";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export type CollectionFixture = { company: { id: string; issuePrefix: string }; taskIds: string[]; otherCompanyId?: string };
export const fixturePath = "test-results/collections/fixture.json";
async function retainOtherCompany(request: APIRequestContext, fixture: CollectionFixture): Promise<CollectionFixture> {
  const response = await request.get("/api/companies");
  expect(response.ok(), await response.text()).toBeTruthy();
  const companies = await response.json() as Array<{ id: string; name: string; status: string }>;
  const other = companies.find(company => company.id === fixture.otherCompanyId && company.id !== fixture.company.id && company.status !== "archived")
    ?? companies.find(company => company.name === "Other collection organization" && company.id !== fixture.company.id && company.status !== "archived");
  let otherCompanyId = other?.id;
  if (!otherCompanyId) {
    const created = await request.post("/api/companies", { data: { name: "Other collection organization" } });
    expect(created.ok(), await created.text()).toBeTruthy();
    otherCompanyId = (await created.json()).id;
  }
  const retained = { ...fixture, otherCompanyId };
  await fs.mkdir("test-results/collections", { recursive: true });
  await fs.writeFile(fixturePath, JSON.stringify(retained));
  return retained;
}
export async function collectionFixture(request: APIRequestContext): Promise<CollectionFixture> {
  const saved = await fs.readFile(fixturePath, "utf8").then(JSON.parse).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (saved) {
    const existing = await request.get(`/api/companies/${saved.company.id}`);
    if (existing.ok()) return retainOtherCompany(request, saved);
    expect(existing.status(), await existing.text()).toBe(404);
  }
  const created = await request.post("/api/companies", { data: { name: "Collection performance fixture" } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const company = await created.json();
  const taskIds: string[] = [];
  for (let offset = 0; offset < 220; offset += 10) {
    const rows = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const response = await request.post(`/api/companies/${company.id}/issues`, { data: {
        title: `Collection task ${offset + i}`, status: "backlog", description: "Synthetic saved task context. ".repeat(200),
      } });
      expect(response.ok(), await response.text()).toBeTruthy();
      return (await response.json()).id;
    }));
    taskIds.push(...rows);
  }
  for (let offset = 0; offset < 110; offset += 10) await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    const response = await request.post(`/api/companies/${company.id}/approvals`, { data: {
      type: "request_board_approval", payload: { title: `Collection approval ${offset + i}`, summary: "Synthetic decision context. ".repeat(200) },
    } });
    expect(response.ok(), await response.text()).toBeTruthy();
  }));
  const fixture = { company, taskIds };
  return retainOtherCompany(request, fixture);
}
export async function coordinatorPreference(page: Page, streamlined = true) {
  await page.route("**/api/workspace-preferences/me", async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), coordinatorWorkspaceEnabled: true } });
  });
  await page.route("**/api/instance/settings/experimental", async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), enableStreamlinedUi: streamlined } });
  });
}
