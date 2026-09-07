import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  aggregateProtocolEvalCampaign,
  buildProtocolEvalCatalog,
  credentialForConfig,
  sanitizeProtocolEvalRuns,
} from "./runner-protocol-eval-campaign.mjs";

const roots = [];
test.afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runner-protocol-campaign-"));
  roots.push(root);
  const program = join(root, "evals/paperclip-runner");
  await Promise.all([
    mkdir(join(program, "rosters"), { recursive: true }),
    mkdir(join(program, "configs"), { recursive: true }),
    mkdir(join(program, "cases"), { recursive: true }),
    mkdir(join(program, "campaigns"), { recursive: true }),
  ]);
  const config = {
    schema: "paperclip-runner/eval-config/v1",
    id: "live-opencode-model",
    provider: "opencode",
    driver: "opencode_server",
    model: "openrouter/example/model",
    opencodeVersion: "1.18.17",
  };
  const evalCase = {
    schema: "paperclip-runner/eval-case/v1",
    id: "get-task-context",
    title: "Get context",
    description: "Synthetic public fixture",
    prompt: "Inspect the synthetic task.",
    fixture: "../fixtures/company.json",
    authority: { actorId: "agent-1", taskId: "task-1" },
    checks: [{ id: "context", kind: "semantic_operation" }],
  };
  const roster = {
    schema: "paperclip-runner/live-roster/v1",
    id: "protocol-live-opencode-model",
    model: config.model,
    config: "../configs/live-opencode-model.json",
    cases: [evalCase.id],
  };
  await Promise.all([
    writeFile(
      join(program, "configs/live-opencode-model.json"),
      JSON.stringify(config),
    ),
    writeFile(
      join(program, "cases/get-task-context.json"),
      JSON.stringify(evalCase),
    ),
    writeFile(
      join(program, "rosters/live-opencode-model.json"),
      JSON.stringify(roster),
    ),
    writeFile(
      join(program, "campaigns/live-direct-full.json"),
      JSON.stringify({
        schema: "paperclip-runner/live-campaign/v1",
        lanes: [
          {
            id: "opencode-model",
            executionClass: "default",
            roster: "../rosters/live-opencode-model.json",
          },
        ],
      }),
    ),
  ]);
  return { root, program, config, evalCase, roster };
}

test("maps every qualified driver to one explicit credential boundary", () => {
  assert.equal(credentialForConfig({ provider: "codex" }), "OPENAI_API_KEY");
  assert.equal(
    credentialForConfig({ provider: "opencode" }),
    "OPENROUTER_API_KEY",
  );
  assert.equal(
    credentialForConfig({ provider: "acpx", acpxAgent: "claude" }),
    "ANTHROPIC_API_KEY",
  );
  assert.equal(
    credentialForConfig({ provider: "aws_agentcore" }),
    "AWS_AGENTCORE_OIDC",
  );
  assert.throws(
    () => credentialForConfig({ provider: "unknown" }),
    /credential policy/,
  );
});

test("catalogs roster plus case cells and emits bounded balanced shards", async () => {
  const { root } = await fixture();
  const catalog = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-1",
    maxParallel: 80,
  });
  assert.equal(catalog.cells.length, 1);
  assert.equal(catalog.cells[0].credentialName, "OPENROUTER_API_KEY");
  assert.equal(catalog.maxParallelPerShard, 40);
  assert.equal(catalog.matrices[0].include.length, 1);
  assert.equal(catalog.matrices[1].include.length, 0);
  await assert.rejects(
    buildProtocolEvalCatalog({
      evalsRoot: root,
      campaignId: "gha-42-1",
      rosterSelection: "missing-roster",
    }),
    /Unknown live roster/,
  );
  await assert.rejects(
    buildProtocolEvalCatalog({
      evalsRoot: root,
      campaignId: "gha-42-1",
      maxParallel: 1,
    }),
    /from 2 through 100/,
  );
});

