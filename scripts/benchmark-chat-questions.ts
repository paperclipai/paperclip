import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agents, companies, createDb, issues, issueThreadInteractions, startEmbeddedPostgresTestDatabase, applyPendingMigrations } from "../packages/db/src/index.js";
import { conversationDecisionReceiptsService } from "../server/src/services/conversation-decision-receipts.js";
import { attentionService } from "../server/src/services/attention.js";
import { resolveExternalTestDatabaseUrl } from "../server/src/__tests__/helpers/external-test-database.js";
import type { AttentionItem } from "@paperclipai/shared";

const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass the pre-fix --baseline-ref commit");
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const unrelated = Number(process.argv.find(arg => arg.startsWith("--unrelated="))?.slice(12) ?? 1000);
assert.ok(Number.isSafeInteger(unrelated) && unrelated >= 0 && unrelated <= 5000);
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_CHAT_QUESTIONS_TEST_DATABASE_URL");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineDir = path.join(repoRoot, "server/src/services", `.chat-question-baseline-${randomUUID()}`);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
const keepAlive = setInterval(() => {}, 1000);
type Query = { text: string; parameters: unknown[] };
try {
  await fs.mkdir(baselineDir);
  for (const name of ["attention", "conversation-decision-receipts", "decision-queues"]) {
    const source = execFileSync("git", ["show", `${baselineRevision}:server/src/services/${name}.ts`], { encoding: "utf8" })
      .replace(/from "(\.\.?\/[^\"]+)"/g, (_match, ref: string) => {
        if (["./attention.js", "./decision-queues.js"].includes(ref)) return `from "${ref}"`;
        return `from "../${ref}"`;
      });
    await fs.writeFile(path.join(baselineDir, `${name}.ts`), source);
  }
  const baseline = await import(pathToFileURL(path.join(baselineDir, "conversation-decision-receipts.ts")).href);
  const baselineAttention = await import(pathToFileURL(path.join(baselineDir, "attention.ts")).href);
  if (external) await applyPendingMigrations(external);
  else temporary = await startEmbeddedPostgresTestDatabase("chat-questions-");
  db = createDb(external ?? temporary!.connectionString);
  const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), conversationId = randomUUID();
  const userId = "local-board";
  await db.insert(companies).values({ id: companyId, name: "Question benchmark", issuePrefix: companyId.slice(0, 8) });
  await db.insert(agents).values([agentId, otherAgentId].map(id => ({ id, companyId, name: "Fixture", adapterType: "process" })));
  await db.insert(issues).values({ id: conversationId, companyId, title: "Chat", conversationAgentId: agentId,
    conversationUserId: userId, assigneeAgentId: agentId, status: "blocked", responsibleUserId: userId,
    conversationState: "waiting", visibility: "private", privacyRootIssueId: conversationId });
  const tasks = Array.from({ length: unrelated + 2 }, (_, i) => ({ id: randomUUID(), companyId, title: `Task ${i}`,
    createdByUserId: userId, assigneeAgentId: i < 2 ? agentId : otherAgentId, status: "blocked" }));
  const questionIds: string[] = [];
  for (let i = 0; i < tasks.length; i += 100) {
    const batch = tasks.slice(i, i + 100);
    await db.insert(issues).values(batch);
    const rows = batch.map(task => ({ id: randomUUID(), companyId, issueId: task.id, kind: "ask_user_questions",
      createdByAgentId: agentId, title: "Question", payload: { version: 1, questions: [
        { id: "choice", prompt: "Which option?", selectionMode: "single", options: [{ id: "a", label: "A" }] },
      ] }, createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-10-01T00:00:00Z") }));
    await db.insert(issueThreadInteractions).values(rows);
    if (i === 0) questionIds.push(...rows.slice(0, 2).map(row => row.id));
  }
  await db.$client.unsafe("ANALYZE");
  const options = { actor: { type: "board" as const, userId, source: "local_implicit" as const }, userId };
  const variants = {
    baseline: () => baseline.conversationDecisionReceiptsService(db).listPendingQuestions(companyId, conversationId, options),
    candidate: () => conversationDecisionReceiptsService(db!).listPendingQuestions(companyId, conversationId, options),
  };
  const normalize = (items: AttentionItem[]) => items.map(({ rank: _rank, ...item }) => item);
  const expected = normalize(await variants.baseline());
  assert.deepEqual(new Set(expected.map(item => item.subject.id)), new Set(questionIds));
  assert.deepEqual(normalize(await variants.candidate()), expected);
  for (let i = 0; i < 2; i++) for (const invoke of Object.values(variants)) await invoke();
  const samples: { scenario: string; variant: string; pair: number; ms: number; queries: number }[] = [];
  const selections = new Map<string, Query>();
  for (let pair = 0; pair < 5; pair++) {
    for (const variant of pair % 2 ? ["candidate", "baseline"] as const : ["baseline", "candidate"] as const) {
      const queries: Query[] = [];
      db.$client.options.debug = (_connection, text, parameters) => queries.push({ text, parameters });
      const started = performance.now();
      const items = await variants[variant]();
      const ms = performance.now() - started;
      db.$client.options.debug = false;
      assert.deepEqual(normalize(items), expected);
      samples.push({ scenario: "questions", variant, pair, ms, queries: queries.length });
      const selection = queries.find(query => query.text.includes('from "issue_thread_interactions"') && query.text.includes('"payload"'));
      assert.ok(selection);
      selections.set(variant, selection);
    }
  }
  const summaries = {
    baseline: () => baselineAttention.attentionService(db).summary(companyId, options),
    candidate: () => attentionService(db!).summary(companyId, options),
  };
  const summaryWithoutTime = ({ generatedAt: _at, ...value }: Awaited<ReturnType<ReturnType<typeof attentionService>["summary"]>>) => value;
  const expectedSummary = summaryWithoutTime(await summaries.baseline());
  assert.deepEqual(summaryWithoutTime(await summaries.candidate()), expectedSummary);
  for (let pair = 0; pair < 5; pair++) {
    for (const variant of pair % 2 ? ["candidate", "baseline"] as const : ["baseline", "candidate"] as const) {
      let queries = 0;
      db.$client.options.debug = () => { queries++; };
      const started = performance.now();
      const summary = await summaries[variant]();
      const ms = performance.now() - started;
      db.$client.options.debug = false;
      assert.deepEqual(summaryWithoutTime(summary), expectedSummary);
      samples.push({ scenario: "companySummary", variant, pair, ms, queries });
    }
  }
  const plans = {} as Record<string, unknown>;
  for (const [variant, query] of selections) {
    const [plan] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`, query.parameters as never[]);
    plans[variant] = { ...query, plan: plan["QUERY PLAN"] };
  }
  console.log(JSON.stringify({ baselineRevision, treatmentRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    treatmentHasChanges: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
    postgres: (await db.$client.unsafe("select version()"))[0]!.version, unrelatedTasks: unrelated, relevantTasks: 2,
    equality: "All fields and ordering match, except rank is relative to the scoped question list.", samples, plans }, null, 2));
} finally {
  await db?.$client.end({ timeout: 0 });
  await temporary?.cleanup();
  await fs.rm(baselineDir, { recursive: true, force: true });
  clearInterval(keepAlive);
}
