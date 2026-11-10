import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { assertLoginEnvironmentTarget } from "./login-environment.js";
const fixtures = vi.hoisted(() => ({ environment: { id: "environment", driver: "plugin" }, companies: ["company"], agent: { id: "agent", companyId: "company", adapterType: "paperclip_runner", lifecycleState: "verifying", defaultEnvironmentId: "environment" } as Record<string, unknown> | undefined }));
vi.mock("./environments.js", () => ({ environmentService: () => ({ getById: async () => fixtures.environment, listBoundCompanyIds: async () => fixtures.companies }) }));
vi.mock("./instance-settings.js", () => ({ instanceSettingsService: () => ({ get: async () => ({ defaultEnvironmentId: "environment" }) }) }));
vi.mock("./environment-selection.js", () => ({ assertEnvironmentSelectionForCompany: vi.fn(async () => {}) }));
const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => fixtures.agent ? [fixtures.agent] : [] }) }) }) } as unknown as Db;
beforeEach(() => { fixtures.environment = { id: "environment", driver: "plugin" }; fixtures.companies = ["company"]; fixtures.agent = { id: "agent", companyId: "company", adapterType: "paperclip_runner", lifecycleState: "verifying", defaultEnvironmentId: "environment" }; });
describe("login environment transport target", () => {
  it("permits a verifying saved agent on its own computer", async () => { await expect(assertLoginEnvironmentTarget(db, { companyId: "company", environmentId: "environment", agentId: "agent" })).resolves.toEqual(fixtures.environment); });
  it("rejects a provider without an existing-computer credential path", async () => { await expect(assertLoginEnvironmentTarget(db, { companyId: "company", environmentId: "environment", agentId: "agent", adapterType: "grok_local" })).rejects.toMatchObject({ status: 400 }); });
  it("requires a saved target for existing-computer login", async () => { await expect(assertLoginEnvironmentTarget(db, { companyId: "company", environmentId: "environment" })).rejects.toMatchObject({ status: 400 }); });
  it("rejects a foreign company environment", async () => { fixtures.companies = ["another-company"]; await expect(assertLoginEnvironmentTarget(db, { companyId: "company", environmentId: "environment", agentId: "agent" })).rejects.toMatchObject({ status: 403 }); });
  it("does not expose a foreign or missing agent", async () => { fixtures.agent!.companyId = "another-company"; await expect(assertLoginEnvironmentTarget(db, { companyId: "company", environmentId: "environment", agentId: "agent" })).rejects.toMatchObject({ status: 404 }); });
  it.each([{ defaultEnvironmentId: "another-environment" }, { lifecycleState: "pending" }, { adapterType: "codex_local" }])("rejects unavailable target binding %j", async change => { Object.assign(fixtures.agent!, change); await expect(assertLoginEnvironmentTarget(db, { companyId: "company", environmentId: "environment", agentId: "agent" })).rejects.toMatchObject({ status: 400 }); });
  it("supports the inherited environment", async () => { fixtures.agent!.defaultEnvironmentId = null; await expect(assertLoginEnvironmentTarget(db, { companyId: "company", environmentId: "environment", agentId: "agent" })).resolves.toEqual(fixtures.environment); });
  it("retains agentless temporary sandbox login", async () => { fixtures.environment.driver = "sandbox"; await expect(assertLoginEnvironmentTarget(db, { companyId: "company", environmentId: "environment" })).resolves.toEqual(fixtures.environment); });
});
