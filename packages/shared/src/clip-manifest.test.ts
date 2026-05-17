import { describe, expect, it } from "vitest";
import type { CompanyPortabilityManifest } from "./types/company-portability.js";
import {
  buildAgentClipSnapshot,
  buildBundleClipSnapshot,
  buildRoutineClipSnapshot,
  buildSkillClipSnapshot,
  buildTeamClipSnapshot,
  clipManifestSchema,
} from "./clip-manifest.js";

const exportedAt = "2026-05-16T00:00:00.000Z";

function fixtureManifest(): CompanyPortabilityManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-05-15T00:00:00.000Z",
    source: {
      companyId: "67f12493-f655-41e7-b5f5-dbe2f44dd7ba",
      companyName: "Private Customer Ops",
    },
    includes: {
      company: true,
      agents: true,
      projects: true,
      issues: true,
      skills: true,
    },
    company: {
      path: "COMPANY.md",
      name: "Private Customer Ops",
      description: "Routes support for https://localhost:8443/internal and customer jane@example.com",
      brandColor: "#111111",
      logoPath: null,
      attachmentMaxBytes: null,
      requireBoardApprovalForNewAgents: true,
      feedbackDataSharingEnabled: false,
      feedbackDataSharingConsentAt: null,
      feedbackDataSharingConsentByUserId: null,
      feedbackDataSharingTermsVersion: null,
    },
    sidebar: {
      agents: ["ceo", "support"],
      projects: ["support"],
    },
    agents: [
      {
        slug: "support",
        name: "Support Engineer",
        path: "agents/support/AGENTS.md",
        skills: ["triage"],
        role: "engineer",
        title: "Support Engineer",
        icon: "code",
        capabilities: "Uses bearer token Bearer shh-secret-token for examples",
        reportsToSlug: "ceo",
        adapterType: "codex_local",
        adapterConfig: {
          cwd: "/Users/dotta/private-support",
          command: "/Users/dotta/.local/bin/codex",
          env: {
            GH_TOKEN: {
              type: "secret_ref",
              secretId: "secret-gh-token",
              version: "latest",
            },
            INTERNAL_URL: {
              type: "plain",
              value: "http://localhost:3100/private",
            },
            SAFE_MODE: {
              type: "plain",
              value: "true",
            },
          },
        },
        runtimeConfig: {
          heartbeat: {
            intervalSec: 3600,
          },
        },
        permissions: {
          github: {
            issues: {
              write: true,
            },
          },
          browser: true,
        },
        budgetMonthlyCents: 1200,
        metadata: {
          privateRepoUrl: "https://git.internal/example/private",
        },
      },
      {
        slug: "ceo",
        name: "CEO",
        path: "agents/ceo/AGENTS.md",
        skills: [],
        role: "ceo",
        title: "Chief Executive Officer",
        icon: null,
        capabilities: "Owns strategy",
        reportsToSlug: null,
        adapterType: "claude_local",
        adapterConfig: {
          promptTemplate: "You are CEO.",
        },
        runtimeConfig: {},
        permissions: {},
        budgetMonthlyCents: 0,
        metadata: null,
      },
    ],
    skills: [
      {
        key: "triage",
        slug: "triage",
        name: "Triage",
        path: "skills/triage/SKILL.md",
        description: "Classifies inbound support work.",
        sourceType: "bundled",
        sourceLocator: null,
        sourceRef: null,
        trustLevel: "company",
        compatibility: null,
        metadata: null,
        fileInventory: [{ path: "skills/triage/SKILL.md", kind: "skill" }],
      },
    ],
    projects: [
      {
        slug: "support",
        name: "Support",
        path: "projects/support/PROJECT.md",
        description: "Private support project",
        ownerAgentSlug: "support",
        leadAgentSlug: "support",
        targetDate: null,
        color: null,
        status: "in_progress",
        env: {
          SUPPORT_DSN: {
            type: "plain",
            value: "postgres://user:pass@localhost:5432/app",
          },
        },
        executionWorkspacePolicy: null,
        workspaces: [
          {
            key: "support-repo",
            name: "Support repo",
            sourceType: "git",
            repoUrl: "https://github.com/paperclipai/paperclip",
            repoRef: null,
            defaultRef: "main",
            visibility: "public",
            setupCommand: "pnpm install",
            cleanupCommand: null,
            metadata: null,
            isPrimary: true,
          },
        ],
        metadata: null,
      },
    ],
    issues: [
      {
        slug: "triage-hourly",
        identifier: "PAP-1",
        title: "Triage hourly",
        path: "tasks/triage-hourly/TASK.md",
        projectSlug: "support",
        projectWorkspaceKey: "support-repo",
        assigneeAgentSlug: "support",
        description: "Runs on a webhook and schedule.",
        recurring: true,
        routine: {
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          variables: [
            {
              name: "CUSTOMER_EMAIL",
              type: "text",
              label: "Customer email",
              required: false,
              defaultValue: "jane@example.com",
              options: [],
            },
          ],
          triggers: [
            {
              kind: "webhook",
              label: "Inbound webhook",
              enabled: true,
              cronExpression: null,
              timezone: null,
              signingMode: "hmac_sha256",
              replayWindowSec: 120,
            },
            {
              kind: "schedule",
              label: "Hourly",
              enabled: true,
              cronExpression: "0 * * * *",
              timezone: "UTC",
              signingMode: null,
              replayWindowSec: null,
            },
          ],
        },
        legacyRecurrence: null,
        status: "todo",
        priority: "medium",
        labelIds: [],
        billingCode: null,
        executionWorkspaceSettings: null,
        assigneeAdapterOverrides: null,
        comments: [
          {
            body: "Private comment with sk-testsecret1234567890",
            authorType: "agent",
            authorAgentSlug: "support",
            authorUserId: null,
            presentation: null,
            metadata: null,
            createdAt: exportedAt,
          },
        ],
        metadata: null,
      },
    ],
    envInputs: [
      {
        key: "GH_TOKEN",
        description: "GitHub token",
        agentSlug: "support",
        projectSlug: null,
        kind: "secret",
        requirement: "required",
        defaultValue: "ghp_supersecretsecret",
        portability: "portable",
      },
    ],
  };
}

