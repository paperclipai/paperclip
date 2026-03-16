import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNodeHttpEndpoint,
} from "@copilotkit/runtime";
import { Router } from "express";

export function copilotKitRoutes(): Router {
  const router = Router();

  const serviceAdapter = new OpenAIAdapter({
    model: process.env.COPILOTKIT_MODEL ?? "gpt-4o-mini",
  });

  router.use("/copilotkit", (req, res, next) => {
    const runtime = new CopilotRuntime();

    const handler = copilotRuntimeNodeHttpEndpoint({
      endpoint: "/copilotkit",
      runtime,
      serviceAdapter,
    });

    return handler(req, res, next);
  });

  return router;
}
