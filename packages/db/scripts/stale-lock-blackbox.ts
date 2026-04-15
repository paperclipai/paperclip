import { randomUUID } from "node:crypto";
import postgres from "postgres";

const baseUrl = (process.env.PAPERCLIP_BASE_URL ?? "http://127.0.0.1:3101").replace(/\/+$/, "");
const databaseUrl = process.env.DATABASE_URL ?? process.env.PAPERCLIP_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("Set DATABASE_URL or PAPERCLIP_DATABASE_URL to the disposable Paperclip database URL.");
}

type Json = Record<string, unknown>;

const sql = postgres(databaseUrl, { max: 1 });
const createdCompanyIds: string[] = [];

function log(message: string, data?: Json) {
  if (data) {
    console.log(`${message}: ${JSON.stringify(data)}`);
    return;
  }
  console.log(message);
}

async function api<T = Json>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${text}`);
  }
  return body as T;
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
  intervalMs = 250,
): Promise<T> {
  const started = Date.now();
  let lastValue: T | null | undefined | false = null;
  while (Date.now() - started < timeoutMs) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`);
}

function processAgentConfig(sleepMs: number) {
  return {
    command: process.execPath,
    args: ["-e", `setTimeout(() => {}, ${sleepMs})`],
  };
}

async function createFixture() {
  const suffix = randomUUID().slice(0, 8);
  const company = await api<{ id: string }>("/api/companies", {
    method: "POST",
    body: JSON.stringify({ name: `Stale Lock QA ${suffix}` }),
  });
  createdCompanyIds.push(company.id);

  const owner = await api<{ id: string }>(`/api/companies/${company.id}/agents`, {
    method: "POST",
    body: JSON.stringify({
      name: `Fixture Owner ${suffix}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: processAgentConfig(2_000),
      runtimeConfig: { heartbeat: { enabled: false } },
    }),
  });

  const contender = await api<{ id: string }>(`/api/companies/${company.id}/agents`, {
    method: "POST",
    body: JSON.stringify({
      name: `Fixture Contender ${suffix}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: processAgentConfig(500),
      runtimeConfig: { heartbeat: { enabled: false } },
    }),
  });

  const staleIssue = await api<{ id: string; identifier: string }>(`/api/companies/${company.id}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: `Terminal stale lock ${suffix}`,
      status: "todo",
      priority: "high",
    }),
  });

  const deferredIssue = await api<{ id: string; identifier: string }>(`/api/companies/${company.id}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: `Deferred promotion ${suffix}`,
      status: "todo",
      priority: "high",
    }),
  });

  const contenderKey = await api<{ token: string }>(`/api/agents/${contender.id}/keys`, {
    method: "POST",
    body: JSON.stringify({ name: "stale-lock-blackbox" }),
  });

  return { company, owner, contender, contenderKey, staleIssue, deferredIssue };
}

async function verifyTerminalStaleCheckout(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const runId = randomUUID();
  const now = new Date();

  await sql.begin(async (tx) => {
    await tx`
      insert into heartbeat_runs (
        id, company_id, agent_id, invocation_source, trigger_detail, status,
        started_at, finished_at, exit_code, context_snapshot, created_at, updated_at
      )
      values (
        ${runId}, ${fixture.company.id}, ${fixture.owner.id}, 'on_demand', 'manual', 'succeeded',
        ${now}, ${now}, 0, ${tx.json({ issueId: fixture.staleIssue.id })}, ${now}, ${now}
      )
    `;

    const rows = await tx`
      update issues i
      set assignee_agent_id = ${fixture.contender.id},
          execution_run_id = ${runId},
          execution_agent_name_key = 'fixture-owner',
          execution_locked_at = ${now},
          updated_at = ${now}
      where i.id = ${fixture.staleIssue.id}
        and i.company_id = ${fixture.company.id}
        and not exists (
          select 1
          from heartbeat_runs live
          where live.id = ${runId}
            and live.status in ('queued', 'running')
        )
      returning i.id
    `;
    if (rows.count !== 1) {
      throw new Error("Guarded stale-lock fixture update did not affect exactly one row.");
    }
  });

  const inbox = await api<Array<{ id: string; activeRun: unknown }>>("/api/agents/me/inbox-lite", {
    headers: { authorization: `Bearer ${fixture.contenderKey.token}` },
  });
  const inboxIssue = inbox.find((issue) => issue.id === fixture.staleIssue.id);
  if (!inboxIssue) throw new Error("Stale fixture issue was not present in contender inbox-lite.");
  if (inboxIssue.activeRun !== null) {
    throw new Error(`Expected inbox-lite activeRun=null for terminal stale lock; got ${JSON.stringify(inboxIssue.activeRun)}`);
  }

  const checkedOut = await api<{ id: string; status: string; executionRunId: string | null }>(
    `/api/issues/${fixture.staleIssue.id}/checkout`,
    {
      method: "POST",
      body: JSON.stringify({
        agentId: fixture.contender.id,
        expectedStatuses: ["todo", "in_progress", "blocked"],
      }),
    },
  );

  if (checkedOut.executionRunId !== null || checkedOut.status !== "in_progress") {
    throw new Error(`Checkout did not repair terminal stale lock as expected: ${JSON.stringify(checkedOut)}`);
  }

  log("terminal-stale-checkout: pass", {
    issue: fixture.staleIssue.identifier,
    terminalRunId: runId,
    inboxActiveRun: inboxIssue.activeRun,
    checkoutStatus: checkedOut.status,
  });
}

