#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function parseArgs(argv) {
  const parsed = {
    keep: false,
    sourceIssueId: process.env.PAPERCLIP_TASK_ID ?? null,
    projectId: process.env.PAPERCLIP_PROJECT_ID ?? null,
    goalId: process.env.PAPERCLIP_GOAL_ID ?? null,
    runKey: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") {
      parsed.keep = true;
      continue;
    }
    if (arg === "--source-issue-id") {
      parsed.sourceIssueId = argv[++index] ?? null;
      continue;
    }
    if (arg === "--project-id") {
      parsed.projectId = argv[++index] ?? null;
      continue;
    }
    if (arg === "--goal-id") {
      parsed.goalId = argv[++index] ?? null;
      continue;
    }
    if (arg === "--run-key") {
      parsed.runKey = argv[++index] ?? null;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printUsage() {
  console.log(`
Usage:
  PAPERCLIP_API_URL=http://localhost:3100 \\
  PAPERCLIP_API_KEY=... \\
  PAPERCLIP_COMPANY_ID=... \\
  pnpm smoke:terminal-bench-loop-skill

Options:
  --source-issue-id <uuid>  Attach smoke issues under an existing Paperclip issue.
  --project-id <uuid>       Override inferred project id.
  --goal-id <uuid>          Override inferred goal id.
  --run-key <string>        Stable key used in smoke titles and mocked artifact paths.
  --keep                    Leave smoke issues in their verified blocked/in_review posture.
`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Run against a local Paperclip server with an agent or board API token.`);
  }
  return value;
}

function slugify(value) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertLocalSkillPackage() {
  const skillPath = join(repoRoot, "skills", "terminal-bench-loop", "SKILL.md");
  const markdown = await readFile(skillPath, "utf8");
  for (const expected of [
    "name: terminal-bench-loop",
    "request_confirmation",
    "diagnosis",
    "blockedByIssueIds",
    "PAPERCLIPAI_CMD",
    "PAPERCLIP_HARBOR_RUNNER_CONFIG",
  ]) {
    assert(markdown.includes(expected), `Skill smoke expected ${skillPath} to mention ${expected}`);
  }
}

function createApiClient({ apiUrl, apiKey, runId }) {
  const baseUrl = apiUrl.replace(/\/+$/, "");

  return async function api(method, path, { body, ok } = {}) {
    const expectedStatuses = ok ?? (method === "POST" || method === "PUT" ? [200, 201] : [200]);
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (runId && method !== "GET") {
      headers["X-Paperclip-Run-Id"] = runId;
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!expectedStatuses.includes(response.status)) {
      throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
    }
    return data;
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiUrl = requireEnv("PAPERCLIP_API_URL");
  const apiKey = requireEnv("PAPERCLIP_API_KEY");
  const companyId = requireEnv("PAPERCLIP_COMPANY_ID");
  const runId = process.env.PAPERCLIP_RUN_ID ?? null;
  const api = createApiClient({ apiUrl, apiKey, runId });

  await assertLocalSkillPackage();

  const sourceIssue = args.sourceIssueId
    ? await api("GET", `/api/issues/${args.sourceIssueId}`)
    : null;
  const projectId = args.projectId ?? sourceIssue?.projectId ?? null;
  const goalId = args.goalId ?? sourceIssue?.goalId ?? null;
  const runKey = slugify(args.runKey ?? runId ?? `local-${new Date().toISOString()}`);
  const artifactRoot = `mock://terminal-bench-loop-smoke/${runKey}`;
  const titlePrefix = `[smoke:${runKey}]`;
  const commonIssueFields = {
    ...(projectId ? { projectId } : {}),
    ...(goalId ? { goalId } : {}),
    priority: "low",
  };

  const loop = await api("POST", `/api/companies/${companyId}/issues`, {
    body: {
      ...commonIssueFields,
      ...(sourceIssue ? { parentId: sourceIssue.id } : {}),
      title: `${titlePrefix} Terminal-Bench loop skill smoke`,
      status: "todo",
      description: [
        "Deterministic smoke for the /terminal-bench-loop skill.",
        "",
        "- Task: terminal-bench/fix-git",
        "- Iteration budget: 1",
        "- Benchmark command: mocked; no Terminal-Bench, Harbor, model, or provider process is started.",
        `- Artifact root: ${artifactRoot}`,
      ].join("\n"),
    },
  });

  const iteration = await api("POST", `/api/companies/${companyId}/issues`, {
    body: {
      ...commonIssueFields,
      parentId: loop.id,
      title: `${titlePrefix} Iteration 1: terminal-bench/fix-git`,
      status: "todo",
      description: [
        "Smoke iteration child created by the deterministic terminal-bench-loop skill smoke.",
        "",
        "This issue records mocked run artifacts, diagnosis, and the pending confirmation path.",
      ].join("\n"),
    },
  });

  const runDocument = await api("PUT", `/api/issues/${iteration.id}/documents/run`, {
    body: {
      title: "Mocked benchmark run",
      format: "markdown",
      body: [
        "# Mocked benchmark run",
        "",
        "- Label: smoke / non-comparable",
        "- Terminal-Bench task: terminal-bench/fix-git",
        "- Stop reason: verifier_failed",
        `- Manifest: ${artifactRoot}/manifest.json`,
        `- Results JSONL: ${artifactRoot}/results.jsonl`,
        `- Harbor raw job folder: ${artifactRoot}/harbor/raw-job`,
        "- Dispatch config: PAPERCLIP_HARBOR_RUNNER_CONFIG=<omitted - harness/setup no-dispatch smoke>",
        "- Heartbeat-enabled agents: 0 (harness/setup no-dispatch; not a product signal)",
        "",
        "No benchmark process, Harbor job, model call, or provider call was started.",
      ].join("\n"),
      changeSummary: "Record deterministic mocked benchmark artifact paths.",
    },
  });

  const diagnosisDocument = await api("PUT", `/api/issues/${iteration.id}/documents/diagnosis`, {
    body: {
      title: "Smoke diagnosis",
      format: "markdown",
      body: [
        "# Smoke diagnosis",
        "",
        `Exact stop point: ${iteration.identifier ?? iteration.id} is waiting on a product-fix confirmation after a mocked verifier failure.`,
        "",
        "Next-action owner: board/user must accept or reject the confirmation before implementation subtasks exist.",
        "",
        "Failure taxonomy: Paperclip product gap, mocked for smoke coverage.",
        "",
        "Invariant check:",
        "",
        "- Productive work continues: acceptance wakes the assignee and would create the implementation path.",
        "- Only real blockers stop work: the loop parent is blocked by this iteration child while the confirmation is pending.",
        "- No infinite loops: iteration budget is 1 and the smoke does not start a rerun.",
      ].join("\n"),
      changeSummary: "Record exact stop point and next-action owner.",
    },
  });

  const planDocument = await api("PUT", `/api/issues/${iteration.id}/documents/plan`, {
    body: {
      title: "Smoke fix proposal",
      format: "markdown",
      body: [
        "# Smoke fix proposal",
        "",
        "Proposed product rule: a Terminal-Bench loop iteration that identifies a product gap must create a request_confirmation interaction before implementation subtasks exist.",
        "",
        `Evidence: mocked run document ${runDocument.id}; diagnosis document ${diagnosisDocument.id}.`,
      ].join("\n"),
      changeSummary: "Record smoke proposal for confirmation target.",
    },
  });

  const confirmation = await api("POST", `/api/issues/${iteration.id}/interactions`, {
    body: {
      kind: "request_confirmation",
      idempotencyKey: `confirmation:${iteration.id}:plan:${planDocument.latestRevisionId}`,
      title: "Smoke plan confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Accept the mocked terminal-bench-loop product-fix proposal?",
        acceptLabel: "Accept smoke plan",
        rejectLabel: "Reject smoke plan",
        rejectRequiresReason: true,
        rejectReasonLabel: "What should change?",
        detailsMarkdown: "This deterministic smoke verifies the waiting path only; do not treat it as a real benchmark result.",
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          issueId: iteration.id,
          documentId: planDocument.id,
          key: "plan",
          revisionId: planDocument.latestRevisionId,
          revisionNumber: planDocument.latestRevisionNumber,
          label: "Smoke fix proposal",
        },
      },
    },
  });

  await api("PATCH", `/api/issues/${iteration.id}`, {
    body: {
      status: "in_review",
      comment: [
        "Smoke waiting path opened.",
        "",
        `Pending confirmation: ${confirmation.id}`,
        "Next-action owner: board/user accepts or rejects the mocked proposal.",
      ].join("\n"),
    },
  });

  await api("PATCH", `/api/issues/${loop.id}`, {
    body: {
      status: "blocked",
      blockedByIssueIds: [iteration.id],
      comment: [
        "Smoke loop parent is blocked by its iteration child while the typed confirmation is pending.",
        "",
        `Blocking iteration: ${iteration.identifier ?? iteration.id}`,
      ].join("\n"),
    },
  });

  const [verifiedLoop, verifiedIteration, verifiedRunDoc, verifiedDiagnosisDoc, interactions] = await Promise.all([
    api("GET", `/api/issues/${loop.id}`),
    api("GET", `/api/issues/${iteration.id}`),
    api("GET", `/api/issues/${iteration.id}/documents/run`),
    api("GET", `/api/issues/${iteration.id}/documents/diagnosis`),
    api("GET", `/api/issues/${iteration.id}/interactions`),
  ]);

  assert(verifiedLoop.status === "blocked", `Expected loop issue to be blocked, got ${verifiedLoop.status}`);
  assert(
    Array.isArray(verifiedLoop.blockedBy) && verifiedLoop.blockedBy.some((blocker) => blocker.id === iteration.id),
    "Expected loop issue to be blocked by the iteration child",
  );
  assert(
    verifiedIteration.status === "in_review",
    `Expected iteration issue to be in_review, got ${verifiedIteration.status}`,
  );
  assert(verifiedRunDoc.body.includes(`${artifactRoot}/results.jsonl`), "Expected run doc to include mocked results path");
  assert(verifiedRunDoc.body.includes("PAPERCLIP_HARBOR_RUNNER_CONFIG"), "Expected run doc to record dispatch config");
  assert(
    verifiedDiagnosisDoc.body.includes("Exact stop point") && verifiedDiagnosisDoc.body.includes("Next-action owner"),
    "Expected diagnosis doc to include exact stop point and next-action owner",
  );
  assert(
    interactions.some((interaction) =>
      interaction.id === confirmation.id
      && interaction.kind === "request_confirmation"
      && interaction.status === "pending"
      && interaction.continuationPolicy === "wake_assignee"
    ),
    "Expected a pending request_confirmation interaction with wake_assignee continuation",
  );

  if (!args.keep) {
    await api("PATCH", `/api/issues/${loop.id}`, {
      body: {
        status: "cancelled",
        blockedByIssueIds: [],
        comment: "Smoke cleanup: verified topology and cancelled the short-lived loop parent.",
      },
    });
    await api("PATCH", `/api/issues/${iteration.id}`, {
      body: {
        status: "cancelled",
        comment: "Smoke cleanup: verified confirmation/waiting posture and cancelled the short-lived iteration child.",
      },
    });
  }

  console.log(JSON.stringify({
    ok: true,
    cleanup: !args.keep,
    loopIssue: { id: loop.id, identifier: loop.identifier ?? null },
    iterationIssue: { id: iteration.id, identifier: iteration.identifier ?? null },
    runDocument: runDocument.id,
    diagnosisDocument: diagnosisDocument.id,
    confirmation: confirmation.id,
    artifactRoot,
  }, null, 2));
}

main().catch((error) => {
  console.error(`terminal-bench-loop skill smoke failed: ${error.message}`);
  process.exit(1);
});
