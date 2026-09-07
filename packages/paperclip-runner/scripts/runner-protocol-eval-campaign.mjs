#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ATTEMPT_FILES = new Set([
  "request.json",
  "artifact.json",
  "score.json",
  "compiled-fixture.json",
  "case.json",
  "config.json",
]);

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function loadObject(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Expected a JSON object: ${path}`);
  }
  return value;
}

function safeId(value, label = "identifier") {
  const result = String(value ?? "");
  if (!SAFE_ID.test(result)) throw new Error(`Unsafe ${label}: ${result}`);
  return result;
}

function inside(root, candidate, label) {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes its declared root`);
  }
  return resolve(candidate);
}

export function credentialForConfig(config) {
  if (config.provider === "opencode") return "OPENROUTER_API_KEY";
  if (config.provider === "claude_managed") return "ANTHROPIC_API_KEY";
  if (config.provider === "aws_agentcore") return "AWS_AGENTCORE_OIDC";
  if (config.provider === "codex" || config.provider === undefined) {
    return "OPENAI_API_KEY";
  }
  if (config.provider === "acpx") {
    if (config.acpxAgent === "pi") return "OPENROUTER_API_KEY";
    if (config.acpxAgent === "claude") return "ANTHROPIC_API_KEY";
    if (config.acpxAgent === "codex") return "OPENAI_API_KEY";
  }
  throw new Error(
    `No credential policy for ${config.provider ?? "codex"}/${config.acpxAgent ?? "default"}`,
  );
}

function parseRosterSelection(value) {
  if (!value?.trim() || value.trim() === "all") return null;
  const selected = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (selected.length === 0 || new Set(selected).size !== selected.length) {
    throw new Error("Roster selection must contain unique comma-separated IDs");
  }
  return new Set(selected);
}

async function maintainedRosterSelection(programRoot) {
  const campaignPath = resolve(programRoot, "campaigns/live-direct-full.json");
  const campaign = await loadObject(campaignPath);
  if (
    campaign.schema !== "paperclip-runner/live-campaign/v1" ||
    !Array.isArray(campaign.lanes)
  ) {
    throw new Error(`Unsupported live campaign schema in ${campaignPath}`);
  }
  const selected = campaign.lanes
    .filter((lane) => lane.executionClass !== "disabled")
    .map((lane) => {
      const rosterPath = inside(
        programRoot,
        resolve(dirname(campaignPath), String(lane.roster ?? "")),
        "Campaign roster",
      );
      return basename(rosterPath);
    });
  if (selected.length === 0 || new Set(selected).size !== selected.length) {
    throw new Error("Maintained live campaign must contain unique enabled rosters");
  }
  return new Set(selected);
}

