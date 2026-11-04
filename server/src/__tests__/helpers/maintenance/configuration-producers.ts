import type { createDb } from '@paperclipai/db';
import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { startMaintenanceServer } from './server-harness.js';

/** Real routes own request creation, human rejection, run cancellation and outbox retirement. */
export async function produceCompletedToolReview(server: Awaited<ReturnType<typeof startMaintenanceServer>>, db: ReturnType<typeof createDb>, companyId: string) {
  await server.api('POST', `/companies/${companyId}/tools/policies`, { name: 'Review harmless qualification writes', policyType: 'require_approval', selectors: { toolName: 'mcp-remote-fixture:update_note' } });
  const readyPath = path.join(server.directory, `tool-review-ready-${randomUUID()}`);
  const readyProgram = `const fs=require('node:fs');const marker=${JSON.stringify(readyPath)};fs.writeFileSync(marker+'.pending',process.env.PAPERCLIP_RUN_ID,{flag:'wx'});fs.renameSync(marker+'.pending',marker);setTimeout(()=>process.exit(0),60000)`;
  const agent = await server.api<{ id: string }>('POST', `/companies/${companyId}/agents`, { name: 'Owned tool review process', role: 'general', adapterType: 'process',
    adapterConfig: { command: process.execPath, args: ['-e', readyProgram], cwd: server.directory }, runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } } });
  const issue = await server.api<{ id: string }>('POST', `/companies/${companyId}/issues`, { title: 'Harmless tool review history', status: 'todo', assigneeAgentId: agent.id });
  let runId: string | undefined;
  await expect.poll(async () => {
    const [run] = await db.$client`select id,status from heartbeat_runs where issue_id=${issue.id} order by created_at desc limit 1`;
    runId = run?.id;
    if (run?.status !== 'running') return false;
    // The process runs only after its awaited adapter.invoke write can commit
    // behind the final dispatch gate's run lock. Status alone precedes setup.
    try { return await readFile(readyPath, 'utf8') === run.id; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }, { timeout: 30_000 }).toBe(true);
  const readiness = { runId, marker: path.basename(readyPath), observedAt: new Date().toISOString(), source: 'actual-process-run-id-marker' };
  await writeFile(path.join(server.directory, 'sleep-tool-review-readiness.json'), JSON.stringify(readiness, null, 2));
  const session = await server.api<{ sessionId: string; token: string }>('POST', '/tool-gateway/sessions', { companyId, agentId: agent.id, runId, issueId: issue.id });
  const call = await fetch(`http://127.0.0.1:${server.port}/api/tool-gateway/tools/call`, { method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', 'x-paperclip-tool-gateway-token': session.token },
    body: JSON.stringify({ tool: 'mcp-remote-fixture:update_note', parameters: { noteId: 'qualification', body: 'Harmless denied operation' } }) });
  expect(call.ok).toBe(false);
  expect(JSON.stringify(await call.json())).toContain('approval_required');
  const [request] = await db.$client`select id,status from tool_action_requests where issue_id=${issue.id}`;
  expect(request.status).toBe('pending');
  await server.api('POST', `/tool-gateway/action-requests/${request.id}/decline`, { companyId, reason: 'Qualification declines the harmless write' });
  await server.api('PATCH', `/issues/${issue.id}`, { status: 'done' });
  await expect.poll(async () => {
    const [run] = await db.$client`select status from heartbeat_runs where id=${runId!}`;
    return ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run?.status);
  }, { timeout: 75_000 }).toBe(true);
  await expect.poll(async () => {
    const [delivery] = await db.$client`select delivered_at is not null as delivered from tool_action_deliveries where action_request_id=${request.id}`;
    return delivery?.delivered;
  }, { timeout: 30_000 }).toBe(true);
  await server.api('POST', `/tool-gateway/sessions/${session.sessionId}/revoke`, { companyId });
  return { requestId: request.id, issueId: issue.id, runId, readiness, boundary: 'Actual request/rejection/session revocation and closed-task retirement; no provider write executed' };
}
