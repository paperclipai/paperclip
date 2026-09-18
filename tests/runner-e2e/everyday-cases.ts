import type { RunnerProfileFixture, RunnerTaskFixture } from "./types.js";

/** No fixture completion/API directions: the normal execution prompt owns that contract. */
export function productionStoryProfile(
  profile: RunnerProfileFixture,
): RunnerProfileFixture {
  return {
    ...profile,
    buildAgent(input) {
      const payload = profile.buildAgent(input);
      return {
        ...payload,
        name: `Studio Lead ${input.executionId}`,
        role: "ceo",
        title: "Studio Lead",
        capabilities:
          "Builds small projects, delegates implementation, reviews delivered work, and hires teammates when requested.",
        instructionsBundle: {
          entryFile: "AGENTS.md",
          files: {
            "AGENTS.md":
              "You lead a small software studio. Help the user build useful small projects. Respect their requirements and verify the delivered work.",
          },
        },
      };
    },
  };
}

export const SLUGIFY_REQUIREMENTS = `Build a small dependency-free Python command-line tool in slugify.py. It accepts one positional string and prints its slug: trim whitespace, lowercase, replace each sequence outside ASCII a-z and 0-9 with one hyphen, then trim hyphens. Expose slugify(text) for reuse. Include a README and automated tests. Deliver the source and tests as a downloadable ZIP. Work in the project workspace.`;
export const SLUGIFY_REVISION = `Add an optional --separator argument that accepts either - or _. Keep - as the default and preserve the earlier behavior. Deliver an updated ZIP, keeping the previous download available.`;
export const LATE_REQUIREMENT = `Also support --max-length as a positive integer. Truncate the final slug to that length, then remove any trailing separator. In particular, input "  Queue--Ready!!  " with --max-length 7 must print "queue-r". Preserve the default behavior.`;

const definitions = [
  [
    "build-revise",
    "Build, download, and revise a project",
    SLUGIFY_REQUIREMENTS,
    2,
  ],
  [
    "delegate-feedback",
    "Delegate implementation and preserve late feedback",
    `Have Riley Builder implement the following as one child task. You review the downloaded result when it is ready. Keep implementation with Riley and post a progress note linking the child while work is underway. ${SLUGIFY_REQUIREMENTS}`,
    4,
  ],
  [
    "agent-review-handoff",
    "Delegate work through an agent review handoff",
    `Have Riley Builder implement the following as one child task. The child must keep its original Riley assignee throughout. Before Riley finishes, require a native needs_review report with exactly one attention request: kind review, ownerClass agent, targetAgentId set to your exact lead agent id, and a summary naming you as the reviewer. The child must remain in_review while waiting. When the durable review wake arrives, inspect the child task context, approve the review through the native resolve_review tool with decision accept, then finish the parent task. Do not patch the child status, reassign the child, self-approve the child from the parent run, or bypass the review interaction. ${SLUGIFY_REQUIREMENTS}`,
    3,
  ],
  [
    "hire-reuse",
    "Hire one teammate, then reuse that agent",
    `Hire exactly one agent named Morgan QA, reporting to you, using the same available AI connection and native runner configuration as you. Have Morgan implement the following in one child task, then review the result. ${SLUGIFY_REQUIREMENTS}`,
    6,
  ],
  [
    "service-approve",
    "Use a connection after approval",
    `Use the connected page service to find recent pages and create a short Markdown briefing document on this task. Include the titles and verification code returned by the service.`,
    2,
  ],
  [
    "service-decline",
    "Respect a declined tool action",
    `Use the connected page service to find recent pages and create a short Markdown briefing document on this task. Include the titles and verification code returned by the service. If I decline the action, do not try again or request another connection. Instead, give me a brief explanation that you could not retrieve the data. That explanation is the complete allowed fallback; no briefing is required after a decline.`,
    2,
  ],
  [
    "connection-decline",
    "Respect Not now on a new connection",
    `Please connect Notion so you can read my recent pages and write a short briefing. If I choose Not now, do not try again or use another service. Instead, give me a brief explanation that you could not retrieve the pages. That explanation is the complete allowed fallback; no briefing is required after a decline.`,
    2,
  ],
  [
    "recover-controller",
    "Recover work after the server restarts",
    SLUGIFY_REQUIREMENTS,
    3,
  ],
  [
    "stop-redirect",
    "Stop a task and send a new direction once",
    SLUGIFY_REQUIREMENTS,
    2,
  ],
  [
    "create-skill-studio",
    "Create and edit a company skill",
    "Create one company skill using this complete SKILL.md content:\n---\nname: release-readiness-checklist\ndescription: A bounded checklist for validating a release before handoff.\n---\n\n# Release Readiness Checklist\n\n1. Verify checks.\n2. Review evidence.\n3. Record the handoff.\n\nUse request key create-skill-e2e-001. After creating it, report the created skill and finish the task.",
    1,
  ],
] as const;

export const everydayTasks: readonly RunnerTaskFixture[] = definitions.map(
  ([id, label, prompt, expectedRunCount]) => ({
    id,
    label,
    groups: [],
    workMode: "standard",
    flow: "everyday_workflow",
    expectedRunCount,
    attemptTimeoutMs: { local: 12 * 60_000, daytona: 30 * 60_000 },
    expectedTerminalState: { issue: "done", run: "succeeded" },
    buildTitle: (nonce) => `${label} ${nonce}`,
    buildPrompt: () => prompt,
    buildVisibleMarker: (nonce) => `STUDIO_${nonce}`,
    buildMatchers: () => [], // The workflow records independent artifact and lifecycle checks.
  }),
);