export async function buildProtocolEvalCatalog({
  evalsRoot,
  rosterSelection = "all",
  campaignId,
  source = {},
  maxParallel = 100,
}) {
  safeId(campaignId, "campaign ID");
  if (
    !Number.isSafeInteger(maxParallel) ||
    maxParallel < 2 ||
    maxParallel > 100
  ) {
    throw new Error("maxParallel must be an integer from 2 through 100");
  }
  const programRoot = resolve(evalsRoot, "evals/paperclip-runner");
  const rosterRoot = resolve(programRoot, "rosters");
  const requested = parseRosterSelection(rosterSelection);
  const selected =
    requested ?? (await maintainedRosterSelection(programRoot));
  const rosterFiles = (await readdir(rosterRoot, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("live-") &&
        entry.name.endsWith(".json"),
    )
    .map((entry) => entry.name)
    .sort();
  const rosters = [];
  for (const rosterFile of rosterFiles) {
    const rosterPath = resolve(rosterRoot, rosterFile);
    const roster = await loadObject(rosterPath);
    const rosterId = safeId(roster.id, "roster ID");
    if (selected && !selected.has(rosterId) && !selected.has(rosterFile)) {
      continue;
    }
    if (roster.schema !== "paperclip-runner/live-roster/v1") {
      throw new Error(`Unsupported live roster schema in ${rosterFile}`);
    }
    if (!Array.isArray(roster.cases) || roster.cases.length === 0) {
      throw new Error(`Live roster ${rosterId} has no cases`);
    }
    const configPath = inside(
      programRoot,
      resolve(rosterRoot, String(roster.config ?? "")),
      `Config for ${rosterId}`,
    );
    const config = await loadObject(configPath);
    const credentialName = credentialForConfig(config);
    const cases = roster.cases.map((caseId) => safeId(caseId, "case ID"));
    if (new Set(cases).size !== cases.length) {
      throw new Error(`Live roster ${rosterId} repeats a case`);
    }
    rosters.push({
      rosterId,
      rosterFile,
      configFile: relative(programRoot, configPath).split(sep).join("/"),
      model: String(roster.model ?? config.model ?? "unknown"),
      provider: String(config.provider ?? "codex"),
      driver: String(config.driver ?? "codex_app_server"),
      credentialName,
      cases,
    });
  }
  if (selected) {
    const found = new Set(
      rosters.flatMap((roster) => [roster.rosterId, roster.rosterFile]),
    );
    const missing = [...selected].filter((entry) => !found.has(entry));
    if (missing.length > 0) {
      throw new Error(`Unknown live roster selection: ${missing.join(", ")}`);
    }
  }
  if (rosters.length === 0) throw new Error("No live rosters were selected");

  const cells = rosters.flatMap((roster) =>
    roster.cases.map((caseId) => ({
      cellId: safeId(`${roster.rosterId}--${caseId}`, "cell ID"),
      rosterId: roster.rosterId,
      rosterFile: roster.rosterFile,
      caseId,
      model: roster.model,
      provider: roster.provider,
      driver: roster.driver,
      credentialName: roster.credentialName,
    })),
  );
  const shards = [[], []];
  cells.forEach((cell, index) => shards[index % shards.length].push(cell));
  if (shards.some((shard) => shard.length > 256)) {
    throw new Error(
      "Protocol eval catalog exceeds the two-shard GitHub matrix limit",
    );
  }
  return {
    schema: "paperclip.runner-protocol-eval.catalog/v1",
    campaignId,
    source,
    rosters,
    cells,
    matrices: shards.map((include) => ({ include })),
    maxParallel,
    maxParallelPerShard: Math.floor(maxParallel / 2),
  };
}

async function writeGithubOutput(entries) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  await appendFile(
    output,
    Object.entries(entries)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

async function copyAttempt(source, destination) {
  const metadata = await lstat(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Attempt source is not a real directory: ${source}`);
  }
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !ATTEMPT_FILES.has(entry.name)
    ) {
      throw new Error(`Unexpected attempt path ${join(source, entry.name)}`);
    }
    await cp(join(source, entry.name), join(destination, entry.name), {
      errorOnExist: true,
    });
  }
  for (const required of [
    "artifact.json",
    "score.json",
    "case.json",
    "config.json",
  ]) {
    await lstat(join(destination, required));
  }
}

async function findFiles(root, name) {
  const metadata = await lstat(root).catch(() => null);
  if (!metadata) return [];
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Download root must be a real directory: ${root}`);
  }
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Refusing downloaded symlink: ${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name === name) found.push(absolute);
    }
  }
  await visit(root);
  return found.sort();
}

function safeUsage(usage) {
  const fields = [
    "agentTurns",
    "providerRequests",
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "reasoningTokens",
    "providerReportedCostNanodollars",
    "estimatedCostNanodollars",
  ];
  return Object.fromEntries(
    fields
      .filter((field) => Number.isFinite(usage?.[field]) && usage[field] >= 0)
      .map((field) => [field, usage[field]]),
  );
}

