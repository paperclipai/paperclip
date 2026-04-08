import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { teamRoutes } from "../routes/teams.js";
import { errorHandler } from "../middleware/index.js";

const mockTeamService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listMembers: vi.fn(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
}));

const mockWorkflowStatusService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  teamService: () => mockTeamService,
  workflowStatusService: () => mockWorkflowStatusService,
  logActivity: mockLogActivity,
}));

const COMPANY_ID = "company-1";
const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", teamRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("team routes validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamService.getById.mockResolvedValue({
      id: TEAM_ID,
      companyId: COMPANY_ID,
      name: "Engineering",
      identifier: "ENG",
    });
  });

  // --- Create team ---

  describe("POST /companies/:companyId/teams", () => {
    it("returns 409 when team identifier already exists", async () => {
      mockTeamService.create.mockRejectedValue(
        Object.assign(new Error("Team identifier already exists"), { status: 409 }),
      );

      const res = await request(createApp())
        .post(`/api/companies/${COMPANY_ID}/teams`)
        .send({ name: "Eng", identifier: "ENG" });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Team identifier already exists");
    });

    it("returns 422 when parent team belongs to a different company", async () => {
      mockTeamService.create.mockRejectedValue(
        Object.assign(new Error("Parent team does not belong to this company"), {
          status: 422,
        }),
      );

      const res = await request(createApp())
        .post(`/api/companies/${COMPANY_ID}/teams`)
        .send({ name: "Sub Team", identifier: "SUB", parentId: PARENT_ID });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("does not belong to this company");
    });

    it("returns 404 when lead agent does not exist", async () => {
      mockTeamService.create.mockRejectedValue(
        Object.assign(new Error("Agent not found"), { status: 404 }),
      );

      const res = await request(createApp())
        .post(`/api/companies/${COMPANY_ID}/teams`)
        .send({ name: "Team", identifier: "TM", leadAgentId: AGENT_ID });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });

    it("returns 422 when lead agent belongs to a different company", async () => {
      mockTeamService.create.mockRejectedValue(
        Object.assign(new Error("Agent does not belong to this company"), {
          status: 422,
        }),
      );

      const res = await request(createApp())
        .post(`/api/companies/${COMPANY_ID}/teams`)
        .send({ name: "Team", identifier: "TX", leadAgentId: AGENT_ID });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("does not belong to this company");
    });

    it("returns 201 on successful creation", async () => {
      const created = {
        id: "new-team-id",
        companyId: COMPANY_ID,
        name: "New Team",
        identifier: "NEW",
      };
      mockTeamService.create.mockResolvedValue(created);

      const res = await request(createApp())
        .post(`/api/companies/${COMPANY_ID}/teams`)
        .send({ name: "New Team", identifier: "NEW" });

      expect(res.status).toBe(201);
      expect(res.body.identifier).toBe("NEW");
    });
  });

  // --- Update team ---

  describe("PATCH /companies/:companyId/teams/:teamId", () => {
    it("returns 404 when team does not exist", async () => {
      mockTeamService.getById.mockResolvedValue(null);

      const res = await request(createApp())
        .patch(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}`)
        .send({ name: "Updated" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Team not found");
    });

    it("returns 422 when updated lead agent belongs to a different company", async () => {
      mockTeamService.update.mockRejectedValue(
        Object.assign(new Error("Agent does not belong to this company"), {
          status: 422,
        }),
      );

      const res = await request(createApp())
        .patch(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}`)
        .send({ leadAgentId: AGENT_ID });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("does not belong to this company");
    });

    it("returns 422 when updated parent team belongs to a different company", async () => {
      mockTeamService.update.mockRejectedValue(
        Object.assign(new Error("Parent team does not belong to this company"), {
          status: 422,
        }),
      );

      const res = await request(createApp())
        .patch(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}`)
        .send({ parentId: PARENT_ID });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("does not belong to this company");
    });

    it("returns 200 on successful update", async () => {
      const updated = {
        id: TEAM_ID,
        companyId: COMPANY_ID,
        name: "Updated Team",
        identifier: "ENG",
      };
      mockTeamService.update.mockResolvedValue(updated);

      const res = await request(createApp())
        .patch(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}`)
        .send({ name: "Updated Team" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated Team");
    });
  });

  // --- Add member ---

  describe("POST /companies/:companyId/teams/:teamId/members", () => {
    it("returns 404 when team does not exist", async () => {
      mockTeamService.getById.mockResolvedValue(null);

      const res = await request(createApp())
        .post(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}/members`)
        .send({ agentId: AGENT_ID });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Team not found");
    });

    it("returns 422 when agent belongs to a different company", async () => {
      mockTeamService.addMember.mockRejectedValue(
        Object.assign(new Error("Agent does not belong to this company"), {
          status: 422,
        }),
      );

      const res = await request(createApp())
        .post(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}/members`)
        .send({ agentId: AGENT_ID });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("does not belong to this company");
    });

    it("returns 404 when agent does not exist", async () => {
      mockTeamService.addMember.mockRejectedValue(
        Object.assign(new Error("Agent not found"), { status: 404 }),
      );

      const res = await request(createApp())
        .post(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}/members`)
        .send({ agentId: AGENT_ID });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });

    it("returns 409 when member already exists in team", async () => {
      mockTeamService.addMember.mockResolvedValue(null);

      const res = await request(createApp())
        .post(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}/members`)
        .send({ agentId: AGENT_ID });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Member already exists");
    });

    it("returns 201 on successful member addition", async () => {
      const member = { id: MEMBER_ID, teamId: TEAM_ID, agentId: AGENT_ID, role: "member" };
      mockTeamService.addMember.mockResolvedValue(member);

      const res = await request(createApp())
        .post(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}/members`)
        .send({ agentId: AGENT_ID });

      expect(res.status).toBe(201);
      expect(res.body.agentId).toBe(AGENT_ID);
    });

    it("passes companyId from the team to addMember service call", async () => {
      const member = { id: MEMBER_ID, teamId: TEAM_ID, agentId: AGENT_ID, role: "member" };
      mockTeamService.addMember.mockResolvedValue(member);

      await request(createApp())
        .post(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}/members`)
        .send({ agentId: AGENT_ID });

      expect(mockTeamService.addMember).toHaveBeenCalledWith(
        TEAM_ID,
        COMPANY_ID,
        expect.objectContaining({ agentId: AGENT_ID }),
      );
    });
  });

  // --- Remove member ---

  describe("DELETE /companies/:companyId/teams/:teamId/members/:memberId", () => {
    it("returns 404 when team does not exist", async () => {
      mockTeamService.getById.mockResolvedValue(null);

      const res = await request(createApp())
        .delete(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}/members/${MEMBER_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Team not found");
    });

    it("returns 404 when member not found in this team", async () => {
      mockTeamService.removeMember.mockResolvedValue(null);

      const res = await request(createApp())
        .delete(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}/members/${MEMBER_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Member not found in this team");
    });

    it("scopes removeMember to the team", async () => {
      const removed = { id: MEMBER_ID, teamId: TEAM_ID, agentId: AGENT_ID };
      mockTeamService.removeMember.mockResolvedValue(removed);

      await request(createApp())
        .delete(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}/members/${MEMBER_ID}`);

      expect(mockTeamService.removeMember).toHaveBeenCalledWith(TEAM_ID, MEMBER_ID);
    });

    it("returns 200 on successful removal", async () => {
      const removed = { id: MEMBER_ID, teamId: TEAM_ID, agentId: AGENT_ID };
      mockTeamService.removeMember.mockResolvedValue(removed);

      const res = await request(createApp())
        .delete(`/api/companies/${COMPANY_ID}/teams/${TEAM_ID}/members/${MEMBER_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(MEMBER_ID);
    });
  });
});