test("all selects the maintained enabled campaign and explicit diagnostics can select disabled rosters", async () => {
  const { root, program, config, evalCase } = await fixture();
  const disabledRoster = {
    schema: "paperclip-runner/live-roster/v1",
    id: "protocol-live-disabled-model",
    model: config.model,
    config: "../configs/live-opencode-model.json",
    cases: [evalCase.id],
  };
  await Promise.all([
    writeFile(
      join(program, "rosters/live-disabled-model.json"),
      JSON.stringify(disabledRoster),
    ),
    writeFile(
      join(program, "campaigns/live-direct-full.json"),
      JSON.stringify({
        schema: "paperclip-runner/live-campaign/v1",
        lanes: [
          {
            id: "opencode-model",
            executionClass: "default",
            roster: "../rosters/live-opencode-model.json",
          },
          {
            id: "disabled-model",
            executionClass: "disabled",
            roster: "../rosters/live-disabled-model.json",
          },
        ],
      }),
    ),
  ]);

  const maintained = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-1",
  });
  assert.deepEqual(
    maintained.rosters.map((roster) => roster.rosterId),
    ["protocol-live-opencode-model"],
  );

  const diagnostic = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-2",
    rosterSelection: "protocol-live-disabled-model",
  });
  assert.deepEqual(
    diagnostic.rosters.map((roster) => roster.rosterId),
    ["protocol-live-disabled-model"],
  );
});

test("all fails closed when the maintained campaign is missing", async () => {
  const { root, program } = await fixture();
  await rm(join(program, "campaigns/live-direct-full.json"));

  await assert.rejects(
    buildProtocolEvalCatalog({
      evalsRoot: root,
      campaignId: "gha-42-1",
    }),
    /ENOENT/,
  );

  const diagnostic = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-2",
    rosterSelection: "protocol-live-opencode-model",
  });
  assert.deepEqual(
    diagnostic.rosters.map((roster) => roster.rosterId),
    ["protocol-live-opencode-model"],
  );
});

test("aggregates retained attempts and synthesizes missing cells as infrastructure", async () => {
  const { root, config, evalCase } = await fixture();
  const catalog = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-1",
  });
  const catalogPath = join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify(catalog));
  const campaign = await aggregateProtocolEvalCampaign({
    catalogPath,
    downloadsRoot: join(root, "missing-downloads"),
    evalsRoot: root,
    runsOut: join(root, "merged-runs"),
    campaignOut: join(root, "campaign.json"),
    source: {
      paperclip: { sha: "a".repeat(40), ref: "refs/heads/master" },
      evals: { repository: "paperclipai/paperclip-evals", sha: "b".repeat(40) },
      workflowRunUrl: "https://example.test/actions/runs/42",
    },
  });
  assert.deepEqual(campaign.totals, {
    selected: 1,
    passed: 0,
    behaviorFailures: 0,
    infrastructureFailures: 1,
  });
  assert.equal(campaign.results[0].disposition, "infrastructure_failure");
  assert.equal(campaign.complete, true);
  assert.equal(campaign.allPassed, false);
  const attempt = campaign.results[0].finalAttemptId;
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "merged-runs", attempt, "case.json"))),
    evalCase,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(root, "merged-runs", attempt, "config.json")),
    ),
    config,
  );
});

test("rejects downloaded cells that were not declared by the immutable catalog", async () => {
  const { root } = await fixture();
  const catalog = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-1",
  });
  const catalogPath = join(root, "catalog.json");
  const downloads = join(root, "downloads/unexpected");
  await mkdir(downloads, { recursive: true });
  await Promise.all([
    writeFile(catalogPath, JSON.stringify(catalog)),
    writeFile(
      join(downloads, "cell.json"),
      JSON.stringify({
        cellId: "protocol-live-opencode-model--undeclared",
        rosterFile: "live-opencode-model.json",
        caseId: "undeclared",
        exitCode: 1,
      }),
    ),
  ]);
  await assert.rejects(
    aggregateProtocolEvalCampaign({
      catalogPath,
      downloadsRoot: join(root, "downloads"),
      evalsRoot: root,
      runsOut: join(root, "merged-runs"),
      campaignOut: join(root, "campaign.json"),
      source: {},
    }),
    /unexpected cell/,
  );
});

