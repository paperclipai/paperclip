import { test, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { listenOnFetchAllowedPort } from '../fetch-allowed-port';

// Each attempt starts the source CLI's test-drive without --data-dir. The model
// and MCP provider are deterministic fixtures; authorization/cards/wakes are real.
for (const journey of ['connect', 'decline', 'restart'] as const) test(`fresh native runner connection journey: ${journey}`, async ({ page }, info) => {
  const root = resolve(import.meta.dirname, '../../..');
  let processHandle: ChildProcess | undefined;
  let logs = '';
  let diagnosticState = async () => ({});
  const calls: string[] = [];
  const fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
    const message = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    calls.push(message.method);
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'heliotrope', version: '1' } }
      : message.method === 'tools/list' ? { tools: [{ name: 'archive_read', description: 'Read heliotrope launch decisions', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
      : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'HELIOTROPE-42: Launch in two stages; support handoff belongs to Mira. Source: https://example.invalid/launch/heliotrope-42' }] } : {};
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  try {
    const port = await listenOnFetchAllowedPort(fixture);
    const env = { ...process.env, IN_FEED_FIXTURE_KEY: 'not-a-real-model-key', NODE_ENV: 'test', PAPERCLIP_TEST_CONNECTION_DELIVERY_HOLD: journey === 'restart' ? '1' : '0', PATH: `${root}/tests/e2e/fixtures/in-feed-bin:${process.env.PATH}` };
    delete env.DATABASE_URL; delete env.DATABASE_MIGRATION_URL;
    processHandle = spawn(process.execPath, ['cli/node_modules/tsx/dist/cli.mjs', 'cli/src/index.ts', 'test-drive', '--harness', 'codex', '--api-key-env', 'IN_FEED_FIXTURE_KEY', '--company-name', 'In-feed native fixture', '--no-browser'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    processHandle.stdout!.on('data', (chunk) => { logs += chunk.toString(); });
    processHandle.stderr!.on('data', (chunk) => { logs += chunk.toString(); });
    await expect.poll(() => logs.match(/Paperclip is ready at (http:\/\/127\.0\.0\.1:\d+)/)?.[1], { timeout: 100_000 }).toBeTruthy();
    let base = logs.match(/Paperclip is ready at (http:\/\/127\.0\.0\.1:\d+)/)![1]!;
    const api = async (path: string, method = 'GET', data?: unknown) => {
      const response = await page.request.fetch(`${base}/api${path}`, { method, data });
      expect(response.ok(), await response.text()).toBeTruthy(); return response.json();
    };
    const isSettledRun = (run: { status: string; errorCode?: string }) => run.status === 'succeeded'
      || (run.status === 'cancelled' && run.errorCode === 'issue_not_in_progress');
    const health = await api('/health');
    expect(health).toMatchObject({ status: 'ok', deploymentMode: 'local_trusted', bootstrapStatus: 'ready', serverInfo: { git: { branchName: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim() } } });
    const [company] = await api('/companies');
    const [agent] = await api(`/companies/${company.id}/agents`);
    expect(agent.adapterType).toBe('codex_local');
    expect(await api(`/companies/${company.id}/issues`)).toEqual([]);
    expect(await api(`/companies/${company.id}/heartbeat-runs`)).toEqual([]);
    expect((await api(`/companies/${company.id}/tools/connections`)).connections).toEqual([]);
    diagnosticState = async () => ({ base, companyId: company.id, agentId: agent.id,
      tasks: (await api(`/companies/${company.id}/issues`)).map((task: Record<string, unknown>) => ({ id: task.id, status: task.status, assigneeAgentId: task.assigneeAgentId })),
      runs: (await api(`/companies/${company.id}/heartbeat-runs`)).map((run: Record<string, unknown>) => ({ id: run.id, status: run.status, runtimeMode: run.runtimeMode, error: run.error, errorCode: run.errorCode })),
    });
    const dataDir = logs.match(/Data directory: ([^\n\r]+)/)![1]!.replace(/\u001b\[[0-9;]*m/g, '').trim();
    const prefix = `/${company.issuePrefix}`;
    await page.goto(base + prefix + '/dashboard');
    await expect(page.getByText('No runs yet').first()).toBeVisible();
    await page.goto(base + prefix + '/company/settings/instance/experimental');
    await page.getByRole('switch', { name: 'Toggle Paperclip Runner experimental setting' }).click();
    await expect.poll(async () => (await api('/instance/settings/experimental')).enableNativeRunner).toBe(true);
    await page.goto(base + prefix + `/agents/${agent.id}/configuration`);
    await page.getByRole('button', { name: 'Codex', exact: true }).click();
    await page.getByRole('button', { name: /Paperclip Runner/ }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await expect.poll(async () => (await api(`/agents/${agent.id}`)).adapterType).toBe('paperclip_runner');
    const nativeAgent = await api(`/agents/${agent.id}`);
    expect(nativeAgent.adapterConfig.env).toEqual(agent.adapterConfig.env);
    const holder = await api(`/companies/${company.id}/agents`, 'POST', { name: 'Archive holder', role: 'qa', adapterType: 'process', adapterConfig: { command: process.execPath, args: ['-e', 'process.exit(0)'] } });
    await page.goto(base + prefix + '/apps');
    const custom = page.getByRole('list', { name: 'Connector list' }).getByRole('listitem').filter({ hasText: 'Connect your own tool' });
    await custom.getByRole('button', { name: 'Connect', exact: true }).click();
    await custom.getByRole('button', { name: 'Connect your own MCP server' }).click();
    await page.getByPlaceholder('https://example.com/actions').fill(`http://127.0.0.1:${port}/`);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('radio', { name: 'Just agents I pick' }).click();
    await page.getByRole('button', { name: /Select agents/ }).click();
    await page.getByRole('checkbox', { name: /Archive holder/ }).check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await page.getByRole('button', { name: /Check link/i }).click();
    await expect(page.getByRole('heading', { name: /is ready/i })).toBeVisible({ timeout: 30_000 });
    const [connection] = (await api(`/companies/${company.id}/tools/connections`)).connections;
    const installs = (await api(`/tool-connections/${connection.id}/installs`)).installs;
    expect(installs).toEqual([expect.objectContaining({ targetId: holder.id })]);
    await page.getByRole('link', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'New Task', exact: true }).last().click();
    await page.getByPlaceholder('Task title').fill('Find the heliotrope launch notes and summarize the decisions with a source link');
    await page.getByRole('button', { name: 'Assignee', exact: true }).click();
    await page.getByRole('button', { name: 'CEO', exact: true }).click();
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    await page.getByRole('complementary').getByRole('link', { name: /Find the heliotrope launch notes/ }).click();
    await expect(page).toHaveURL(/issues\/(?:[a-f0-9-]+|INF-\d+)/);
    await expect(page.getByText(/CEO needs/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('connection-intent-focus-target')).toHaveCount(1);
    await expect.poll(async () => (await api(`/companies/${company.id}/heartbeat-runs`)).every((run: { status: string }) => run.status === 'succeeded'), { timeout: 60_000 }).toBe(true);
    await page.screenshot({ path: info.outputPath('pending-card.png'), fullPage: true });
    const composer = page.getByRole('textbox').last();
    await composer.fill('While I connect, organize the checklist.');
    await expect(composer).toBeEditable();
    if (journey === 'connect') await page.getByRole('button', { name: 'Send', exact: true }).click();
    else await composer.fill('');
    await expect(page.getByTestId('connection-intent-focus-target')).toHaveCount(1);
    if (journey === 'decline') {
      await page.getByRole('button', { name: 'Not now', exact: true }).click();
      await expect(page.getByText('Connection declined', { exact: true })).toBeVisible();
      await expect(page.getByText(/I will use the information already in this task/).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('connection-intent-focus-target')).toHaveCount(1);
      expect(calls.filter((method) => method === 'tools/call')).toHaveLength(0);
      await expect.poll(async () => (await api(`/companies/${company.id}/heartbeat-runs`)).every((run: { status: string }) => run.status === 'succeeded'), { timeout: 60_000 }).toBe(true);
      const runs = await Promise.all((await api(`/companies/${company.id}/heartbeat-runs`)).map((run: { id: string }) => api(`/heartbeat-runs/${run.id}`)));
      expect(runs.every((run: { runtimeMode: string }) => run.runtimeMode === 'native')).toBe(true);
      await writeFile(info.outputPath('instance-and-runs.json'), JSON.stringify({ base, dataDir, health, journey, companyId: company.id, agentId: agent.id,
        connectionId: connection.id, dependency: 'fixture', provider: 'codex', fixtureModel: 'in-feed-fixture',
        runs: runs.map((run: Record<string, unknown>) => ({ id: run.id, status: run.status, runtimeMode: run.runtimeMode })) }, null, 2));
      await page.screenshot({ path: info.outputPath('declined-continuation.png'), fullPage: true });
      return;
    }
    await page.getByRole('button', { name: /Connect \/ Use existing/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ path: info.outputPath('setup-dialog.png'), fullPage: true });
    await page.getByRole('button', { name: new RegExp(connection.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
    await expect(page.getByText(`${connection.name} connected`, { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('connection-intent-focus-target').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('connected-card.png'), fullPage: true });
    if (journey === 'restart') {
      expect(calls.filter((method) => method === 'tools/call')).toHaveLength(0);
      await writeFile(info.outputPath('before-restart.log'), logs);
      const exit = new Promise<void>((done) => processHandle!.once('exit', () => done()));
      process.kill(-processHandle!.pid!, 'SIGTERM'); await exit;
      logs = '';
      processHandle = spawn(process.execPath, ['cli/node_modules/tsx/dist/cli.mjs', 'cli/src/index.ts', 'test-drive', '--harness', 'codex', '--api-key-env', 'IN_FEED_FIXTURE_KEY', '--data-dir', dataDir, '--no-browser'], { cwd: root, env: { ...env, PAPERCLIP_TEST_CONNECTION_DELIVERY_HOLD: '0' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      processHandle.stdout!.on('data', (chunk) => { logs += chunk.toString(); });
      processHandle.stderr!.on('data', (chunk) => { logs += chunk.toString(); });
      await expect.poll(() => logs.match(/Paperclip is ready at (http:\/\/127\.0\.0\.1:\d+)/)?.[1], { timeout: 100_000 }).toBeTruthy();
      base = logs.match(/Paperclip is ready at (http:\/\/127\.0\.0\.1:\d+)/)![1]!;
      expect((await api('/companies'))[0].id).toBe(company.id);
      const taskId = (await api(`/companies/${company.id}/issues`))[0].id;
      await page.goto(base + prefix + '/issues/' + taskId);
    }
    await expect(page.getByText(/HELIOTROPE-42: Launch in two stages/).first()).toBeVisible({ timeout: 60_000 });
    expect(calls.filter((method) => method === 'tools/call')).toHaveLength(1);
    await expect.poll(async () => (await api(`/companies/${company.id}/heartbeat-runs`)).every(isSettledRun), { timeout: 60_000 }).toBe(true);
    await expect(page.getByText(/HELIOTROPE-42: Launch in two stages/).first()).toBeVisible();
    await expect(async () => { await page.getByText(/HELIOTROPE-42: Launch in two stages/).first().scrollIntoViewIfNeeded(); }).toPass({ timeout: 10_000 });
    const runs = await Promise.all((await api(`/companies/${company.id}/heartbeat-runs`)).map((run: { id: string }) => api(`/heartbeat-runs/${run.id}`)));
    expect(runs.filter((run: { status: string }) => run.status === 'succeeded').length).toBeGreaterThanOrEqual(2);
    if (runs.some((run: { status: string }) => run.status === 'cancelled')) {
      // Independent work may consume the new access before the queued outcome
      // runs. Closing the task must cancel that redundant wake, not reopen it.
      expect((await api(`/companies/${company.id}/issues`))[0].status).toBe('done');
    }
    expect(runs.filter((run: { status: string }) => run.status === 'succeeded').every((run: { runtimeMode: string }) => run.runtimeMode === 'native')).toBe(true);
    await expect(page.getByText('The runner returned no user-facing response.', { exact: true })).not.toBeVisible();
    await page.screenshot({ path: info.outputPath('connected-answer.png'), fullPage: true });
    await page.reload();
    await expect(page.getByText(/HELIOTROPE-42: Launch in two stages/).first()).toBeVisible();
    if (journey === 'connect') {
      await page.getByRole('textbox').last().fill('What is the support handoff decision in the archive?');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => calls.filter((method) => method === 'tools/call').length, { timeout: 60_000 }).toBe(2);
      await expect(page.getByTestId('connection-intent-focus-target')).toHaveCount(1);
      await expect.poll(async () => (await api(`/companies/${company.id}/heartbeat-runs`)).every(isSettledRun), { timeout: 60_000 }).toBe(true);
    }
    const finalRuns = await Promise.all((await api(`/companies/${company.id}/heartbeat-runs`)).map((run: { id: string }) => api(`/heartbeat-runs/${run.id}`)));
    expect(finalRuns.filter((run: { status: string }) => run.status === 'succeeded').every((run: { runtimeMode: string }) => run.runtimeMode === 'native')).toBe(true);
    const evidence = JSON.stringify({ base, dataDir, health, journey, companyId: company.id, agentId: agent.id, connectionId: connection.id, runs: finalRuns.map((r: Record<string, unknown>) => ({ id: r.id, runtimeMode: r.runtimeMode, status: r.status })), dependency: 'fixture', provider: 'codex', fixtureModel: 'in-feed-fixture' }, null, 2);
    await writeFile(info.outputPath('instance-and-runs.json'), evidence);
    await info.attach('instance-and-runs', { body: evidence, contentType: 'application/json' });
  } finally {
    await writeFile(info.outputPath('diagnostics.json'), JSON.stringify(await diagnosticState().catch(() => ({})), null, 2));
    await writeFile(info.outputPath('test-drive.log'), logs);
    if (processHandle?.pid) { try { process.kill(-processHandle.pid, 'SIGTERM'); } catch {} }
    fixture.closeAllConnections();
    await new Promise<void>((done) => fixture.close(() => done()));
  }
});
