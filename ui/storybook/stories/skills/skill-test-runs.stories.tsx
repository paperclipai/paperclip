import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { Routes, Route } from "@/lib/router";
import { SkillStudio } from "@/pages/SkillStudio";
import { makeSkill } from "../../support/capability-gaps/skills";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
function Studio() {
  return (
    <Routes>
      <Route path="/PAP/skills/studio/:skillId" element={<SkillStudio />} />
    </Routes>
  );
}
const meta = {
  id: "feature-skill-test-runs",
  title: "Agents and reusable capabilities/Skills and Skill Studio/Test runs",
  component: Studio,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/skills/studio/skill-gap"],
    paperclip: {
      "capabilities": [
        "skills/testing"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "SkillStudio test history statuses and result detail with immutable fixture output/version. No agent/provider runs; authoring, harness execution, persisted costs and snapshots require production tests."
    },
  },
  beforeEach: ({ parameters }) => {
    const skill = makeSkill();
    const run = {
      id: "run-gap",
      companyId: skill.companyId,
      skillId: skill.id,
      inputId: "input-gap",
      inputSnapshot: "Review this release.",
      skillVersionId: "version-gap",
      agentId: "agent-codex",
      agentConfigSnapshot: {},
      issueId: "task-gap",
      templateId: null,
      templateName: null,
      templateBody: null,
      renderedTemplateBody: null,
      harnessIssueDescription: "Review this release.",
      status: parameters.runStatus ?? "succeeded",
      outputDocumentKey: "result",
      outputSnapshot:
        parameters.runStatus === "running" || parameters.runStatus === "queued"
          ? null
          : "The release checks passed.",
      error:
        parameters.runStatus === "failed"
          ? "The provider could not complete the test."
          : null,
      deletedAt: null,
      supersededAt: null,
      harnessIssueExpiresAt: null,
      harnessIssueDeletedAt: null,
      createdAt: "2026-10-12T12:00:00Z",
      updatedAt: "2026-10-12T12:01:00Z",
      cost: {
        costCents: 2,
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 50,
      },
      taskExpired: false,
    };
    let runs = parameters.fixtureState === "empty" ? [] : [run];
    const detail = () => ({
      ...run,
      skillVersion: {
        id: "version-gap",
        companyId: skill.companyId,
        companySkillId: skill.id,
        revisionNumber: 1,
        label: "Release check",
        releaseId: null,
        releaseName: null,
        releasedAt: null,
        fileInventory: [],
        authorAgentId: null,
        authorUserId: "user-storybook",
        createdAt: run.createdAt,
      },
      outputBody: run.outputSnapshot,
      harnessContent: {
        available: false,
        unavailableReason: "expired",
        documents: [],
        attachments: [],
        workProducts: [],
      },
      harnessIssue: null,
      documents: [],
      interactions: [],
      artifacts: [],
    });
    return prepareFixtureApi(
      [
        {
          path: "/api/companies/company-storybook/skills",
          read: () => [skill],
        },
        {
          path: "/api/companies/company-storybook/skills/skill-gap",
          read: () => skill,
        },
        {
          path: "/api/companies/company-storybook/skills/skill-gap/files",
          read: () => ({
            skillId: skill.id,
            path: "SKILL.md",
            content: skill.markdown,
            language: "markdown",
            editable: true,
          }),
        },
        {
          path: "/api/companies/company-storybook/skills/skill-gap/test-inputs",
          read: () =>
            parameters.fixtureState === "empty"
              ? []
              : [
                  {
                    id: "input-gap",
                    companyId: skill.companyId,
                    skillId: skill.id,
                    name: "Release review",
                    content: "Review this release.",
                    createdBy: null,
                    deletedAt: null,
                    createdAt: run.createdAt,
                    updatedAt: run.updatedAt,
                  },
                ],
        },
        {
          path: "/api/companies/company-storybook/skill-test-run-templates",
          read: () => [],
        },
        {
          path: "/api/companies/company-storybook/skills/skill-gap/test-runs",
          read: ({ method }) => {
            if (method === "POST") {
              const queued = { ...run, id: "run-queued", status: "queued" };
              runs = [queued, ...runs];
              return queued;
            }
            return runs;
          },
        },
        {
          path: "/api/companies/company-storybook/skills/skill-gap/test-runs/run-gap",
          read: detail,
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof Studio>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CompletedTest: Story = {};
export const Queued: Story = { parameters: { runStatus: "queued" } };
export const Running: Story = { parameters: { runStatus: "running" } };
export const TestFailed: Story = { parameters: { runStatus: "failed" } };
export const Empty: Story = { parameters: { fixtureState: "empty" } };
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const LoadFailed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};

export const ResultDetails: Story = {
  parameters: { initialEntries: ["/PAP/skills/studio/skill-gap?run=run-gap"] },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("The release checks passed.");
  },
};