async function syntheticAttempt({ evalsRoot, runsOut, cell, campaignId }) {
  const programRoot = resolve(evalsRoot, "evals/paperclip-runner");
  const roster = await loadObject(
    resolve(programRoot, "rosters", cell.rosterFile),
  );
  const casePath = resolve(programRoot, "cases", `${cell.caseId}.json`);
  const configPath = inside(
    programRoot,
    resolve(programRoot, "rosters", String(roster.config)),
    `Config for ${cell.rosterId}`,
  );
  const [evalCase, config] = await Promise.all([
    loadObject(casePath),
    loadObject(configPath),
  ]);
  const attemptId = safeId(
    `${cell.cellId}-${campaignId}-missing`,
    "synthetic attempt ID",
  );
  const directory = resolve(runsOut, attemptId);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const createdAt = new Date().toISOString();
  const artifact = {
    schema: "paperclip-runner/eval-session-artifact/v1",
    attemptId,
    createdAt,
    requestedModel: config.model,
    provider: config.provider ?? "codex",
    driver: config.driver ?? "codex_app_server",
    providerVersion: config.opencodeVersion ?? null,
    usage: {},
    turn: { status: "failed" },
    snapshot: {
      createdAt,
      providerModel: {
        id: config.model,
        provider: config.modelProvider ?? config.provider ?? "unknown",
      },
      transcript: [],
      evidence: [],
    },
    devtools: { revisions: [] },
    infrastructureFailure: {
      class: "ci_cell_artifact_missing",
      category: "campaign_orchestration",
      retryable: false,
    },
  };
  const score = {
    schema: "paperclip-runner/eval-score/v1",
    attemptId,
    caseId: cell.caseId,
    disposition: "infrastructure_failure",
    passed: false,
    infrastructureErrors: [
      "The matrix cell did not retain a complete attempt artifact.",
    ],
    checks: [],
  };
  score.digest = `sha256:${createHash("sha256").update(JSON.stringify(score)).digest("hex")}`;
  await Promise.all([
    writeFile(join(directory, "artifact.json"), json(artifact), {
      mode: 0o600,
    }),
    writeFile(join(directory, "score.json"), json(score), { mode: 0o600 }),
    writeFile(join(directory, "case.json"), json(evalCase), { mode: 0o600 }),
    writeFile(join(directory, "config.json"), json(config), { mode: 0o600 }),
  ]);
  return attemptId;
}

