export const PRODUCTION_SAFE_REQUIRED_CHECKS = [
  "api_health",
  "db_backup",
  "final_delivery_queue",
  "secret_scan",
] as const;
export type ProductionSafeRequiredCheck = (typeof PRODUCTION_SAFE_REQUIRED_CHECKS)[number];

export const TELEGRAM_SAFE_ARTIFACT_FORMATS = ["pdf", "zip", "md", "json", "txt", "yaml"] as const;
export type TelegramSafeArtifactFormat = (typeof TELEGRAM_SAFE_ARTIFACT_FORMATS)[number];

export interface ProductionSafeRegressionPlanInput {
  target: "isolated" | "staging" | "production";
  baseUrl: string;
  finalDeliveryQueue: {
    attemptable: number;
    livePendingSending: number;
  };
  liveExternalActionsEnabled: boolean;
  allowedArtifactFormats: string[];
  checks: string[];
}

export interface ProductionSafeRegressionPlan {
  target: ProductionSafeRegressionPlanInput["target"];
  baseUrl: string;
  ready: boolean;
  blockers: string[];
  missingChecks: ProductionSafeRequiredCheck[];
  requiredChecks: string[];
  allowedArtifactFormats: string[];
  defaultCommandEnvironment: Record<string, string>;
}

function missingRequiredChecks(checks: readonly string[]): ProductionSafeRequiredCheck[] {
  const checkSet = new Set(checks);
  return PRODUCTION_SAFE_REQUIRED_CHECKS.filter((check) => !checkSet.has(check));
}

export function buildProductionSafeRegressionPlan(input: ProductionSafeRegressionPlanInput): ProductionSafeRegressionPlan {
  const blockers: string[] = [];
  const missingChecks = missingRequiredChecks(input.checks);

  if (input.target === "production" && (input.finalDeliveryQueue.attemptable > 0 || input.finalDeliveryQueue.livePendingSending > 0)) {
    blockers.push("final_delivery queue is not empty");
  }

  if (input.liveExternalActionsEnabled) {
    blockers.push("live external actions must be disabled for production-safe regression");
  }

  for (const format of input.allowedArtifactFormats) {
    if (!TELEGRAM_SAFE_ARTIFACT_FORMATS.includes(format as TelegramSafeArtifactFormat)) {
      blockers.push(`artifact format ${format} is not Telegram-safe for this workflow`);
    }
  }

  for (const check of missingChecks) {
    blockers.push(`missing required check ${check}`);
  }

  const requiredChecks = [
    "/api/health",
    "database backup exists and is restorable",
    `final_delivery queue: attemptable=${input.finalDeliveryQueue.attemptable}, live_pending_sending=${input.finalDeliveryQueue.livePendingSending}`,
    "scoped added-line secret scan",
    "visual contact sheet redaction review",
  ];

  return {
    target: input.target,
    baseUrl: input.baseUrl,
    ready: blockers.length === 0,
    blockers,
    missingChecks,
    requiredChecks,
    allowedArtifactFormats: input.allowedArtifactFormats,
    defaultCommandEnvironment: {
      PAPERCLIP_E2E_SKIP_LLM: "true",
      PAPERCLIP_DISABLE_LIVE_DELIVERY: "true",
      PAPERCLIP_VISUAL_ARTIFACT_FORMATS: input.allowedArtifactFormats.join(","),
    },
  };
}

export function summarizeRegressionArtifactPolicy(plan: ProductionSafeRegressionPlan): string {
  return `Artifacts must be redacted and delivered as ${plan.allowedArtifactFormats.join(", ")}; screenshots are evidence inputs, not raw Telegram deliverables.`;
}
