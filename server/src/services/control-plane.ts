import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projects } from "@paperclipai/db";
import type {
  ProjectControlPlaneState,
  ProjectControlPlaneResponse,
  ProjectPortfolioSummary,
  PortfolioResponse,
  ProjectStaleStatus,
  ProjectPortfolioState,
} from "@paperclipai/shared";
import type { UpdateProjectControlPlane } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Stale thresholds
// ---------------------------------------------------------------------------

const STALE_THRESHOLDS_MS: Record<
  ProjectPortfolioState,
  { aging: number; stale: number } | null
> = {
  primary: { aging: 2 * 24 * 60 * 60 * 1000, stale: 4 * 24 * 60 * 60 * 1000 },
  active:  { aging: 5 * 24 * 60 * 60 * 1000, stale: 10 * 24 * 60 * 60 * 1000 },
  blocked: { aging: 3 * 24 * 60 * 60 * 1000, stale: 7 * 24 * 60 * 60 * 1000 },
  paused:  null,
  parked:  null,
  closed:  null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeStaleStatus(
  portfolioState: ProjectPortfolioState | null | undefined,
  updatedAt: Date | null | undefined,
): ProjectStaleStatus {
  if (!portfolioState) return "fresh";
  const thresholds = STALE_THRESHOLDS_MS[portfolioState] ?? null;
  if (thresholds === null) return "fresh";
  if (!updatedAt) return "fresh";
  const ageMs = Date.now() - updatedAt.getTime();
  if (ageMs >= thresholds.stale) return "stale";
  if (ageMs >= thresholds.aging) return "aging";
  return "fresh";
}

function computeAttentionScore(
  state: ProjectControlPlaneState | null,
  staleStatus: ProjectStaleStatus,
): number {
  if (state === null) return 0;
  let score = 0;
  if (staleStatus === "stale" && state.portfolioState === "primary") score += 40;
  if (
    (state.portfolioState === "active" || state.portfolioState === "primary") &&
    !state.nextSmallestAction
  ) {
    score += 30;
  }
  if (state.portfolioState === "blocked" && !state.blockerSummary) score += 25;
  if (!state.lastMeaningfulOutput) score += 10;
  return score;
}

function computeWarnings(state: ProjectControlPlaneState | null): string[] {
  if (state === null) return ["No control-plane state set"];
  const warnings: string[] = [];
  if (
    (state.portfolioState === "active" || state.portfolioState === "primary") &&
    !state.nextSmallestAction
  ) {
    warnings.push("No next smallest action set");
  }
  if (state.portfolioState === "blocked" && !state.blockerSummary) {
    warnings.push("Project is blocked but no blocker summary is set");
  }
  if (!state.lastMeaningfulOutput) {
    warnings.push("No last meaningful output recorded");
  }
  return warnings;
}

const DEFAULT_CONTROL_PLANE_STATE: ProjectControlPlaneState = {
  portfolioState: "parked",
  currentPhase: "exploration",
  constraintLane: null,
  nextSmallestAction: null,
  blockerSummary: null,
  latestEvidenceChanged: null,
  resumeBrief: null,
  doNotRethink: null,
  killCriteria: null,
  lastMeaningfulOutput: null,
};

function parseControlPlaneState(
  raw: Record<string, unknown> | null | undefined,
): ProjectControlPlaneState | null {
  if (!raw) return null;
  // Cast — the DB stores valid JSON that was written by this service
  return raw as unknown as ProjectControlPlaneState;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function controlPlaneService(db: Db) {
  return {
    async getControlPlane(projectId: string): Promise<ProjectControlPlaneResponse | null> {
      const rows = await db
        .select({
          id: projects.id,
          companyId: projects.companyId,
          controlPlaneState: projects.controlPlaneState,
          controlPlaneUpdatedAt: projects.controlPlaneUpdatedAt,
        })
        .from(projects)
        .where(eq(projects.id, projectId));

      const row = rows[0] ?? null;
      if (!row) return null;

      const state = parseControlPlaneState(row.controlPlaneState);
      const warnings = computeWarnings(state);

      return {
        projectId: row.id,
        companyId: row.companyId,
        controlPlaneState: state,
        telemetry: null,
        warnings,
      };
    },

    async updateControlPlane(
      projectId: string,
      patch: UpdateProjectControlPlane,
    ): Promise<ProjectControlPlaneResponse | null> {
      const rows = await db
        .select({
          id: projects.id,
          companyId: projects.companyId,
          controlPlaneState: projects.controlPlaneState,
        })
        .from(projects)
        .where(eq(projects.id, projectId));

      const row = rows[0] ?? null;
      if (!row) return null;

      const currentState =
        parseControlPlaneState(row.controlPlaneState) ?? { ...DEFAULT_CONTROL_PLANE_STATE };

      const nextState: ProjectControlPlaneState = { ...currentState, ...patch };
      const now = new Date();

      const updated = await db
        .update(projects)
        .set({
          controlPlaneState: nextState as unknown as Record<string, unknown>,
          controlPlaneUpdatedAt: now,
          updatedAt: now,
        })
        .where(eq(projects.id, projectId))
        .returning({ id: projects.id, companyId: projects.companyId });

      const confirmedRow = updated[0];
      if (!confirmedRow) return null;

      const warnings = computeWarnings(nextState);

      return {
        projectId: confirmedRow.id,
        companyId: confirmedRow.companyId,
        controlPlaneState: nextState,
        telemetry: null,
        warnings,
      };
    },

    async getPortfolio(companyId: string): Promise<PortfolioResponse> {
      const rows = await db
        .select({
          id: projects.id,
          name: projects.name,
          color: projects.color,
          companyId: projects.companyId,
          controlPlaneState: projects.controlPlaneState,
          controlPlaneUpdatedAt: projects.controlPlaneUpdatedAt,
          updatedAt: projects.updatedAt,
        })
        .from(projects)
        .where(eq(projects.companyId, companyId));

      // Parse states and filter out closed
      type ParsedRow = {
        id: string;
        name: string;
        color: string | null;
        state: ProjectControlPlaneState | null;
        controlPlaneUpdatedAt: Date | null;
        updatedAt: Date | null;
      };

      const parsed: ParsedRow[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color ?? null,
        state: parseControlPlaneState(r.controlPlaneState),
        controlPlaneUpdatedAt: r.controlPlaneUpdatedAt ?? null,
        updatedAt: r.updatedAt ?? null,
      }));

      const active = parsed.filter(
        (r) => r.state?.portfolioState !== "closed",
      );

      // Compute per-project derived values
      const withDerived = active.map((r) => {
        const staleStatus = computeStaleStatus(
          r.state?.portfolioState,
          r.controlPlaneUpdatedAt,
        );
        const attentionScore = computeAttentionScore(r.state, staleStatus);
        const warnings = computeWarnings(r.state);
        return { ...r, staleStatus, attentionScore, warnings };
      });

      // Sort by attentionScore desc, then controlPlaneUpdatedAt desc
      withDerived.sort((a, b) => {
        if (b.attentionScore !== a.attentionScore) return b.attentionScore - a.attentionScore;
        const aTime = a.controlPlaneUpdatedAt?.getTime() ?? 0;
        const bTime = b.controlPlaneUpdatedAt?.getTime() ?? 0;
        return bTime - aTime;
      });

      // Build portfolio summaries
      const projectSummaries: ProjectPortfolioSummary[] = withDerived.map((r) => ({
        projectId: r.id,
        name: r.name,
        color: r.color,
        controlPlaneState: r.state,
        controlPlaneUpdatedAt: r.controlPlaneUpdatedAt?.toISOString() ?? null,
        staleStatus: r.staleStatus,
        attentionScore: r.attentionScore,
        warnings: r.warnings,
      }));

      // Summary counts
      const primaryCount = withDerived.filter(
        (r) => r.state?.portfolioState === "primary",
      ).length;
      const activeCount = withDerived.filter(
        (r) => r.state?.portfolioState === "active",
      ).length;
      const staleCount = withDerived.filter(
        (r) => r.staleStatus === "stale" || r.staleStatus === "critical",
      ).length;
      const blockedCount = withDerived.filter(
        (r) => r.state?.portfolioState === "blocked",
      ).length;

      // Portfolio-level warnings
      const portfolioWarnings: string[] = [];
      if (primaryCount > 1) {
        portfolioWarnings.push(
          `Multiple primary projects (${primaryCount}) — only one project should be primary at a time`,
        );
      }

      return {
        companyId,
        summary: {
          primaryCount,
          activeCount,
          staleCount,
          blockedCount,
        },
        warnings: portfolioWarnings,
        projects: projectSummaries,
      };
    },
  };
}
