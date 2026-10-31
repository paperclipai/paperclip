import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicContext, testopsClient, inspectChatMetadata, ensureChatPlan, validateChatSelection, bootstrapJobMetadata, launchChatPlan, admitLaunchPlan, verifyChatUpload, failureProjection } from './chat-feature-testops-api.mjs';
import { exportChatAllure, readBoundChatExport, ExportFailure } from './chat-feature-testops-results.mjs';

export async function run(env = process.env, fetchImpl = fetch) {
  let stage = 'context', stateRoot;
  try {
    const expected = publicContext(env), operation = env.CHAT_TESTOPS_OPERATION;
    if (!['bootstrap', 'launch-plan', 'validate-selection', 'export', 'verify-upload'].includes(operation)) throw new Error('unknown_operation');
    if (operation === 'bootstrap' || operation === 'launch-plan') {
      const eventPath = env.GITHUB_EVENT_PATH;
      if (!eventPath) throw new Error('bootstrap_original_event_missing');
      const stat = await lstat(eventPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new Error('bootstrap_original_event_invalid');
      const event = JSON.parse(await readFile(eventPath, 'utf8'));
      if (event.inputs?.operation !== operation || (event.inputs?.ALLURE_JOB_RUN_ID ?? '') !== '') throw new Error('bootstrap_cannot_run_from_testops');
    }
    stage = 'output_admission';
    const requested = env.CHAT_TESTOPS_STATE_ROOT;
    if (!env.RUNNER_TEMP || !requested || !path.isAbsolute(requested)
      || path.dirname(path.resolve(requested)) !== path.resolve(env.RUNNER_TEMP)) throw new Error('invalid_output');
    await mkdir(requested, { mode: 0o700 }); stateRoot = requested;
    let result;
    if (operation === 'export' || operation === 'verify-upload') {
      stage = 'result_export';
      const selectionPath = env.CHAT_TESTOPS_SELECTION;
      if (!selectionPath || !path.isAbsolute(selectionPath) || !selectionPath.startsWith(`${path.resolve(env.RUNNER_TEMP)}${path.sep}`)) throw new Error('invalid_selection_path');
      const stat = await lstat(selectionPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('invalid_selection_file');
      const selected = JSON.parse(await readFile(selectionPath, 'utf8'));
      if (operation === 'verify-upload') {
        stage = 'upload_verification';
        const receiptRoot = path.join(env.RUNNER_TEMP, 'chat-testops-upload-state');
        const rootStat = await lstat(receiptRoot), file = path.join(receiptRoot, 'export.json');
        const receiptStat = await lstat(file);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !receiptStat.isFile() || receiptStat.isSymbolicLink()
          || receiptStat.nlink !== 1 || receiptStat.size > 16_384) throw new Error('invalid_export_receipt');
        const exported = JSON.parse(await readFile(file, 'utf8'));
        const bound = await readBoundChatExport(env.CHAT_TESTOPS_EXPORT_ROOT, expected);
        if (exported.status !== (bound.result.status === 'passed' && bound.result.cleanup === 'passed' ? 'passed' : 'failed')
          || exported.cleanup !== bound.result.cleanup) throw new Error('export_verdict_mismatch');
        const api = await testopsClient(env.ALLURE_TOKEN, fetchImpl);
        result = await verifyChatUpload(api, env, selected, exported);
        await writeFile(path.join(stateRoot, 'verification.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
      } else {
        result = await exportChatAllure({ root: env.CHAT_TESTOPS_EXPORT_ROOT, output: env.ALLURE_RESULTS, expected, selected });
        await writeFile(path.join(stateRoot, 'export.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
      }
    } else {
      let launchAdmission;
      if (operation === 'launch-plan') { stage = 'launch_admission'; launchAdmission = await admitLaunchPlan(env, fetchImpl); }
      stage = 'authentication';
      const api = await testopsClient(env.ALLURE_TOKEN, fetchImpl);
      if (operation === 'launch-plan') {
        stage = 'launch_preflight';
        result = await launchChatPlan(api, env, async identity => {
          const handle = await open(path.join(stateRoot, 'once.json'), 'wx', 0o600);
          await handle.writeFile(JSON.stringify({ ...identity, status: 'STARTED_NO_AUTOMATIC_RESEND' }));
          await handle.close(); stage = 'plan_launch';
        }, launchAdmission);
        await writeFile(path.join(stateRoot, 'launch.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
      } else if (operation === 'validate-selection') {
        stage = 'selection_validation';
        result = await validateChatSelection(api, env);
        await writeFile(path.join(stateRoot, 'selection.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
      } else {
        stage = 'metadata_inspection';
        const inspected = await inspectChatMetadata(api);
        await writeFile(path.join(stateRoot, 'metadata.json'), JSON.stringify(inspected, null, 2), { flag: 'wx', mode: 0o600 });
        let marked = false;
        const once = async () => {
          if (marked) return;
          const handle = await open(path.join(stateRoot, 'once.json'), 'wx', 0o600);
          await handle.writeFile(JSON.stringify({ ...expected, operation: 'plan_bootstrap', status: 'STARTED_NO_AUTOMATIC_RESEND' }));
          await handle.close(); marked = true;
        };
        stage = 'plan_bootstrap';
        result = await ensureChatPlan(api, inspected, once);
        await writeFile(path.join(stateRoot, 'plan.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
        stage = 'bootstrap_job_metadata';
        const job = await bootstrapJobMetadata(api, env);
        await writeFile(path.join(stateRoot, 'job.json'), JSON.stringify(job, null, 2), { flag: 'wx', mode: 0o600 });
      }
    }
    return operation === 'export' && result.status !== 'passed' || operation === 'launch-plan' && result.status !== 'REQUESTED' ? 1 : 0;
  } catch (error) {
    const safe = failureProjection(error, stage);
    if (error instanceof ExportFailure) safe.code = 'chat_testops_export_rejected';
    if (stateRoot) await writeFile(path.join(stateRoot, 'failure.json'), JSON.stringify(safe, null, 2), { flag: 'wx', mode: 0o600 }).catch(() => {});
    process.stderr.write(`Chat TestOps stopped: ${JSON.stringify(safe)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(code => { process.exitCode = code; }).catch(() => { process.stderr.write('Chat TestOps stopped: unknown failure\n'); process.exitCode = 1; });
}
