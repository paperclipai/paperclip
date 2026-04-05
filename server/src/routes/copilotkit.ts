import {
  CopilotRuntime,
  createCopilotEndpointExpress,
  BuiltInAgent,
} from "@copilotkit/runtime/v2";
import { Router } from "express";

export function copilotKitRoutes(): Router {
  const router = Router();

  if (!process.env.OPENAI_API_KEY) {
    router.all("/copilotkit", (_req, res) => {
      res.status(503).json({ error: "CopilotKit is not configured (OPENAI_API_KEY not set)" });
    });
    return router;
  }

  const rawModel = process.env.COPILOTKIT_MODEL ?? "gpt-5.4";
  const model = rawModel.includes("/") ? rawModel : `openai/${rawModel}`;

  const runtime = new CopilotRuntime({
    agents: {
      default: new BuiltInAgent({ model }),
    },
  });

  router.use(
    "/copilotkit",
    createCopilotEndpointExpress({
      runtime,
      basePath: "/",
    }),
  );

  return router;
}
