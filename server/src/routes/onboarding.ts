/**
 * Onboarding API routes
 *
 * GET /api/onboarding/recommendation — returns a deployment recommendation
 *   based on an OnboardingProfile query.
 *
 * GET /api/onboarding/llm-handoff.txt — returns a plain-text LLM handoff
 *   prompt the user can paste into Claude/Codex to bootstrap their company.
 *
 * Both routes are read-only and accessible to any authenticated board user
 * (including local_implicit actors in local_trusted mode).
 */

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { count } from "drizzle-orm";

// ────────────────────────────────────────────────────────────────────────────
// Types (mirror cli/src/commands/init.ts OnboardingProfile)
// ────────────────────────────────────────────────────────────────────────────

type OnboardingUseCase = "startup" | "agency" | "internal_team" | "personal";
type DeployProfile = "local_solo" | "shared_private" | "shared_public";
type AutonomyMode = "hands_on" | "hybrid" | "full_auto";

interface OnboardingProfileQuery {
  useCase?: OnboardingUseCase;
  deployProfile?: DeployProfile;
  autonomyMode?: AutonomyMode;
  primaryRuntime?: string;
}

interface OnboardingRecommendation {
  deploymentMode: "local_trusted" | "authenticated";
  deploymentExposure: "private" | "public";
  suggestedAdapterType: string;
  nextSteps: string[];
  handoffPromptUrl: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const USE_CASE_LABELS: Record<OnboardingUseCase, string> = {
  startup: "an early-stage startup",
  agency: "an agency or service team",
  internal_team: "an internal engineering team",
  personal: "a personal / solo project",
};

const AUTONOMY_LABELS: Record<AutonomyMode, string> = {
  hands_on: "hands-on (human reviews most decisions)",
  hybrid: "hybrid (agents act, human approves key decisions)",
  full_auto: "full-auto (agents run autonomously within budget)",
};

function buildHandoffPromptText(
  profile: OnboardingProfileQuery,
  baseUrl: string,
  hasExistingCompany: boolean,
): string {
  const useCase = profile.useCase ?? "startup";
  const deployProfile = profile.deployProfile ?? "local_solo";
  const autonomyMode = profile.autonomyMode ?? "full_auto";
  const runtimeLabel = profile.primaryRuntime ?? "claude_local";

  const lines: string[] = [
    "# Paperclip Setup Handoff",
    "",
    `You are helping set up a new Paperclip instance at ${baseUrl}.`,
  ];

  if (hasExistingCompany) {
    lines.push(
      "A company already exists. You may use it or create a new one.",
    );
  } else {
    lines.push("No company exists yet — you will create one from scratch.");
  }

  lines.push(
    "",
    "The user completed the interview wizard with these answers:",
    "",
    `- Use case: ${USE_CASE_LABELS[useCase] ?? useCase}`,
    `- Deployment: ${deployProfile.replace(/_/g, " ")}`,
    `- Autonomy: ${AUTONOMY_LABELS[autonomyMode] ?? autonomyMode}`,
    `- Primary runtime: ${runtimeLabel}`,
    "",
    "## Your tasks",
    "",
    "1. Create a new company with a fitting name for the use case above.",
    "2. Create a company goal that reflects what the user is building.",
    `3. Hire a CEO agent (adapter type: ${runtimeLabel}).`,
    "4. Hire a founding engineer agent to handle technical work.",
    '5. Create a first task assigned to the CEO: "Define company roadmap and hire first team".',
    "",
    `Use the Paperclip API at ${baseUrl}/api. Board auth is handled by your local session.`,
    "",
    "Paperclip skill docs: run `paperclipai help` or check ~/.claude/skills/paperclip/.",
  );

  return lines.join("\n");
}

function buildRecommendation(
  profile: OnboardingProfileQuery,
  publicBaseUrl: string,
): OnboardingRecommendation {
  const deployProfile = profile.deployProfile ?? "local_solo";
  const runtime = profile.primaryRuntime ?? "claude_local";

  let deploymentMode: "local_trusted" | "authenticated" = "local_trusted";
  let deploymentExposure: "private" | "public" = "private";

  if (deployProfile === "shared_private") {
    deploymentMode = "authenticated";
    deploymentExposure = "private";
  } else if (deployProfile === "shared_public") {
    deploymentMode = "authenticated";
    deploymentExposure = "public";
  }

  const nextSteps: string[] = [];
  if (deployProfile === "local_solo") {
    nextSteps.push("Run `paperclipai run` to start Paperclip locally");
    nextSteps.push("Open http://127.0.0.1:3100 in your browser");
  } else if (deployProfile === "shared_private") {
    nextSteps.push("Configure a private network (e.g. Tailscale) for team access");
    nextSteps.push("Run `paperclipai auth bootstrap-ceo` to create the first admin invite");
  } else {
    nextSteps.push("Configure a public domain and TLS termination");
    nextSteps.push("Run `paperclipai auth bootstrap-ceo` to create the first admin invite");
  }

  nextSteps.push(
    "Paste the handoff prompt into your agent runtime to create your first company, agents, and task",
  );

  return {
    deploymentMode,
    deploymentExposure,
    suggestedAdapterType: runtime,
    nextSteps,
    handoffPromptUrl: `${publicBaseUrl}/api/onboarding/llm-handoff.txt`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Route factory
// ────────────────────────────────────────────────────────────────────────────

export function onboardingRoutes(db: Db) {
  const router = Router();

  /**
   * GET /onboarding/recommendation
   *
   * Query params (all optional):
   *   useCase, deployProfile, autonomyMode, primaryRuntime
   *
   * Returns a deployment recommendation.
   */
  router.get("/onboarding/recommendation", async (req, res) => {
    const profile: OnboardingProfileQuery = {
      useCase: req.query["useCase"] as OnboardingUseCase | undefined,
      deployProfile: req.query["deployProfile"] as DeployProfile | undefined,
      autonomyMode: req.query["autonomyMode"] as AutonomyMode | undefined,
      primaryRuntime: req.query["primaryRuntime"] as string | undefined,
    };

    const publicBaseUrl =
      process.env.PAPERCLIP_PUBLIC_URL ??
      `http://${req.hostname}:${(req.socket as { localPort?: number }).localPort ?? 3100}`;

    const recommendation = buildRecommendation(profile, publicBaseUrl);
    res.json(recommendation);
  });

  /**
   * GET /onboarding/llm-handoff.txt
   *
   * Returns a plain-text LLM handoff prompt. Same query params as recommendation.
   */
  router.get("/onboarding/llm-handoff.txt", async (req, res) => {
    const profile: OnboardingProfileQuery = {
      useCase: req.query["useCase"] as OnboardingUseCase | undefined,
      deployProfile: req.query["deployProfile"] as DeployProfile | undefined,
      autonomyMode: req.query["autonomyMode"] as AutonomyMode | undefined,
      primaryRuntime: req.query["primaryRuntime"] as string | undefined,
    };

    const publicBaseUrl =
      process.env.PAPERCLIP_PUBLIC_URL ??
      `http://${req.hostname}:${(req.socket as { localPort?: number }).localPort ?? 3100}`;

    // Check if any companies exist to tailor the message
    let hasExistingCompany = false;
    try {
      const [row] = await db.select({ total: count() }).from(companies);
      hasExistingCompany = (row?.total ?? 0) > 0;
    } catch {
      // non-fatal
    }

    const text = buildHandoffPromptText(profile, publicBaseUrl, hasExistingCompany);
    res.type("text/plain").send(text);
  });

  return router;
}