async function verifyDeferredPromotion(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const ownerRun = await api<{ id: string; status: string }>(`/api/agents/${fixture.owner.id}/wakeup`, {
    method: "POST",
    body: JSON.stringify({
      source: "on_demand",
      triggerDetail: "manual",
      reason: "stale-lock-blackbox-owner",
      payload: { issueId: fixture.deferredIssue.id },
    }),
  });

  await waitFor("owner run to own issue execution", async () => {
    const active = await api<{ id: string; status: string } | null>(`/api/issues/${fixture.deferredIssue.id}/active-run`);
    return active?.id === ownerRun.id && active.status === "running" ? active : null;
  });

  await api(`/api/agents/${fixture.contender.id}/wakeup`, {
    method: "POST",
    body: JSON.stringify({
      source: "on_demand",
      triggerDetail: "manual",
      reason: "stale-lock-blackbox-contender",
      payload: { issueId: fixture.deferredIssue.id },
    }),
  });

  await waitFor("deferred wake request", async () => {
    const rows = await sql`
      select id
      from agent_wakeup_requests
      where company_id = ${fixture.company.id}
        and agent_id = ${fixture.contender.id}
        and status = 'deferred_issue_execution'
        and payload ->> 'issueId' = ${fixture.deferredIssue.id}
      limit 1
    `;
    return rows[0] ?? null;
  });

  const promoted = await waitFor("promoted contender run", async () => {
    const rows = await sql`
      select id, status
      from heartbeat_runs
      where company_id = ${fixture.company.id}
        and agent_id = ${fixture.contender.id}
        and context_snapshot ->> 'issueId' = ${fixture.deferredIssue.id}
        and status in ('queued', 'running', 'succeeded')
      order by created_at desc
      limit 1
    `;
    return rows[0] ?? null;
  }, 30_000);

  const ownerFinal = await api<{ id: string; status: string }>(`/api/heartbeat-runs/${ownerRun.id}`);
  if (ownerFinal.status !== "succeeded") {
    throw new Error(`Owner run did not finish successfully: ${JSON.stringify(ownerFinal)}`);
  }

  log("deferred-promotion: pass", {
    issue: fixture.deferredIssue.identifier,
    ownerRunId: ownerRun.id,
    promotedRunId: promoted.id,
    promotedStatus: promoted.status,
  });
}

async function main() {
  log("stale-lock black-box harness starting", { baseUrl });
  await api("/api/health");
  const fixture = await createFixture();
  log("fixture-created", {
    companyId: fixture.company.id,
    ownerAgentId: fixture.owner.id,
    contenderAgentId: fixture.contender.id,
    staleIssue: fixture.staleIssue.identifier,
    deferredIssue: fixture.deferredIssue.identifier,
  });

  try {
    await verifyTerminalStaleCheckout(fixture);
    await verifyDeferredPromotion(fixture);
    log("stale-lock black-box harness complete");
  } finally {
    for (const companyId of createdCompanyIds.reverse()) {
      try {
        await api(`/api/companies/${companyId}`, { method: "DELETE" });
        log("cleanup: deleted disposable company", { companyId });
      } catch (error) {
        console.error(`cleanup warning: failed to delete company ${companyId}:`, error);
      }
    }
    await sql.end({ timeout: 5 });
  }
}

main().catch(async (error) => {
  console.error(error);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exitCode = 1;
});
