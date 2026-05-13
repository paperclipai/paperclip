import { describe, expect, it } from "vitest";
import {
  buildProductionSafeRegressionPlan,
  summarizeRegressionArtifactPolicy,
} from "./production-safety.js";

describe("production-safe regression planning", () => {
  it("requires read-only smokes, queue checks, and safe artifact formats", () => {
    const plan = buildProductionSafeRegressionPlan({
      target: "production",
      baseUrl: "https://paperclip.example.test",
      finalDeliveryQueue: {
        attemptable: 0,
        livePendingSending: 0,
      },
      liveExternalActionsEnabled: false,
      allowedArtifactFormats: ["pdf", "zip", "md", "json"],
      checks: ["api_health", "db_backup", "final_delivery_queue", "secret_scan", "visual_contact_sheet"],
    });

    expect(plan.ready).toBe(true);
    expect(plan.defaultCommandEnvironment.PAPERCLIP_E2E_SKIP_LLM).toBe("true");
    expect(plan.requiredChecks).toContain("/api/health");
    expect(plan.requiredChecks).toContain("final_delivery queue: attemptable=0, live_pending_sending=0");
    expect(summarizeRegressionArtifactPolicy(plan)).toContain("pdf, zip, md, json");
  });

  it("blocks unsafe production regression runs", () => {
    const plan = buildProductionSafeRegressionPlan({
      target: "production",
      baseUrl: "https://paperclip.example.test",
      finalDeliveryQueue: {
        attemptable: 2,
        livePendingSending: 1,
      },
      liveExternalActionsEnabled: true,
      allowedArtifactFormats: ["png", "pdf"],
      checks: ["api_health"],
    });

    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContain("final_delivery queue is not empty");
    expect(plan.blockers).toContain("live external actions must be disabled for production-safe regression");
    expect(plan.blockers).toContain("artifact format png is not Telegram-safe for this workflow");
    expect(plan.missingChecks).toContain("final_delivery_queue");
    expect(plan.missingChecks).toContain("secret_scan");
  });
});
