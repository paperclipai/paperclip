/**
 * Local proof for the batched requester-provenance check of inherited GitHub
 * review waits.
 *
 * `listExternalReviewWaits` serves the review waits of an issue list or an
 * inbox request. The pre-fix modules checked the requester provenance of every
 * waiting run with its own `chatRunSourceMessageId` call inside `Promise.all`,
 * so a request with N waits built and sent at least 2N statements at once
 * (one identity-context read and one source-message link read for each run,
 * and two more for each continuation in a run's lineage). The fix checks the
 * runs of one request with a number of statements that depends on the longest
 * lineage, not on the number of runs.
 *
 * The pre-fix modules are loaded from --baseline-ref. The script fails unless
 * both versions return the same waits and the same inherited wait for each
 * run.
 *
 *   pnpm --filter @paperclipai/server exec tsx scripts/benchmark-review-wait-provenance.ts --baseline-ref=<pre-fix commit>
 *
 * Optional sizes: WAITS (default 250), CONTINUED_EVERY (10: every tenth wait
 * continues an earlier run), CONTINUATIONS (3: the length of that lineage),
 * POOL (50), PAIRS (15).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints,
  chatExternalPrincipals, chatGitHubReviews, chatIdentityLinks, chatMessageLinks, companies, companyMemberships,
  createDb, heartbeatRuns, issueComments, runIdentityContexts, toolApplications, toolConnections,
  type Db } from "@paperclipai/db";
import { defaultGitHubReviewPolicy } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../src/__tests__/helpers/embedded-postgres.js";
import { readInheritedGitHubReviewWaits } from "../src/services/chat-channels/github/review-wait.js";
import { listExternalReviewWaits } from "../src/services/native-runtime/external-review-wait.js";

const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const WAITS = size("WAITS", 250), CONTINUED_EVERY = size("CONTINUED_EVERY", 10), CONTINUATIONS = size("CONTINUATIONS", 3);
const POOL = size("POOL", 50), PAIRS = size("PAIRS", 15);
for (const [name, value] of Object.entries({ WAITS, CONTINUED_EVERY, CONTINUATIONS, POOL, PAIRS })) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
}
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-fix --baseline-ref=<commit>");
const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const baselineRevision = git("rev-parse", "--verify", `${baselineRef}^{commit}`).trim();
// The modules of the read path. Each pre-fix copy imports the pre-fix copies
// of the others; every other import resolves to the current tree.
const modules = ["server/src/services/native-runtime/external-review-wait.ts",
  "server/src/services/chat-channels/github/review-wait.ts", "server/src/services/chat-channels/run-origin.ts"];

type Versions = { list: typeof listExternalReviewWaits; inherited: typeof readInheritedGitHubReviewWaits };
const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
let baselineDir: string | undefined;
try {
  baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.review-wait-provenance-baseline-"));
  const copyOf = (file: string) => path.join(baselineDir!, path.basename(file));
  for (const file of modules) {
    const source = git("show", `${baselineRevision}:${file}`).replace(/from "(\.{1,2}\/[^"]+)"/g, (_match, specifier: string) => {
      const target = fileURLToPath(new URL(specifier, pathToFileURL(path.join(root, file))));
      const module = modules.find(candidate => path.join(root, candidate) === target.replace(/\.js$/, ".ts"));
      return `from ${JSON.stringify(module ? copyOf(module) : target)}`;
    });
    await fs.writeFile(copyOf(file), source);
  }
  const load = async (file: string) => await import(pathToFileURL(copyOf(file)).href);
  const versions: Record<string, Versions> = {
    baseline: { list: (await load(modules[0]!)).listExternalReviewWaits,
      inherited: (await load(modules[1]!)).readInheritedGitHubReviewWaits },
    treatment: { list: listExternalReviewWaits, inherited: readInheritedGitHubReviewWaits },
  };

  temporary = await startEmbeddedPostgresTestDatabase("review-wait-provenance-benchmark-");
  db = createDb(temporary.connectionString, { maxConnections: POOL });
  const sql = db.$client;
  const loadStart = performance.now();

  // One company, one agent and one GitHub repository with WAITS reviewed pull
  // requests. Each pull request has a task in review that waits for the next
  // GitHub reply.
  const companyId = randomUUID(), agentId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID();
  const endpointId = randomUUID(), resourceId = randomUUID(), principalId = randomUUID();
  const repository = "synthetic/repository", repositoryId = "42", headSha = "1".repeat(40), user = "operator";
  await db.insert(companies).values({ id: companyId, name: "Synthetic review", issuePrefix: "SYN" });
  // A fixture agent that never runs. It is not created through the agent lifecycle module.
  await sql.unsafe("insert into agents (id, company_id, name, adapter_type) values ($1::uuid, $2::uuid, 'Reviewer', 'process')",
    [agentId, companyId]);
  await db.insert(toolApplications).values({ id: applicationId, companyId, name: "GitHub", type: "chat" });
  await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "GitHub",
    uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
  await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "github",
    publicId: endpointId, assignedAgentId: agentId, status: "active", providerAccountId: "synthetic" });
  await db.insert(chatEndpointResources).values({ id: resourceId, companyId, endpointId, type: "repository",
    providerResourceId: repository, label: repository, metadata: { providerRepositoryId: repositoryId },
    availability: "available", enabled: true });
  await db.insert(chatExternalPrincipals).values({ id: principalId, companyId, provider: "github",
    providerAccountId: "synthetic", externalId: "1", kind: "user" });
  await db.insert(chatIdentityLinks).values({ companyId, endpointId, principalId, paperclipUserId: user, status: "linked" });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: user,
    status: "active", membershipRole: "member" });

  const waits = Array.from({ length: WAITS }, (_unused, index) => ({
    pullNumber: index + 1, issueId: randomUUID(), runId: randomUUID(), reviewRunId: randomUUID(), reviewId: randomUUID(),
    decisionId: randomUUID(), conversationId: randomUUID(), commentId: randomUUID(), deliveryId: randomUUID(),
    // The run of every CONTINUED_EVERY-th wait continues earlier runs of its
    // task. The first run of that lineage accepted the GitHub comment.
    lineage: Array.from({ length: index % CONTINUED_EVERY === CONTINUED_EVERY - 1 ? CONTINUATIONS : 0 },
      () => ({ runId: randomUUID(), contextId: randomUUID() })),
    contextId: randomUUID(),
  }));
  const insert = async <Row>(rows: Row[], write: (chunk: Row[]) => Promise<unknown>) => {
    for (let start = 0; start < rows.length; start += 500) await write(rows.slice(start, start + 500));
  };
  await sql.begin(async tx => {
    // Skip the work-assessment owner chain of the status decisions.
    await tx.unsafe("set local session_replication_role = replica");
    await tx.unsafe(`insert into issues (id, company_id, title, status, assignee_agent_id, issue_number, identifier, last_status_decision_id)
      select w.issue_id, $1::uuid, 'wait ' || w.n, 'in_review', $2::uuid, w.n, 'SYN-' || w.n, w.decision_id
      from unnest($3::uuid[], $4::uuid[]) with ordinality as w(issue_id, decision_id, n)`,
    [companyId, agentId, waits.map(wait => wait.issueId), waits.map(wait => wait.decisionId)]);
    await tx.unsafe(`insert into status_decisions (id, company_id, issue_id, run_id, assessment_id, decision_version, policy_version,
        from_status, to_status, reason_code, decision_json, decision_digest, application_state, applied_at)
      select w.decision_id, $1::uuid, w.issue_id, w.run_id, gen_random_uuid(), 1, 'v1', 'in_progress', 'in_review',
        'external_chat_response_waiting', '{}'::jsonb, w.decision_id::text, 'applied', now()
      from unnest($2::uuid[], $3::uuid[], $4::uuid[]) as w(decision_id, issue_id, run_id)`,
    [companyId, waits.map(wait => wait.decisionId), waits.map(wait => wait.issueId), waits.map(wait => wait.runId)]);
  });
  await insert(waits, chunk => db!.insert(heartbeatRuns).values(chunk.flatMap(wait => [
    { id: wait.runId, companyId, agentId, status: "succeeded", runtimeMode: "native", nativeIssueId: wait.issueId,
      responsibleUserId: user, activeIdentityContextId: wait.contextId, contextSnapshot: { prompt: "x".repeat(4096) } },
    { id: wait.reviewRunId, companyId, agentId, status: "succeeded", nativeIssueId: wait.issueId },
    ...wait.lineage.map(earlier => ({ id: earlier.runId, companyId, agentId, status: "succeeded",
      nativeIssueId: wait.issueId, responsibleUserId: user })),
  ])));
  await insert(waits, chunk => db!.insert(issueComments).values(chunk.map(wait => ({ id: wait.commentId, companyId,
    issueId: wait.issueId, authorType: "user" as const, authorUserId: user, body: "Review" }))));
  await insert(waits, chunk => db!.insert(runIdentityContexts).values(chunk.flatMap(wait => {
    // The lineage from the first run (which accepted the comment) to the waiting run.
    const contexts = [...wait.lineage, { runId: wait.runId, contextId: wait.contextId }];
    return contexts.map((context, index) => ({ id: context.contextId, companyId, runId: context.runId, revision: 1,
      responsibleUserId: user, messageId: index === 0 ? wait.commentId : null,
      parentContextId: index === 0 ? null : contexts[index - 1]!.contextId,
      cause: index === 0 ? "instruction" : "monitor", correlationId: "benchmark", status: "accepted" }));
  })));
  await insert(waits, chunk => db!.insert(chatConversations).values(chunk.map(wait => ({ id: wait.conversationId, companyId,
    endpointId, resourceId, issueId: wait.issueId, externalConversationId: repository,
    externalThreadId: `github:${repository}:${wait.pullNumber}`, externalLabel: "Review", state: "waiting" }))));
  await insert(waits, chunk => db!.insert(chatDeliveries).values(chunk.map(wait => ({ id: wait.deliveryId, companyId,
    endpointId, conversationId: wait.conversationId, principalId, providerEventId: wait.deliveryId,
    deduplicationKey: wait.deliveryId, eventKind: "message" as const, state: "processed" as const, normalizedEvent: {}, processedAt: new Date() }))));
  await insert(waits, chunk => db!.insert(chatMessageLinks).values(chunk.map(wait => ({ companyId, endpointId,
    conversationId: wait.conversationId, deliveryId: wait.deliveryId, commentId: wait.commentId,
    providerMessageId: wait.commentId, direction: "inbound" }))));
  await insert(waits, chunk => db!.insert(chatGitHubReviews).values(chunk.map(wait => ({ id: wait.reviewId, companyId,
    endpointId, issueId: wait.issueId, runId: wait.reviewRunId, repositoryId, repository, pullNumber: wait.pullNumber,
    headSha, deliveryId: wait.reviewId, configurationRevision: 1, state: "completed" as const,
    policySnapshot: defaultGitHubReviewPolicy(),
    event: { event: "mention" as const, deliveryId: wait.reviewId, repositoryId, repository, pullNumber: wait.pullNumber,
      title: "Review", body: "", baseSha: "0".repeat(40), headSha, baseBranch: "main",
      author: { id: "1", login: "author", isBot: false }, sender: { id: "1", login: "author" }, draft: false, labels: [] },
    assessment: { reviewedCommit: headSha, score: 5 as const, complete: true, summary: "Reviewed", rationale: "Reviewed",
      coverage: { reviewedPaths: [], omittedPaths: [], limitations: [] }, findings: [] } }))));
  await insert(waits, chunk => db!.insert(chatActions).values(chunk.map(wait => ({ companyId, endpointId,
    kind: "github_review_publication", status: "processed",
    providerActionId: `github_publication:${wait.issueId}:assessment:${createHash("sha256").update(JSON.stringify(wait.reviewId)).digest("hex")}` }))));
  await sql.unsafe("vacuum analyze");
  const loadMs = performance.now() - loadStart;
  const issueIds = waits.map(wait => wait.issueId);
  const runs = await db.select().from(heartbeatRuns);
  const waitRuns = waits.map(wait => runs.find(run => run.id === wait.runId)!);

  // Both versions return the same waits, and the same inherited wait for each run.
  const listed: Record<string, string[]> = {}, inherited: Record<string, unknown> = {};
  for (const [name, version] of Object.entries(versions)) {
    listed[name] = (await version.list(db, companyId, issueIds)).map(wait => wait.issueId).sort();
    inherited[name] = await version.inherited(db, waitRuns);
  }
  assert.deepEqual(listed.treatment, listed.baseline, "Both versions must return the same waits");
  assert.deepEqual(inherited.treatment, inherited.baseline, "Both versions must return the same inherited waits");
  const published = (inherited.baseline as Array<{ kind?: string } | null>).filter(wait => wait?.kind === "published").length;
  assert.equal(published, WAITS, "Every seeded wait must inherit its published review");

  const round = (value: number) => Number(value.toFixed(2));
  // Statements that one request sends, counted at the driver (prepared
  // templates are counted at each execution).
  const statementCounts = async (list: Versions["list"]) => {
    const client = sql as unknown as { unsafe: (query: string, ...rest: unknown[]) => unknown };
    const original = client.unsafe;
    const counts: Record<string, number> = {};
    let total = 0, sqlBytes = 0;
    const batches: Array<{ query: string; params: unknown }> = [];
    client.unsafe = function (this: unknown, query: string, ...rest: unknown[]) {
      // A batch provenance read selects from the request rows and reads its
      // table in a lateral subquery.
      const batch = /^select .*? from unnest\(.*? cross join lateral \(select .*? from "([a-z_]+)"/s.exec(query)?.[1];
      if (batch) batches.push({ query, params: rest[0] });
      const key = batch ? `provenance batch: ${batch}` : /^select .*? from "([a-z_]+)"/s.exec(query)?.[1] ?? "other";
      counts[key] = (counts[key] ?? 0) + 1;
      total += 1;
      sqlBytes += Buffer.byteLength(query);
      return original.call(this, query, ...rest);
    };
    try { await list(db!, companyId, issueIds); } finally { client.unsafe = original; }
    // Server execution and scans of the batch provenance reads of one request.
    let executionMs = 0;
    const scans = new Set<string>();
    for (const statement of batches) {
      const [row] = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`, statement.params as never[]);
      const [plan] = row!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown>; "Execution Time": number }>;
      executionMs += plan!["Execution Time"];
      const walk = (node: Record<string, unknown>) => {
        if (/Scan/.test(String(node["Node Type"])) && node["Relation Name"]) {
          scans.add(`${node["Node Type"]} ${node["Index Name"] ?? ""} on ${node["Relation Name"]}`.replace("  ", " "));
        }
        for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
      };
      walk(plan!.Plan);
    }
    return { total, sqlTextBytes: sqlBytes, byFirstTable: counts,
      provenanceBatches: { count: batches.length, summedExecutionMs: round(executionMs), scans: [...scans].sort() } };
  };
  const stats = (samples: number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return { median: round(sorted[Math.floor(sorted.length / 2)]!), min: round(sorted[0]!), max: round(sorted.at(-1)!) };
  };
  // Wall time and process CPU time (user and system) of one request.
  const measure = async (list: Versions["list"]) => {
    const cpu = process.cpuUsage(), start = performance.now();
    await list(db!, companyId, issueIds);
    const used = process.cpuUsage(cpu);
    return { wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1_000 };
  };
  for (const version of Object.values(versions)) for (let warm = 0; warm < 3; warm++) await measure(version.list);
  const samples: Record<string, Array<{ wallMs: number; cpuMs: number }>> = { baseline: [], treatment: [] };
  for (let pair = 0; pair < PAIRS; pair++) {
    const order = pair % 2 === 0 ? ["baseline", "treatment"] : ["treatment", "baseline"];
    for (const name of order) samples[name]!.push(await measure(versions[name]!.list));
  }
  const report: Record<string, unknown> = {};
  for (const [name, version] of Object.entries(versions)) {
    report[name] = {
      statements: await statementCounts(version.list),
      wallMs: stats(samples[name]!.map(sample => sample.wallMs)),
      cpuMs: stats(samples[name]!.map(sample => sample.cpuMs)),
    };
  }
  console.log(JSON.stringify({
    baselineRevision, treatmentRevision: git("rev-parse", "HEAD").trim(),
    treatmentDirty: git("status", "--porcelain", "--", ...modules).trim().length > 0,
    postgresVersion: (await sql.unsafe("select version()"))[0]!.version, node: process.version,
    fixture: { synthetic: true, waits: WAITS, continuedEvery: CONTINUED_EVERY, continuations: CONTINUATIONS,
      pool: POOL, pairs: PAIRS, warmups: 3, order: "alternating", loadMs: Math.round(loadMs) },
    correctness: { sameWaits: true, sameInheritedWaits: true, waits: listed.baseline!.length, publishedInheritedWaits: published },
    results: report,
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