export async function aggregateProtocolEvalCampaign({
  catalogPath,
  downloadsRoot,
  evalsRoot,
  runsOut,
  campaignOut,
  source,
}) {
  const catalog = await loadObject(catalogPath);
  if (catalog.schema !== "paperclip.runner-protocol-eval.catalog/v1") {
    throw new Error("Unsupported protocol eval catalog");
  }
  await rm(runsOut, { recursive: true, force: true });
  await mkdir(runsOut, { recursive: true });
  const retainedByCell = new Map();
  const expectedByCell = new Map(
    catalog.cells.map((cell) => [cell.cellId, cell]),
  );
  const copiedAttemptIds = new Set();
  for (const statusPath of await findFiles(downloadsRoot, "cell.json")) {
    const status = await loadObject(statusPath);
    const cellId = safeId(status.cellId, "recorded cell ID");
    if (retainedByCell.has(cellId))
      throw new Error(`Duplicate cell artifact ${cellId}`);
    const expected = expectedByCell.get(cellId);
    if (!expected)
      throw new Error(`Downloaded artifact names an unexpected cell ${cellId}`);
    if (
      status.caseId !== expected.caseId ||
      status.rosterFile !== expected.rosterFile
    ) {
      throw new Error(`Downloaded cell metadata drifted for ${cellId}`);
    }
    const attemptRoot = resolve(dirname(statusPath), "runs");
    const attemptIds = [];
    const attemptMetadata = await lstat(attemptRoot).catch(() => null);
    if (attemptMetadata?.isDirectory() && !attemptMetadata.isSymbolicLink()) {
      for (const entry of (
        await readdir(attemptRoot, { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error(
            `Unexpected cell run path ${join(attemptRoot, entry.name)}`,
          );
        }
        const attemptId = safeId(entry.name, "attempt ID");
        if (copiedAttemptIds.has(attemptId))
          throw new Error(`Duplicate attempt artifact ${attemptId}`);
        const [score, artifact, config] = await Promise.all([
          loadObject(join(attemptRoot, entry.name, "score.json")),
          loadObject(join(attemptRoot, entry.name, "artifact.json")),
          loadObject(join(attemptRoot, entry.name, "config.json")),
        ]);
        if (
          score.attemptId !== attemptId ||
          artifact.attemptId !== attemptId ||
          score.caseId !== expected.caseId ||
          config.model !== expected.model ||
          (config.provider ?? "codex") !== expected.provider ||
          (config.driver ?? "codex_app_server") !== expected.driver
        ) {
          throw new Error(`Downloaded attempt identity drifted for ${cellId}`);
        }
        await copyAttempt(
          join(attemptRoot, entry.name),
          join(runsOut, attemptId),
        );
        copiedAttemptIds.add(attemptId);
        attemptIds.push(attemptId);
      }
    }
    retainedByCell.set(cellId, { status, attemptIds });
  }

  const results = [];
  for (const cell of catalog.cells) {
    const retained = retainedByCell.get(cell.cellId);
    const attemptIds = retained?.attemptIds?.length
      ? retained.attemptIds
      : [
          await syntheticAttempt({
            evalsRoot,
            runsOut,
            cell,
            campaignId: catalog.campaignId,
          }),
        ];
    const finalAttemptId = attemptIds.at(-1);
    const [score, artifact] = await Promise.all([
      loadObject(join(runsOut, finalAttemptId, "score.json")),
      loadObject(join(runsOut, finalAttemptId, "artifact.json")),
    ]);
    if (score.caseId !== cell.caseId || score.attemptId !== finalAttemptId) {
      throw new Error(`Final attempt identity drifted for ${cell.cellId}`);
    }
    results.push({
      cellId: cell.cellId,
      rosterId: cell.rosterId,
      caseId: cell.caseId,
      model: cell.model,
      provider: cell.provider,
      driver: cell.driver,
      attemptIds,
      finalAttemptId,
      disposition: score.disposition,
      passed: score.passed === true,
      usage: safeUsage(artifact.usage),
      cellExitCode: Number.isSafeInteger(retained?.status?.exitCode)
        ? retained.status.exitCode
        : null,
    });
  }
  const totals = {
    selected: results.length,
    passed: results.filter((result) => result.passed).length,
    behaviorFailures: results.filter(
      (result) => result.disposition === "behavior_failure",
    ).length,
    infrastructureFailures: results.filter(
      (result) => result.disposition === "infrastructure_failure",
    ).length,
  };
  const generatedAt = new Date().toISOString();
  const campaign = {
    schema: "paperclip.runner-protocol-eval.campaign/v1",
    campaignId: catalog.campaignId,
    generatedAt,
    source: {
      paperclip: source.paperclip,
      evals: source.evals,
      workflowRunUrl: source.workflowRunUrl,
    },
    complete: results.length === catalog.cells.length,
    allPassed: totals.passed === totals.selected,
    totals,
    rosters: catalog.rosters.map((roster) => ({
      rosterId: roster.rosterId,
      model: roster.model,
      provider: roster.provider,
      driver: roster.driver,
      selected: roster.cases.length,
      passed: results.filter(
        (result) => result.rosterId === roster.rosterId && result.passed,
      ).length,
    })),
    results,
  };
  await mkdir(dirname(campaignOut), { recursive: true });
  await writeFile(campaignOut, json(campaign), { mode: 0o600 });
  return campaign;
}

function publicArtifact(artifact) {
  const model = artifact.snapshot?.providerModel ?? {};
  const infrastructure = artifact.infrastructureFailure;
  const providerVersion =
    artifact.provider === "claude_managed" ||
    artifact.provider === "aws_agentcore"
      ? "remote profile redacted"
      : (artifact.providerVersion ?? null);
  return {
    schema: artifact.schema,
    attemptId: artifact.attemptId,
    createdAt: artifact.createdAt,
    requestedModel: artifact.requestedModel,
    provider: artifact.provider,
    driver: artifact.driver,
    providerVersion,
    retainedSession: false,
    retainedSessionStatus: "redacted from the public report",
    usage: safeUsage(artifact.usage),
    turn: { status: artifact.turn?.status ?? "failed" },
    snapshot: {
      createdAt: artifact.snapshot?.createdAt ?? artifact.createdAt,
      providerModel: {
        id: model.id ?? artifact.requestedModel,
        provider: model.provider ?? artifact.provider,
      },
      transcript: [],
      evidence: [],
    },
    devtools: { revisions: [] },
    ...(infrastructure && typeof infrastructure === "object"
      ? {
          infrastructureFailure: {
            class: infrastructure.class,
            category: infrastructure.category,
            retryable: infrastructure.retryable === true,
          },
        }
      : {}),
  };
}

function publicScore(score) {
  return {
    schema: score.schema,
    attemptId: score.attemptId,
    caseId: score.caseId,
    disposition: score.disposition,
    passed: score.passed === true,
    infrastructureErrors:
      score.disposition === "infrastructure_failure"
        ? [
            "Infrastructure failure; diagnostic details remain in the access-controlled artifact.",
          ]
        : [],
    checks: Array.isArray(score.checks)
      ? score.checks.map((check) => ({
          id: check.id,
          kind: check.kind,
          passed: check.passed === true,
          detail: check.passed === true ? "passed" : "failed",
          evidenceRefs: [],
        }))
      : [],
    digest: score.digest,
  };
}

function publicConfig(config) {
  return Object.fromEntries(
    [
      "schema",
      "id",
      "model",
      "provider",
      "driver",
      "opencodeVersion",
      "acpxAgent",
      "modelProvider",
    ]
      .filter((field) => config[field] !== undefined)
      .map((field) => [field, config[field]]),
  );
}

export async function sanitizeProtocolEvalRuns({ runsRoot, publicRunsRoot }) {
  await rm(publicRunsRoot, { recursive: true, force: true });
  await mkdir(publicRunsRoot, { recursive: true });
  const attemptIds = [];
  for (const entry of (await readdir(runsRoot, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        `Unexpected merged run path ${join(runsRoot, entry.name)}`,
      );
    }
    const attemptId = safeId(entry.name, "attempt ID");
    const source = join(runsRoot, attemptId);
    const [artifact, score, evalCase, config] = await Promise.all([
      loadObject(join(source, "artifact.json")),
      loadObject(join(source, "score.json")),
      loadObject(join(source, "case.json")),
      loadObject(join(source, "config.json")),
    ]);
    if (artifact.attemptId !== attemptId || score.attemptId !== attemptId) {
      throw new Error(`Attempt identity drifted in ${attemptId}`);
    }
    const destination = join(publicRunsRoot, attemptId);
    await mkdir(destination, { mode: 0o700 });
    await Promise.all([
      writeFile(
        join(destination, "artifact.json"),
        json(publicArtifact(artifact)),
        { mode: 0o600 },
      ),
      writeFile(join(destination, "score.json"), json(publicScore(score)), {
        mode: 0o600,
      }),
      writeFile(join(destination, "case.json"), json(evalCase), {
        mode: 0o600,
      }),
      writeFile(join(destination, "config.json"), json(publicConfig(config)), {
        mode: 0o600,
      }),
    ]);
    attemptIds.push(attemptId);
  }
  return attemptIds;
}

function argument(args, name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "catalog") {
    const output = resolve(
      argument(args, "--output", "runner-protocol-eval-catalog.json"),
    );
    const catalog = await buildProtocolEvalCatalog({
      evalsRoot: resolve(argument(args, "--evals-root", ".paperclip-evals")),
      rosterSelection: argument(args, "--rosters", "all"),
      campaignId: argument(args, "--campaign-id", `local-${Date.now()}`),
      maxParallel: Number(argument(args, "--max-parallel", "100")),
      source: {
        paperclipSha: process.env.PAPERCLIP_PROTOCOL_EVAL_SOURCE_SHA ?? null,
        evalsSha: process.env.PAPERCLIP_PROTOCOL_EVALS_SHA ?? null,
      },
    });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json(catalog), { mode: 0o600 });
    await writeGithubOutput({
      matrix_0: JSON.stringify(catalog.matrices[0]),
      matrix_1: JSON.stringify(catalog.matrices[1]),
      matrix_1_present: String(catalog.matrices[1].include.length > 0),
      max_parallel_per_shard: String(catalog.maxParallelPerShard),
      selected: String(catalog.cells.length),
    });
    console.log(
      json({
        output,
        selected: catalog.cells.length,
        rosters: catalog.rosters.length,
      }).trim(),
    );
    return;
  }
  if (command === "aggregate") {
    const campaign = await aggregateProtocolEvalCampaign({
      catalogPath: resolve(argument(args, "--catalog")),
      downloadsRoot: resolve(argument(args, "--downloads")),
      evalsRoot: resolve(argument(args, "--evals-root")),
      runsOut: resolve(argument(args, "--runs-out")),
      campaignOut: resolve(argument(args, "--campaign-out")),
      source: {
        paperclip: {
          sha: process.env.PAPERCLIP_PROTOCOL_EVAL_SOURCE_SHA,
          ref: process.env.PAPERCLIP_PROTOCOL_EVAL_SOURCE_REF,
        },
        evals: {
          repository: "paperclipai/paperclip-evals",
          sha: process.env.PAPERCLIP_PROTOCOL_EVALS_SHA,
        },
        workflowRunUrl: process.env.PAPERCLIP_PROTOCOL_EVAL_WORKFLOW_URL,
      },
    });
    console.log(json(campaign.totals).trim());
    return;
  }
  if (command === "sanitize") {
    const attemptIds = await sanitizeProtocolEvalRuns({
      runsRoot: resolve(argument(args, "--runs-root")),
      publicRunsRoot: resolve(argument(args, "--output")),
    });
    console.log(json({ attempts: attemptIds.length }).trim());
    return;
  }
  throw new Error(
    "Usage: runner-protocol-eval-campaign.mjs <catalog|aggregate|sanitize> ...",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