test("public run projection removes provider sessions, traces, transcripts, evidence, and state", async () => {
  const { root, config, evalCase } = await fixture();
  const attemptId = "get-task-context-opencode-gha-42-1-attempt-01";
  const source = join(root, "raw-runs", attemptId);
  await mkdir(source, { recursive: true });
  await Promise.all([
    writeFile(
      join(source, "artifact.json"),
      JSON.stringify({
        schema: "paperclip-runner/eval-session-artifact/v1",
        attemptId,
        createdAt: "2026-09-05T00:00:00.000Z",
        requestedModel: config.model,
        provider: config.provider,
        driver: config.driver,
        providerVersion: config.opencodeVersion,
        providerSessionId: "private-session-id",
        trace: { secret: "private" },
        usage: {
          agentTurns: 1,
          inputTokens: 100,
          estimatedCostNanodollars: 5000,
        },
        turn: { status: "completed", turnId: "private-turn" },
        snapshot: {
          createdAt: "2026-09-05T00:00:00.000Z",
          providerModel: { id: config.model, provider: "openrouter" },
          transcript: [{ role: "assistant", text: "private transcript" }],
          evidence: [{ kind: "tool_call", data: { token: "private" } }],
        },
        issueThread: { messages: ["private"] },
        devtools: { revisions: [{ state: { private: true } }] },
      }),
    ),
    writeFile(
      join(source, "score.json"),
      JSON.stringify({
        schema: "paperclip-runner/eval-score/v1",
        attemptId,
        caseId: evalCase.id,
        disposition: "passed",
        passed: true,
        infrastructureErrors: [],
        checks: [
          {
            id: "context",
            kind: "semantic_operation",
            passed: true,
            detail: "private result",
            evidenceRefs: ["event-1"],
          },
        ],
        digest: "sha256:test",
      }),
    ),
    writeFile(join(source, "case.json"), JSON.stringify(evalCase)),
    writeFile(
      join(source, "config.json"),
      JSON.stringify({ ...config, managedProfile: { profileId: "private" } }),
    ),
  ]);
  await sanitizeProtocolEvalRuns({
    runsRoot: join(root, "raw-runs"),
    publicRunsRoot: join(root, "public-runs"),
  });
  const serialized = await readFile(
    join(root, "public-runs", attemptId, "artifact.json"),
    "utf8",
  );
  assert.doesNotMatch(
    serialized,
    /private-session|private transcript|private-turn|issueThread|trace/,
  );
  const artifact = JSON.parse(serialized);
  assert.deepEqual(artifact.snapshot.transcript, []);
  assert.deepEqual(artifact.snapshot.evidence, []);
  assert.deepEqual(artifact.devtools.revisions, []);
  const score = JSON.parse(
    await readFile(join(root, "public-runs", attemptId, "score.json"), "utf8"),
  );
  assert.deepEqual(score.checks[0], {
    id: "context",
    kind: "semantic_operation",
    passed: true,
    detail: "passed",
    evidenceRefs: [],
  });
  const publicConfig = await readFile(
    join(root, "public-runs", attemptId, "config.json"),
    "utf8",
  );
  assert.doesNotMatch(publicConfig, /managedProfile|private/);
});

test("public run projection redacts remote profile version identities", async () => {
  const { root, config, evalCase } = await fixture();
  const attemptId = "get-task-context-claude-managed-gha-42-1-attempt-01";
  const source = join(root, "raw-runs", attemptId);
  await mkdir(source, { recursive: true });
  await Promise.all([
    writeFile(
      join(source, "artifact.json"),
      JSON.stringify({
        schema: "paperclip-runner/eval-session-artifact/v1",
        attemptId,
        createdAt: "2026-09-05T00:00:00.000Z",
        requestedModel: "claude-sonnet-5",
        provider: "claude_managed",
        driver: "claude_managed_agents_api",
        providerVersion: "private-agent-version-id",
        usage: {},
        turn: { status: "completed" },
        snapshot: {
          createdAt: "2026-09-05T00:00:00.000Z",
          providerModel: { id: "claude-sonnet-5", provider: "anthropic" },
        },
      }),
    ),
    writeFile(
      join(source, "score.json"),
      JSON.stringify({
        schema: "paperclip-runner/eval-score/v1",
        attemptId,
        caseId: evalCase.id,
        disposition: "passed",
        passed: true,
        checks: [],
      }),
    ),
    writeFile(join(source, "case.json"), JSON.stringify(evalCase)),
    writeFile(
      join(source, "config.json"),
      JSON.stringify({
        ...config,
        id: "live-claude-managed",
        model: "claude-sonnet-5",
        provider: "claude_managed",
        driver: "claude_managed_agents_api",
      }),
    ),
  ]);
  await sanitizeProtocolEvalRuns({
    runsRoot: join(root, "raw-runs"),
    publicRunsRoot: join(root, "public-runs"),
  });
  const publicArtifact = await readFile(
    join(root, "public-runs", attemptId, "artifact.json"),
    "utf8",
  );
  assert.match(publicArtifact, /remote profile redacted/);
  assert.doesNotMatch(publicArtifact, /private-agent-version-id/);
});
