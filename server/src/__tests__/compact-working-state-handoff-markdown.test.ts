import { describe, expect, it } from "vitest";
import { buildCompactWorkingStateHandoffMarkdown } from "../services/compact-working-state.js";

function validHandoffInput(overrides: Record<string, unknown> = {}) {
  const selfReport = {
    stage: "implementation",
    status: "in_progress",
    workingNotes: "Tests are authored; production emission is not implemented yet.",
    acceptance: [
      {
        id: "AC1",
        text: "Fresh-session wakes receive a compact working-state handoff.",
        status: "pending",
        assertedBy: "agent",
        verified: false,
        evidence: [],
      },
    ],
    tests: {
      written: [
        {
          path: "server/src/__tests__/compact-working-state-handoff-markdown.test.ts",
          kind: "unit",
          status: "added",
          verified: false,
          evidence: [],
        },
      ],
      runs: [],
    },
    blocker: null,
    requiredHandoff: { required: false, to: null, status: "in_progress", reason: null },
    next: "Implement the fresh-session handoff markdown helper.",
  };

  return {
    issue: {
      identifier: "PB-81",
      id: "issue-machine-id",
      objective: "Emit compact working-state handoff on intentional fresh sessions.",
    },
    currentRun: { id: "run-machine-id" },
    persistedSession: { id: "session-machine-id" },
    currentAgent: { role: "engineer", name: "paperclip-engineer" },
    stage: "implementation",
    selfReport,
    observedChanges: {
      files: [
        {
          path: "server/src/services/compact-working-state.ts",
          status: "modified",
          verified: false,
          evidence: [],
        },
      ],
      commits: [],
    },
    artifacts: [{ kind: "run_log", ref: "paperclip:run:run-machine-id:log" }],
    rawTranscriptRefs: [{ ref: "paperclip:run:run-machine-id:transcript", replayByDefault: false }],
    ...overrides,
  };
}

function parseSingleHandoffPacket(markdown: string) {
  expect(markdown.match(/```handoff-v1/g)).toHaveLength(1);
  expect(markdown.match(/```/g)).toHaveLength(2);
  expect(markdown).toMatch(/^```handoff-v1\n[\s\S]+\n```$/);
  return JSON.parse(markdown.slice("```handoff-v1\n".length, -"\n```".length)) as Record<string, unknown>;
}

describe("compact working-state handoff markdown", () => {
  it("[BLIND] serializes fresh-session handoff as one handoff-v1 fenced compact packet", () => {
    const markdown = buildCompactWorkingStateHandoffMarkdown(validHandoffInput());

    expect(markdown).not.toBeNull();
    const packet = parseSingleHandoffPacket(markdown as string);
    expect(packet.packetKind).toBe("compact_working_state");
    expect(packet.v).toBe(1);
  });

  it("[BLIND] uses machine identity for provenance instead of self-report claims", () => {
    const markdown = buildCompactWorkingStateHandoffMarkdown(validHandoffInput({
      selfReport: {
        ...(validHandoffInput().selfReport as Record<string, unknown>),
        issue: "SELF-REPORTED",
        issueId: "self-reported-issue-id",
        sourceRunId: "self-reported-run-id",
        sourceSessionId: "self-reported-session-id",
        from: "planner",
        to: "reviewer",
      },
    }));

    const packet = parseSingleHandoffPacket(markdown as string);
    expect(packet.issue).toBe("PB-81");
    expect(packet.issueId).toBe("issue-machine-id");
    expect(packet.sourceRunId).toBe("run-machine-id");
    expect(packet.sourceSessionId).toBe("session-machine-id");
    expect(packet.from).toBe("engineer");
    expect(packet.to).toBe("engineer");
  });

  it("[BLIND] returns null without a semantic self-report so existing reset behavior is unchanged", () => {
    expect(buildCompactWorkingStateHandoffMarkdown(validHandoffInput({ selfReport: undefined }))).toBeNull();
    expect(buildCompactWorkingStateHandoffMarkdown(validHandoffInput({ selfReport: null }))).toBeNull();
  });

  it("[BLIND] does not require or enable rotation thresholds to emit the compact handoff", () => {
    const markdown = buildCompactWorkingStateHandoffMarkdown(validHandoffInput({
      sessionCompactionPolicy: {
        enabled: false,
        maxSessionRuns: 0,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 0,
      },
    }));

    const packet = parseSingleHandoffPacket(markdown as string);
    expect(packet.packetKind).toBe("compact_working_state");
  });

  it("[BLIND] rejects packet shapes that violate the compact working-state contract", () => {
    expect(() => buildCompactWorkingStateHandoffMarkdown(validHandoffInput({
      observedChanges: {
        files: [
          {
            path: "server/src/services/compact-working-state.ts",
            status: "pending",
            verified: false,
            evidence: [],
          },
        ],
        commits: [],
      },
    }))).toThrow(/changes\.files\[0\]\.status/);

    expect(() => buildCompactWorkingStateHandoffMarkdown(validHandoffInput({
      selfReport: {
        ...(validHandoffInput().selfReport as Record<string, unknown>),
        tests: {
          written: [
            {
              path: "server/src/__tests__/compact-working-state-handoff-markdown.test.ts",
              kind: "unit",
              verified: false,
              evidence: [],
            },
          ],
          runs: [],
        },
      },
    }))).toThrow(/tests\.written\[0\]\.status/);

    expect(() => buildCompactWorkingStateHandoffMarkdown(validHandoffInput({
      selfReport: {
        ...(validHandoffInput().selfReport as Record<string, unknown>),
        acceptance: [
          {
            id: "AC1",
            text: "Fresh-session wakes receive a compact working-state handoff.",
            status: "verified_passed",
            assertedBy: "agent",
            verified: false,
            evidence: [{ kind: "test_command", ref: "paperclip:run:run-machine-id:event:1", verified: true }],
          },
        ],
      },
    }))).toThrow(/acceptance\[0\]\.verified/);

    expect(() => buildCompactWorkingStateHandoffMarkdown(validHandoffInput({
      selfReport: {
        ...(validHandoffInput().selfReport as Record<string, unknown>),
        tests: {
          written: [],
          runs: [
            {
              command: "pnpm test",
              result: "verified_passed",
              assertedBy: "agent",
              verified: false,
              evidence: [{ kind: "test_command", ref: "paperclip:run:run-machine-id:event:1", verified: true }],
            },
          ],
        },
      },
    }))).toThrow(/tests\.runs\[0\]\.verified/);
  });
});
