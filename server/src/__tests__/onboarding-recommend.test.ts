import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import type { OnboardingScanResponse } from "@paperclipai/shared";

import { errorHandler } from "../middleware/index.js";
import { onboardingRoutes } from "../routes/onboarding.js";
import { extractJsonObject, recommendOnboardingSetup } from "../services/onboarding-recommend.js";

function scan(overrides: Partial<OnboardingScanResponse> = {}): OnboardingScanResponse {
  return {
    displayPath: "/Users/example/projects/my-app",
    repoKind: "brownfield",
    counts: {
      directories: 3,
      files: 10,
      ignoredDirectories: 1,
      symlinks: 0,
    },
    detectedStacks: ["node", "typescript", "react"],
    packageManagers: ["pnpm"],
    safeManifestIndicators: ["package.json", "tsconfig.json"],
    warnings: [],
    boundedSanitizedSummary: {
      projectName: "my-app",
      dependencies: ["express", "react"],
      devDependencies: ["typescript", "vite"],
      hasReadme: true,
      directoryStructure: ["package.json", "src/"],
    },
    ...overrides,
  };
}

function app(actor: Partial<Express.Request["actor"]> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "11111111-1111-4111-8111-111111111111",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: true,
      ...actor,
    } as typeof req.actor;
    next();
  });
  app.use("/api", onboardingRoutes());
  app.use(errorHandler);
  return app;
}

describe("onboarding recommendation", () => {
  it("extracts strict recommendation JSON from Codex JSONL output", () => {
    const recommendation = {
      companyName: "CodexBar Runtime",
      operatingFocus: "Audit CodexBar and sequence the next MVP wave.",
      starterIssueTitle: "Run CodexBar Audit",
      starterIssueDescription: "Inspect CodexBar, verify startup, and report evidence-backed next steps.",
      squads: [
        { name: "CEO", role: "governance", adapterType: "claude_local", model: null },
        { name: "Implementation Lead", role: "engineer", adapterType: "codex_local", model: DEFAULT_CODEX_LOCAL_MODEL },
        { name: "Research Lead", role: "researcher", adapterType: "agy_local", model: "gemini-3.5-flash" },
      ],
    };
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(recommendation) },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 20 } }),
    ].join("\n");

    expect(extractJsonObject(stdout)).toEqual(recommendation);
  });

  it("recommends codex, claude, and agy without legacy gemini_local", () => {
    const result = recommendOnboardingSetup({
      scanSummary: scan(),
      userGoals: "Audit compiler errors",
    });

    expect(result.proposedSquads.map((squad) => squad.adapterType)).toEqual([
      "claude_local",
      "codex_local",
      "agy_local",
    ]);
    expect(result.proposedSquads.map((squad) => squad.adapterType)).not.toContain("gemini_local");
    expect(result.proposedSquads.find((squad) => squad.adapterType === "codex_local")).toMatchObject({
      model: DEFAULT_CODEX_LOCAL_MODEL,
    });
    expect(result.proposedSquads.find((squad) => squad.adapterType === "agy_local")).toMatchObject({
      model: "gemini-3.5-flash",
    });
    expect(result.recommendationSource).toBe("deterministic");
    expect(result.adapterOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ adapterType: "claude_local", authLabel: "Use existing Claude login" }),
        expect.objectContaining({ adapterType: "codex_local", authLabel: "Use existing Codex login" }),
        expect.objectContaining({
          adapterType: "agy_local",
          lockedModel: "gemini-3.5-flash",
          authLabel: "Use existing Google/Antigravity login",
        }),
      ]),
    );
    expect(result.proposedRequiredSecrets).toEqual([]);
    expect((result as { proposedOptionalSecrets?: unknown }).proposedOptionalSecrets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "GITHUB_TOKEN",
          storageProvider: "local_encrypted",
          requiredForOnboarding: false,
        }),
        expect.objectContaining({
          key: "PROJECT_RUNTIME_ENV",
          storageProvider: "local_encrypted",
          requiredForOnboarding: false,
        }),
      ]),
    );
    expect(result.proposedLocalAuthChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ adapterType: "claude_local", authMethod: "local_oauth" }),
        expect.objectContaining({ adapterType: "codex_local", authMethod: "local_oauth" }),
        expect.objectContaining({
          adapterType: "agy_local",
          provider: "google",
          quotaPolicy: "warn_unknown",
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("gemini-2.5");
    expect(JSON.stringify(result)).not.toContain("GEMINI_API_KEY");
    expect(JSON.stringify(result)).not.toContain("OPENAI_API_KEY");
    expect(JSON.stringify(result)).not.toContain("ANTHROPIC_API_KEY");
  });

  it("returns greenfield scaffold planning for empty folders without file-write instructions", () => {
    const result = recommendOnboardingSetup({
      scanSummary: scan({
        repoKind: "empty",
        detectedStacks: [],
        safeManifestIndicators: [],
        boundedSanitizedSummary: {
          projectName: "new-product",
          dependencies: [],
          devDependencies: [],
          hasReadme: false,
          directoryStructure: [],
        },
      }),
      userGoals: "Build a SaaS product",
    });

    expect(result.proposedStarterIssue.title).toBe("Design the First Approved Product Scaffold");
    expect(result.proposedStarterIssue.description).toContain("Do not write scaffold files");
  });

  it("exposes recommendations through a board-only route", async () => {
    const res = await request(app())
      .post("/api/onboarding/recommend")
      .send({ scanSummary: scan(), userGoals: "Audit compiler errors" });

    expect(res.status).toBe(200);
    expect(res.body.proposedSquads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ adapterType: "codex_local", model: DEFAULT_CODEX_LOCAL_MODEL }),
        expect.objectContaining({ adapterType: "agy_local", model: "gemini-3.5-flash" }),
      ]),
    );
    expect(res.body.adapterOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ adapterType: "codex_local" }),
        expect.objectContaining({ adapterType: "agy_local", lockedModel: "gemini-3.5-flash" }),
      ]),
    );
  });

  it("exposes onboarding adapter options through a board-only route", async () => {
    const res = await request(app()).get("/api/onboarding/adapter-options");

    expect(res.status).toBe(200);
    expect(res.body.adapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ adapterType: "claude_local", provider: "anthropic" }),
        expect.objectContaining({ adapterType: "codex_local", provider: "openai" }),
        expect.objectContaining({
          adapterType: "agy_local",
          provider: "google",
          lockedModel: "gemini-3.5-flash",
          models: [{ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }],
        }),
      ]),
    );
  });

  it("rejects agent actors for recommendation route", async () => {
    const res = await request(app({
      type: "agent",
      companyId: "company-1",
      agentId: "agent-1",
      runId: null,
    } as Partial<Express.Request["actor"]>))
      .post("/api/onboarding/recommend")
      .send({ scanSummary: scan(), userGoals: "Audit compiler errors" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Board access required" });
  });
});
