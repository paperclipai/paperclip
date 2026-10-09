import { expect, test } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function stopTestDrive(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  const signal = (name: NodeJS.Signals) => {
    try { process.kill(-child.pid!, name); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const waitForExit = (timeoutMs: number) => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise<boolean>((done) => {
      const exited = () => { clearTimeout(timer); done(true); };
      const timer = setTimeout(() => { child.removeListener('exit', exited); done(false); }, timeoutMs);
      child.once('exit', exited);
    });
  };
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = waitForExit(15_000);
  signal('SIGTERM');
  if (await stopped) return;
  const killed = waitForExit(5_000);
  signal('SIGKILL');
  if (!(await killed)) throw new Error('test-drive process did not exit after SIGKILL');
}

test('a completion tool does not cut off a delayed final answer', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const root = resolve(import.meta.dirname, '../../..');
  let child: ChildProcess | undefined;
  let logs = '';
  try {
    const env = { ...process.env, STREAM_FIXTURE_KEY: 'not-a-real-model-key', NODE_ENV: 'test',
      PATH: `${root}/tests/e2e/fixtures/completion-stream-bin:${process.env.PATH}` };
    delete env.DATABASE_URL;
    delete env.DATABASE_MIGRATION_URL;
    child = spawn(process.execPath, ['cli/node_modules/tsx/dist/cli.mjs', 'cli/src/index.ts', 'test-drive',
      '--harness', 'codex', '--api-key-env', 'STREAM_FIXTURE_KEY', '--company-name', 'Stream completion', '--no-browser'],
    { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', (chunk) => { logs += chunk.toString(); });
    child.stderr!.on('data', (chunk) => { logs += chunk.toString(); });
    await expect.poll(() => logs.match(/Paperclip is ready at (http:\/\/127\.0\.0\.1:\d+)/)?.[1], { timeout: 100_000 }).toBeTruthy();
    const base = logs.match(/Paperclip is ready at (http:\/\/127\.0\.0\.1:\d+)/)![1]!;
    const api = async (path: string) => {
      const response = await page.request.get(`${base}/api${path}`);
      expect(response.ok(), await response.text()).toBeTruthy();
      return response.json();
    };
    const health = await api('/health');
    expect(health).toMatchObject({ status: 'ok', deploymentMode: 'local_trusted', bootstrapStatus: 'ready',
      serverInfo: { git: { branchName: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim() } } });
    const [company] = await api('/companies');
    const [agent] = await api(`/companies/${company.id}/agents`);
    expect(await api(`/companies/${company.id}/issues`)).toEqual([]);
    expect(await api(`/companies/${company.id}/heartbeat-runs`)).toEqual([]);
    const prefix = `/${company.issuePrefix}`;
    await page.goto(base + prefix + '/dashboard');
    await page.goto(base + prefix + '/company/settings/instance/experimental');
    if (!(await api('/instance/settings/experimental')).enableNativeRunner) {
      await page.getByRole('switch', { name: 'Toggle Paperclip Runner experimental setting' }).click();
    }
    await expect.poll(async () => (await api('/instance/settings/experimental')).enableNativeRunner).toBe(true);
    await page.goto(base + prefix + `/agents/${agent.id}/configuration`);
    await page.getByRole('button', { name: 'Codex', exact: true }).click();
    await page.getByRole('button', { name: /Paperclip Runner/ }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(async () => (await api(`/agents/${agent.id}`)).adapterType).toBe('paperclip_runner');
    await page.getByRole('link', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'New Task', exact: true }).last().click();
    await page.getByPlaceholder('Task title').fill('Summarize the launch decisions and include the source link');
    await page.getByRole('button', { name: 'Assignee', exact: true }).click();
    await page.getByRole('button', { name: 'CEO', exact: true }).click();
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    await expect.poll(async () => (await api(`/companies/${company.id}/issues`)).length).toBe(1);
    const [issue] = await api(`/companies/${company.id}/issues`);
    await page.goto(`${base}${prefix}/issues/${issue.identifier}`);
    await expect.poll(async () => (await api(`/companies/${company.id}/heartbeat-runs`))[0]?.status, { timeout: 60_000 }).toBe('succeeded');
    await expect(page.getByText('STREAM-42: The launch has two stages.', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'https://example.invalid/launch/STREAM-42', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'editable markdown', exact: true })).toBeEditable();
    await page.reload();
    await expect(page.getByText('STREAM-42: The launch has two stages.', { exact: false }).first()).toBeVisible();
    const runs = await api(`/companies/${company.id}/heartbeat-runs`);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded' });
    const run = await api(`/heartbeat-runs/${runs[0].id}`);
    expect(run.runtimeMode).toBe('native');
    expect(run.resultJson.presentationDecision.chosenSource).toBe('final_agent_message');
    const comments = await api(`/issues/${issue.id}/comments`);
    expect(comments.filter((comment: { body: string }) => comment.body.includes('STREAM-42'))).toHaveLength(1);
    await page.screenshot({ path: info.outputPath('delayed-final-answer.png'), fullPage: true });
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ base, health, companyId: company.id, issueId: issue.id,
      runId: run.id, dependency: 'deterministic Codex app-server fixture', delayMs: 31000,
      dataDir: logs.match(/Data directory: ([^\n\r]+)/)?.[1], presentation: run.resultJson.presentationDecision }, null, 2));
  } finally {
    try { await stopTestDrive(child); }
    finally { await writeFile(info.outputPath('test-drive.log'), logs); }
  }
});
