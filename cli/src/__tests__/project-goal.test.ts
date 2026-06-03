import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGoalCommands } from "../commands/client/goal.js";
import { registerProjectCommands } from "../commands/client/project.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const GOAL_ID = "44444444-4444-4444-8444-444444444444";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerProjectCommands(program);
  registerGoalCommands(program);
  return program;
}

describe("project and goal commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates and updates projects with shared schemas", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: PROJECT_ID,
        companyId: COMPANY_ID,
        name: "Launch Site",
        status: "planned",
        goalIds: [GOAL_ID],
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: PROJECT_ID,
        companyId: COMPANY_ID,
        name: "Launch Site",
        status: "in_progress",
        goalIds: [GOAL_ID],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "project", "create",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--name", "Launch Site",
      "--status", "planned",
      "--goal-ids", GOAL_ID,
    ], { from: "user" });

    await createProgram().parseAsync([
      "project", "update", PROJECT_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--status", "in_progress",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/projects`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      name: "Launch Site",
      status: "planned",
      goalIds: [GOAL_ID],
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/projects/${PROJECT_ID}`);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PATCH");
  });

  it("lists and deletes projects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: PROJECT_ID, companyId: COMPANY_ID, name: "Launch Site", status: "planned", goalIds: [] }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: PROJECT_ID, companyId: COMPANY_ID, name: "Launch Site" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "project", "list",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
    ], { from: "user" });

    await createProgram().parseAsync([
      "project", "delete", PROJECT_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--yes",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/projects`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/projects/${PROJECT_ID}`);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("creates, updates, lists, and deletes goals", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: GOAL_ID, companyId: COMPANY_ID, title: "Grow", level: "company", status: "active" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: GOAL_ID, companyId: COMPANY_ID, title: "Grow faster", level: "company", status: "active" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: GOAL_ID, companyId: COMPANY_ID, title: "Grow faster", level: "company", status: "active" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: GOAL_ID, companyId: COMPANY_ID, title: "Grow faster" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "goal", "create",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--title", "Grow",
      "--level", "company",
      "--status", "active",
    ], { from: "user" });

    await createProgram().parseAsync([
      "goal", "update", GOAL_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--title", "Grow faster",
    ], { from: "user" });

    await createProgram().parseAsync([
      "goal", "list",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
    ], { from: "user" });

    await createProgram().parseAsync([
      "goal", "delete", GOAL_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--yes",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/goals`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/goals/${GOAL_ID}`);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PATCH");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/goals`);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(`http://localhost:3100/api/goals/${GOAL_ID}`);
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("DELETE");
  });
});
