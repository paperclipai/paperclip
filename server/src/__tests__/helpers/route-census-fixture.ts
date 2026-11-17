import express from "express";
import { agents, authUsers, issueComments, issueWorkProducts, issues, projects, type Db } from "@paperclipai/db";
import { actorMiddleware } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { activityRoutes } from "../../routes/activity.js";
import { agentRoutes } from "../../routes/agents.js";
import { companySkillRoutes } from "../../routes/company-skills.js";
import { dashboardRoutes } from "../../routes/dashboard.js";
import { issueRoutes } from "../../routes/issues.js";
import { sidebarBadgeRoutes } from "../../routes/sidebar-badges.js";
import { seedCompanyWithBoardAccess } from "./route-test-harness.js";

export function boardSessionApp(db: Db, sessionUserId: () => string | null) {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, {
    deploymentMode: "authenticated",
    resolveSession: async () => {
      const userId = sessionUserId();
      return userId ? {
        session: { id: `session-${userId}`, userId },
        user: { id: userId, name: "Board user", email: `${userId}@example.test` },
      } : null;
    },
  }));
  app.use("/api", issueRoutes(db, {} as never));
  app.use("/api", agentRoutes(db));
  app.use("/api", activityRoutes(db));
  app.use("/api", companySkillRoutes(db));
  app.use("/api", sidebarBadgeRoutes(db));
  app.use("/api", dashboardRoutes(db));
  app.use(errorHandler);
  return app;
}

export async function seedBoardRouteFixture(db: Db, name: string, commentCount = 3) {
  const company = await seedCompanyWithBoardAccess(db, name);
  const now = new Date("2026-11-01T00:00:00.000Z");
  await db.insert(authUsers).values({
    id: company.userId, name, email: `${company.userId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
  });
  const [agent] = await db.insert(agents).values({
    companyId: company.companyId, name: `${name} agent`, role: "engineer", adapterType: "process", status: "idle",
  }).returning();
  const [project] = await db.insert(projects).values({ companyId: company.companyId, name: `${name} project` }).returning();
  const [parent] = await db.insert(issues).values({
    companyId: company.companyId, title: `${name} parent`, status: "todo", createdByUserId: company.userId,
    createdAt: now, updatedAt: now,
  }).returning();
  const [issue] = await db.insert(issues).values({
    companyId: company.companyId, title: `${name} task`, description: "Fixture task", status: "in_progress",
    priority: "high", parentId: parent!.id, projectId: project!.id, assigneeAgentId: agent!.id,
    createdByUserId: company.userId, createdAt: now, updatedAt: now,
  }).returning();
  if (commentCount > 0) {
    await db.insert(issueComments).values(Array.from({ length: commentCount }, (_, index) => ({
      companyId: company.companyId, issueId: issue!.id, authorUserId: company.userId, authorType: "user" as const,
      body: `Comment ${index}`, createdAt: new Date(now.getTime() + (index + 1) * 1000), updatedAt: now,
    })));
  }
  await db.insert(issueWorkProducts).values({
    companyId: company.companyId, projectId: project!.id, issueId: issue!.id, type: "pull_request", provider: "github",
    title: "Fixture PR", url: "https://example.test/pr/1", status: "open", createdAt: now, updatedAt: now,
  });
  return { ...company, agent: agent!, project: project!, parent: parent!, issue: issue! };
}

export type BoardRouteFixture = Awaited<ReturnType<typeof seedBoardRouteFixture>>;

export function boardCensusRoutes(fixture: BoardRouteFixture) {
  const { companyId, issue, parent } = fixture;
  return [
    ["GET /api/issues/:id", `/api/issues/${issue.id}`],
    ["GET /api/issues/:id/comments", `/api/issues/${issue.id}/comments`],
    ["GET /api/issues/:id/activity", `/api/issues/${issue.id}/activity`],
    ["GET /api/issues/:id/interactions", `/api/issues/${issue.id}/interactions`],
    ["GET /api/issues/:id/work-products", `/api/issues/${issue.id}/work-products`],
    ["GET /api/companies/:id/issues", `/api/companies/${companyId}/issues`],
    ["GET /api/companies/:id/issues/summaries?ids", `/api/companies/${companyId}/issues/summaries?ids=${issue.id},${parent.id}`],
    ["GET /api/companies/:id/live-runs", `/api/companies/${companyId}/live-runs`],
    ["GET /api/companies/:id/skills", `/api/companies/${companyId}/skills`],
    ["GET /api/companies/:id/sidebar-badges", `/api/companies/${companyId}/sidebar-badges`],
    ["GET /api/companies/:id/dashboard", `/api/companies/${companyId}/dashboard`],
    ["GET /api/companies/:id/agents", `/api/companies/${companyId}/agents`],
    ["GET /api/companies/:id/chats", `/api/companies/${companyId}/chats`],
  ] as const;
}
