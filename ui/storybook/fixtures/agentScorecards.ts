// Storybook fixtures for the Agent Scorecards panel (BLO-10275).
// Designed to exercise every state the panel must render:
//  - ranked agents with sufficient sample (good + poor performers)
//  - a PAUSED poor performer that is still ranked on failure rate but whose
//    cost/done is N/A (0 done) — proves "poor performer" is distinct from "low sample"
//  - the "Insufficient sample" group (1/1 review record, and a zero-activity agent)
// Numbers are internally consistent with the server contract in
// server/src/services/agent-scorecards.ts.
import type { AgentScorecardsResult } from "@/api/dashboard";

const WINDOW = {
  windowDays: 30,
  windowStart: "2026-05-14T00:00:00.000Z",
  windowEnd: "2026-06-13T00:00:00.000Z",
  generatedAt: "2026-06-13T05:10:00.000Z",
  minSampleDone: 5,
  minSampleRuns: 10,
  minSampleReviews: 5,
} as const;

export const storybookAgentScorecards: AgentScorecardsResult = {
  ...WINDOW,
  agents: [
    // --- Ranked (sufficient sample), ordered cost/done asc, nulls last ---
    {
      agentId: "agent-release-eng",
      agentName: "Release Engineer",
      status: "active",
      doneIssues: 22,
      costUsd: 70.4,
      costPerDoneIssue: 3.2,
      completedRuns: 48,
      failedRuns: 4,
      cancelledRuns: 3,
      failureRate: 4 / 48,
      reviewedIssues: 25,
      passedReviews: 23,
      reviewPassRate: 23 / 25,
      lowSample: false,
      perMetricSufficient: { costPerDoneIssue: true, failureRate: true, reviewPassRate: true },
    },
    {
      agentId: "agent-cto",
      agentName: "CTO",
      status: "active",
      doneIssues: 14,
      costUsd: 71.4,
      costPerDoneIssue: 5.1,
      completedRuns: 60,
      failedRuns: 9,
      cancelledRuns: 5,
      failureRate: 9 / 60,
      reviewedIssues: 18,
      passedReviews: 15,
      reviewPassRate: 15 / 18,
      lowSample: false,
      perMetricSufficient: { costPerDoneIssue: true, failureRate: true, reviewPassRate: true },
    },
    {
      agentId: "agent-uxdesigner",
      agentName: "UXDesigner",
      status: "active",
      doneIssues: 9,
      costUsd: 70.2,
      costPerDoneIssue: 7.8,
      completedRuns: 20,
      failedRuns: 2,
      cancelledRuns: 1,
      failureRate: 2 / 20,
      reviewedIssues: 8,
      passedReviews: 7,
      reviewPassRate: 7 / 8,
      lowSample: false,
      perMetricSufficient: { costPerDoneIssue: true, failureRate: true, reviewPassRate: true },
    },
    {
      // Paused poor performer: enough runs to rank failure rate (89% — flagged
      // red), but 0 done → cost/done is N/A, not 0/∞. Distinct from low sample.
      agentId: "agent-penstock-cmo",
      agentName: "Penstock Cmo",
      status: "paused",
      doneIssues: 0,
      costUsd: 41.3,
      costPerDoneIssue: null,
      completedRuns: 37,
      failedRuns: 33,
      cancelledRuns: 4,
      failureRate: 33 / 37,
      reviewedIssues: 2,
      passedReviews: 0,
      reviewPassRate: 0,
      lowSample: false,
      perMetricSufficient: { costPerDoneIssue: false, failureRate: true, reviewPassRate: false },
    },
    // --- Insufficient sample (lowSample = done<5 AND runs<10) ---
    {
      // 1/1 review record — must NOT read as a 100% track record.
      agentId: "agent-penstock-cdo",
      agentName: "Penstock Cdo",
      status: "active",
      doneIssues: 1,
      costUsd: 6.5,
      costPerDoneIssue: 6.5,
      completedRuns: 3,
      failedRuns: 0,
      cancelledRuns: 0,
      failureRate: 0,
      reviewedIssues: 1,
      passedReviews: 1,
      reviewPassRate: 1,
      lowSample: true,
      perMetricSufficient: { costPerDoneIssue: false, failureRate: false, reviewPassRate: false },
    },
    {
      // Zero activity in window — everything N/A.
      agentId: "agent-onboarding-bot",
      agentName: "Onboarding Bot",
      status: "idle",
      doneIssues: 0,
      costUsd: 0,
      costPerDoneIssue: null,
      completedRuns: 0,
      failedRuns: 0,
      cancelledRuns: 0,
      failureRate: null,
      reviewedIssues: 0,
      passedReviews: 0,
      reviewPassRate: null,
      lowSample: true,
      perMetricSufficient: { costPerDoneIssue: false, failureRate: false, reviewPassRate: false },
    },
  ],
};

export const storybookAgentScorecardsEmpty: AgentScorecardsResult = {
  ...WINDOW,
  agents: [],
};
