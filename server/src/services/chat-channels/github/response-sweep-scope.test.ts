import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { registerGitHubAcknowledgementWork } from "./acknowledgement-work.js";
import { registerGitHubTerminalResponseWork } from "./terminal-response-work.js";
import { GITHUB_RESPONSE_COMPANY_RECONSTRUCTION_MS } from "./response-sweep-scope.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

type Task = { run(signal: AbortSignal): Promise<unknown>; onSettled?(hints?: ReadonlySet<string>): void };

suite("GitHub response sweep scopes", () => {
  let db!: Db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  const parkedIssues: string[] = [];
  let clock = Date.now();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-github-response-sweep-scope-");
    db = createDb(temporary.connectionString);
    const client = db.$client;
    const [{ company }] = await client.unsafe(`insert into companies (name, issue_prefix) values ('Sweep', 'SW') returning id as company`);
    companyId = company;
    const [{ agent }] = await client.unsafe(`insert into agents (company_id, name) values ($1, 'GitHub agent') returning id as agent`, [company]);
    const [{ application }] = await client.unsafe(`insert into tool_applications (company_id, application_key, name, type)
      values ($1, 'github', 'GitHub', 'chat') returning id as application`, [company]);
    const [{ connection }] = await client.unsafe(`insert into tool_connections (company_id, application_id, name, uid, transport, connection_purpose)
      values ($1, $2, 'GitHub', 'github-sweep', 'chat_sdk', 'channel') returning id as connection`, [company, application]);
    const [{ endpoint }] = await client.unsafe(`insert into chat_endpoints (company_id, connection_id, provider, public_id, assigned_agent_id, status)
      values ($1, $2, 'github', 'sweep', $3, 'active') returning id as endpoint`, [company, connection, agent]);
    for (let n = 1; n <= 6; n++) {
      const [{ issue }] = await client.unsafe(`insert into issues (company_id, title, status) values ($1, $2, 'in_progress') returning id as issue`,
        [company, `Issue ${n}`]);
      parkedIssues.push(issue);
      const [{ conversation }] = await client.unsafe(`insert into chat_conversations (company_id, endpoint_id, issue_id,
          external_conversation_id, external_label, external_thread_id) values ($1, $2, $3, $4, $4, $4) returning id as conversation`,
      [company, endpoint, issue, `github:paperclipai/paperclip:${n}`]);
      const [{ delivery }] = await client.unsafe(`insert into chat_deliveries (company_id, endpoint_id, provider_event_id, deduplication_key,
          event_kind, normalized_event, conversation_id, state) values ($1, $2, $3, $3, 'message', '{}', $4, 'processed') returning id as delivery`,
      [company, endpoint, `event-${n}`, conversation]);
      const [{ comment }] = await client.unsafe(`insert into issue_comments (company_id, issue_id, body) values ($1, $2, 'Request')
        returning id as comment`, [company, issue]);
      await client.unsafe(`insert into chat_message_links (company_id, endpoint_id, conversation_id, delivery_id, comment_id,
          provider_message_id, direction) values ($1, $2, $3, $4, $5, $6, 'inbound')`,
      [company, endpoint, conversation, delivery, comment, `in-${n}`]);
      await client.unsafe(`insert into chat_actions (company_id, endpoint_id, delivery_id, conversation_id, kind, provider_action_id, status, result)
        values ($1, $2, $3, $4, 'github_response_comment', $5, $6, $7::jsonb)`,
      [company, endpoint, delivery, conversation, `github_response:${delivery}`, n % 2 ? "received" : "processed",
        n % 2 ? null : JSON.stringify({ id: `IC_${n}`, final: false })]);
      await client.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, runtime_mode, scope_kind, issue_id, native_issue_id,
          context_snapshot, finished_at) values ($1, $2, 'succeeded', 'native', 'issue', $3, $3, $4::jsonb, now())`,
      [company, agent, issue, JSON.stringify({ issueId: issue, wakeCommentId: comment })]);
    }
  }, 120_000);

  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  function sweeps() {
    let reads = 0;
    const counted = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const selection = from(...args), execute = selection.execute.bind(selection);
          selection.execute = (async () => {
            if (selection.toSQL().sql.includes(`'wakeCommentIds', '[]'::jsonb) ?`)) reads += 1;
            return execute();
          }) as typeof selection.execute;
          return selection;
        }) as typeof builder.from;
        return builder;
      };
    } }) as Db;
    const tasks: Task[] = [];
    const coordinator = { register: (_queue: unknown, task: Task) => { tasks.push(task); return { wake() {}, stop: async () => {} }; } };
    const acknowledge = vi.fn(async () => undefined);
    registerGitHubAcknowledgementWork(counted, coordinator as never, acknowledge, () => true);
    registerGitHubTerminalResponseWork(counted, coordinator as never, acknowledge, () => true);
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const pass = async (hint?: string) => {
      clock += 2_000;
      const before = reads;
      for (const task of tasks) {
        if (hint) task.onSettled?.(new Set([hint]));
        await task.run(new AbortController().signal);
      }
      return reads - before;
    };
    return { pass, acknowledge };
  }

  it("rebuilds parked requests once per interval for company-wide hints", async () => {
    const { pass, acknowledge } = sweeps();
    expect(await pass()).toBe(parkedIssues.length);
    const companyHint = JSON.stringify({ companyId });
    const repeated = [];
    for (let index = 0; index < 5; index++) repeated.push(await pass(companyHint));
    expect(repeated).toEqual([parkedIssues.length, 0, 0, 0, 0]);
    clock += GITHUB_RESPONSE_COMPANY_RECONSTRUCTION_MS;
    expect(await pass()).toBe(parkedIssues.length);
    expect(acknowledge).not.toHaveBeenCalled();
  }, 60_000);

  it("still rebuilds an issue, request or other company immediately", async () => {
    const { pass } = sweeps();
    await pass();
    await pass(JSON.stringify({ companyId }));
    expect(await pass(JSON.stringify({ companyId, issueId: parkedIssues[0] }))).toBe(1);
    expect(await pass(JSON.stringify({ companyId, issueId: parkedIssues[1] }))).toBe(1);
    expect(await pass(JSON.stringify({ companyId, issueId: parkedIssues[0] }))).toBe(1);
    expect(await pass(JSON.stringify({ companyId: randomUUID() }))).toBe(0);
  }, 60_000);
});