const clip = {
  slug: "support-triage",
  revisionNumber: 1,
  title: "Support Triage",
  summary: "Routes support tickets.",
  visibility: "public" as const,
  creator: {
    profileId: "creator_1",
    handle: "paperclip",
    displayName: "Paperclip",
  },
};

describe("clip manifest foundation", () => {
  it("builds a deterministic versioned bundle manifest with checksums and dependencies", () => {
    const first = buildBundleClipSnapshot({
      clip,
      artifact: { manifest: fixtureManifest(), files: { "COMPANY.md": "# Company" } },
      source: { exportedAt },
      social: {
        sourceUrl: "https://paperclip.ing/clips/support-triage",
        revisionUrl: "https://paperclip.ing/clips/support-triage/revisions/1",
      },
    });
    const second = buildBundleClipSnapshot({
      clip,
      artifact: { manifest: fixtureManifest(), files: { "COMPANY.md": "# Company" } },
      source: { exportedAt },
      social: {
        sourceUrl: "https://paperclip.ing/clips/support-triage",
        revisionUrl: "https://paperclip.ing/clips/support-triage/revisions/1",
      },
    });

    expect(clipManifestSchema.parse(first)).toEqual(first);
    expect(first.checksums).toEqual(second.checksums);
    expect(first.clip.revisionId).toEqual(second.clip.revisionId);
    expect(first.schema).toBe("paperclip.clip/v1");
    expect(first.artifact.version).toBe("agentcompanies/v1-draft");
    expect(first.dependencies.adapters.map((entry) => entry.type)).toEqual(["claude_local", "codex_local"]);
    expect(first.dependencies.skills.map((entry) => entry.key)).toEqual(["triage"]);
    expect(first.dependencies.secrets.map((entry) => entry.key)).toContain("GH_TOKEN");
    expect(first.dependencies.permissions.map((entry) => entry.capability)).toContain("github.issues.write");
    expect(first.dependencies.runtime).toMatchObject({
      browser: true,
      filesystem: "declared",
      webhooks: true,
      recurringRoutines: true,
    });
    expect(first.dependencies.budgetHints.monthlyCents).toBe(1200);
  });

  it("omits secrets, local paths, private URLs, raw comments, and routine webhook signing details", () => {
    const manifest = buildRoutineClipSnapshot({
      clip: { ...clip, slug: "support-routine" },
      artifact: { manifest: fixtureManifest() },
      source: { exportedAt },
      routineSlug: "triage-hourly",
    });
    const serialized = JSON.stringify(manifest);

    expect(serialized).not.toContain("secret-gh-token");
    expect(serialized).not.toContain("ghp_supersecretsecret");
    expect(serialized).not.toContain("sk-testsecret");
    expect(serialized).not.toContain("/Users/dotta");
    expect(serialized).not.toContain("localhost");
    expect(serialized).not.toContain("https://git.internal");
    expect(serialized).not.toContain("hmac_sha256");
    expect(manifest.artifact.payload.manifest.issues[0]?.comments).toEqual([]);
    expect(manifest.artifact.payload.manifest.issues[0]?.routine?.triggers.every((trigger) => !trigger.enabled)).toBe(true);
    expect(manifest.security.routinePolicy).toEqual({
      importedTriggersEnabledByDefault: false,
      webhookSecretsRegenerated: true,
    });
    expect(manifest.security.redactionReport.summary.omitted).toBeGreaterThan(0);
    expect(manifest.security.redactionReport.entries.map((entry) => entry.path)).toContain("issues[0].comments");
  });

  it("scopes agent, team, skill, and routine snapshots to the selected portable object", () => {
    const agent = buildAgentClipSnapshot({
      clip: { ...clip, slug: "support-agent" },
      artifact: { manifest: fixtureManifest() },
      source: { exportedAt },
      agentSlug: "support",
    });
    const team = buildTeamClipSnapshot({
      clip: { ...clip, slug: "support-team" },
      artifact: { manifest: fixtureManifest() },
      source: { exportedAt },
      teamRootAgentSlug: "ceo",
    });
    const skill = buildSkillClipSnapshot({
      clip: { ...clip, slug: "triage-skill" },
      artifact: { manifest: fixtureManifest() },
      source: { exportedAt },
      skillKey: "triage",
    });
    const routine = buildRoutineClipSnapshot({
      clip: { ...clip, slug: "triage-routine" },
      artifact: { manifest: fixtureManifest() },
      source: { exportedAt },
      routineSlug: "triage-hourly",
    });

    expect(agent.clip.type).toBe("agent");
    expect(agent.artifact.payload.manifest.agents.map((entry) => entry.slug)).toEqual(["support"]);
    expect(team.clip.type).toBe("team");
    expect(team.artifact.payload.manifest.agents.map((entry) => entry.slug)).toEqual(["ceo", "support"]);
    expect(skill.clip.type).toBe("skill");
    expect(skill.artifact.payload.manifest.skills.map((entry) => entry.key)).toEqual(["triage"]);
    expect(skill.artifact.payload.manifest.agents).toEqual([]);
    expect(routine.clip.type).toBe("routine");
    expect(routine.artifact.payload.manifest.issues.map((entry) => entry.slug)).toEqual(["triage-hourly"]);
  });
});
