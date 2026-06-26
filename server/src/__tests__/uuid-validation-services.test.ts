import { describe, expect, it, vi } from "vitest";

import { approvalService } from "../services/approvals.ts";
import { projectService } from "../services/projects.ts";
import { routineService } from "../services/routines.ts";

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => ({})),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: vi.fn(),
}));

vi.mock("../services/budgets.js", () => ({
  budgetService: vi.fn(() => ({})),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({})),
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: vi.fn(() => ({})),
}));

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({ getById: vi.fn() })),
}));

vi.mock("../services/workspace-runtime-read-model.js", () => ({
  listCurrentRuntimeServicesForProjectWorkspaces: vi.fn(),
}));

function makeExplodingDb() {
  const explode = () => {
    throw new Error("db should not be queried for malformed UUIDs");
  };
  const handler: ProxyHandler<object> = {
    get() {
      return explode;
    },
  };
  return new Proxy({}, handler) as never;
}

const MALFORMED_IDS = ["not-a-uuid", "", "   ", "1234", "abc-def"];

describe("UUID validation guards (ZERA-521)", () => {
  describe("projectService.getById", () => {
    const svc = projectService(makeExplodingDb());

    for (const value of MALFORMED_IDS) {
      it(`returns null without hitting the DB for "${value}"`, async () => {
        await expect(svc.getById(value)).resolves.toBeNull();
      });
    }
  });

  describe("approvalService.getById", () => {
    const svc = approvalService(makeExplodingDb());

    for (const value of MALFORMED_IDS) {
      it(`returns null without hitting the DB for "${value}"`, async () => {
        await expect(svc.getById(value)).resolves.toBeNull();
      });
    }
  });

  describe("routineService.get / getDetail / getTrigger", () => {
    const svc = routineService(makeExplodingDb());

    for (const value of MALFORMED_IDS) {
      it(`routine get returns null without hitting the DB for "${value}"`, async () => {
        await expect(svc.get(value)).resolves.toBeNull();
      });

      it(`routine getDetail returns null without hitting the DB for "${value}"`, async () => {
        await expect(svc.getDetail(value)).resolves.toBeNull();
      });

      it(`routine getTrigger returns null without hitting the DB for "${value}"`, async () => {
        await expect(svc.getTrigger(value)).resolves.toBeNull();
      });
    }
  });
});
