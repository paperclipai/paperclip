export interface OpsIntegrationProbe {
  id: string;
  label: string;
  url: string;
  status: "ok" | "degraded" | "down";
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
  checkedAt: string;
}

export interface OpsErrorCodeSummary {
  errorCode: string;
  count: number;
  recommendedAction: string;
}

export interface OperationsPulse {
  companyId: string;
  generatedAt: string;
  runHealth: {
    running: number;
    queued: number;
    failed24h: number;
    processLost24h: number;
    staleRunning: number;
    deferredWakeups: number;
  };
  integrationHealth: {
    total: number;
    failing: number;
    probes: OpsIntegrationProbe[];
  };
  projectGuardrails: {
    totalProjects: number;
    configuredProjects: number;
    defaultSafeModeProjects: number;
    missingProjectNames: string[];
    blockedByConcurrency: number;
  };
  failureRouting: {
    recentRecommendations: number;
    topErrorCodes: OpsErrorCodeSummary[];
  };
  safeMode: {
    activeRuns: number;
    runs24h: number;
  };
}
