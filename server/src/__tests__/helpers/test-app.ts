import express from "express";
import type { Db } from "@paperclipai/db";
import type { Request, Response, NextFunction } from "express";
import { healthRoutes } from "../../routes/health.js";
import { companyRoutes } from "../../routes/companies.js";
import { agentRoutes } from "../../routes/agents.js";
import { projectRoutes } from "../../routes/projects.js";
import { issueRoutes } from "../../routes/issues.js";
import { goalRoutes } from "../../routes/goals.js";
import { approvalRoutes } from "../../routes/approvals.js";
import { secretRoutes } from "../../routes/secrets.js";
import { costRoutes } from "../../routes/costs.js";
import { activityRoutes } from "../../routes/activity.js";
import { dashboardRoutes } from "../../routes/dashboard.js";
import { sidebarBadgeRoutes } from "../../routes/sidebar-badges.js";
import { accessRoutes } from "../../routes/access.js";
import { userApiKeyRoutes } from "../../routes/user-api-keys.js";
import { errorHandler } from "../../middleware/index.js";

export type MockActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source?: string;
      isInstanceAdmin?: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
    };

const defaultActor: MockActor = {
  type: "board",
  userId: "test-user-1",
  companyIds: ["test-company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

let currentActor: MockActor = defaultActor;

/**
 * Set the mock actor used for subsequent requests.
 */
export function setMockActor(actor: MockActor) {
  currentActor = actor;
}

/**
 * Reset the mock actor to defaults.
 */
export function resetMockActor() {
  currentActor = defaultActor;
}

/** A no-op storage service for tests that don't need asset storage. */
const noopStorageService = {
  provider: "local_disk" as const,
  putFile: async (_input: unknown): Promise<never> => {
    throw new Error("Storage not available in tests");
  },
  getObject: async (_companyId: string, _objectKey: string): Promise<never> => {
    throw new Error("Storage not available in tests");
  },
  headObject: async (_companyId: string, _objectKey: string): Promise<never> => {
    throw new Error("Storage not available in tests");
  },
  deleteObject: async (_companyId: string, _objectKey: string): Promise<never> => {
    throw new Error("Storage not available in tests");
  },
};

/**
 * Creates an Express app with all API routes mounted, using a real Db instance.
 * Actor identity is injected via setMockActor().
 */
export function createTestApp(db: Db) {
  const app = express();
  app.use(express.json());

  // Inject mock actor middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).actor = currentActor;
    next();
  });

  // Mount API routes matching server/src/app.ts
  const api = express.Router();
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: false,
    }),
  );
  api.use("/companies", companyRoutes(db));
  api.use(agentRoutes(db));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, noopStorageService));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db));
  api.use(secretRoutes(db));
  api.use(costRoutes(db));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(
    accessRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "localhost",
      allowedHostnames: [],
    }),
  );
  api.use(userApiKeyRoutes(db));
  app.use("/api", api);
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "API route not found" });
  });

  app.use(errorHandler);
  return app;
}
