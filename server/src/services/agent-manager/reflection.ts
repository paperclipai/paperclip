import type { JudgeCorrection, JudgeCriteriaResult } from "./types.js";

export function buildReflectionCommentBody(input: {
  score: number;
  threshold: number;
  attempt: number;
  maxAttempts: number;
  rationale: string;
  corrections: JudgeCorrection[];
  criteriaResults: JudgeCriteriaResult[];
}): string {
  const mustCorrections = input.corrections.filter((entry) => entry.priority === "must");
  const shouldCorrections = input.corrections.filter((entry) => entry.priority === "should");
  const correctionLines = [
    ...mustCorrections.map((entry, index) => `${index + 1}. **(must)** ${entry.instruction}`),
    ...shouldCorrections.map((entry, index) => `${mustCorrections.length + index + 1}. (should) ${entry.instruction}`),
  ];
  const criteriaLines = input.criteriaResults.map((entry) => `- [${entry.met ? "x" : " "}] ${entry.id}: ${entry.note}`);

  return `## Agent Manager reflection (attempt ${input.attempt}/${input.maxAttempts})

**Compliance score:** ${input.score}/100 (threshold: ${input.threshold})

### Rationale
${input.rationale}

### Required corrections
${correctionLines.length > 0 ? correctionLines.join("\n") : "_None listed — address rationale gaps._"}

### Criteria check
${criteriaLines.length > 0 ? criteriaLines.join("\n") : "_No criteria extracted._"}

---
Address the required corrections, verify against acceptance criteria, and update the issue when complete.`;
}

export function buildReflectionWakeContext(input: {
  evaluationId: string;
  score: number;
  attempt: number;
  maxAttempts: number;
  threshold: number;
  sourceRunId: string;
  issueId: string;
  corrections: JudgeCorrection[];
}) {
  return {
    issueId: input.issueId,
    wakeReason: "agent_manager_reflection",
    agentManagerReflection: {
      evaluationId: input.evaluationId,
      score: input.score,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      threshold: input.threshold,
      sourceRunId: input.sourceRunId,
      corrections: input.corrections.slice(0, 5),
    },
  };
}

export function buildReflectionCommentMetadata(input: {
  evaluationId: string;
  score: number;
  attempt: number;
  maxAttempts: number;
  sourceRunId: string;
}) {
  return {
    rowType: "agent_manager_reflection",
    evaluationId: input.evaluationId,
    score: input.score,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    sourceRunId: input.sourceRunId,
  };
}
