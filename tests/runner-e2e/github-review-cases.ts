import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EnvironmentFixture, RunnerProfileFixture, RunnerSuiteFixture } from "./types.js";

export function buildGitHubReviewJourneySuite(profiles: readonly RunnerProfileFixture[], environments: readonly EnvironmentFixture[]): RunnerSuiteFixture {
  const base = profiles.find(p => p.id === "runner-codex")!;
  const profile: RunnerProfileFixture = { ...base, id: "configured-agent", label: "Existing review agent (profile-bound)", groups: [],
    model: "configured-in-journey-profile", provider: "configured-in-journey-profile", supportedEnvironments: ["local", "daytona"],
    modelQualification: { source: "candidate_runner_profile", qualificationId: "explicit-attached-agent-profile" },
    buildAgent: () => { throw new Error("GitHub review journey uses the explicitly bound existing agent"); } };
  const hash = createHash("sha256");
  for (const file of ["github-review-cases.ts", "github-review-config.ts", "github-review-browser.ts", "github-review-attendance.ts", "github-review-flow.ts", "github-review-launch.ts", "github-review-report.ts", "github-review-evidence.ts", "github-review-ownership.ts", "journey-dependencies.ts"]) hash.update(file).update(readFileSync(new URL(`./${file}`, import.meta.url)));
  return { id: "github-review-journey", label: "GitHub review bot setup and first review", groups: [], manualOnly: true,
    description: "Attended real GitHub App setup, repository-scoped installation, automatic PR review, independent publication and task checks. Reuses a private QA repository.",
    profiles: [profile], environments, expectedMatrixSize: 2,
    definitionMetadata: { version: 1, digest: hash.digest("hex"), scheduling: "explicit-only", sourceJourneySha256: "2a504ec0b68c42d597a20fad5fc3bb8d7086ab5c24d34fc75c2a031f8559ab40",
      applicability: ["self-hosted-with-public-github-ingress", "paperclip-cloud-with-github-app-support"], mcpConnections: [],
      dependencies: [{ alias: "github-user", consumer: "browser", required: true }, { alias: "github-verification-mailbox", consumer: "harness", phase: "setup-profile-dependent" }, { alias: "review-agent", consumer: "product-agent", required: true },
        { alias: "github-user-connection", consumer: "browser-identity-verification", required: true }, { alias: "review-bot-app", consumer: "product-agent", phase: "created-in-journey" }], authentication: "dedicated-browser-with-profile-bound-authentication", providerCredential: "existing-product-agent-binding" },
    tasks: [{ id: "setup-and-first-review", label: "Create App, configure Ponytail skill, open PR, verify automatic review", groups: [], flow: "github_review_journey", workMode: "standard",
      expectedRunCount: 3, minimumExpectedRunCount: 1, automaticRetryPolicy: "single_attempt", attemptTimeoutMs: { local: 1_800_000, daytona: 1_800_000 }, turnTimeoutMs: 600_000,
      expectedTerminalState: { issue: "done", run: "succeeded" }, buildTitle: n => `GitHub review journey ${n}`, buildPrompt: () => "Real GitHub opened event; never dispatched by fixture.", buildVisibleMarker: n => n, buildMatchers: () => [] }] };
}
