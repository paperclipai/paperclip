import { Router } from "express";

export function sinkDinkHubRoutes() {
  const router = Router();
  router.get("/sink-dink/hub", (_req, res) => {
    res.json({
      ok: true,
      service: "sink-dink-hub",
      runRoute: "/api/sink-dink/agent-workflow/start-day",
      reviewRoute: "/api/sink-dink/artifacts/review",
      previewRoute: "/api/sink-dink/artifacts/preview",
      latestRoute: "/api/sink-dink/artifacts/review/latest?limit=12",
      humanApprovalRequired: true,
      publishingBlocked: true,
      autoPublishing: false
    });
  });
  return router;
}
