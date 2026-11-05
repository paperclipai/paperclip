// Read-only validation of an independently extracted raw attachment; no app/DB/process execution.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertFunctional, PROTOCOL, WORKLOAD_SHA256, registration } from './native-ingestion-blocked-stop-protocol.mjs';
export async function validateFile(file) {
  const bytes = await readFile(file), evidence = JSON.parse(bytes.toString('utf8'));
  const metrics = assertFunctional(evidence);
  return { protocol: PROTOCOL, workloadSha256: WORKLOAD_SHA256, sourceFile: file,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'), sourceRevision: evidence.sourceRevision,
    runId: evidence.runId, metrics, functionalPass: true,
    qualification: 'Functional gate only; owning Playwright, frozen preflight, cleanup and paired noise/comparison campaign remain separately required' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--registration') process.stdout.write(`${JSON.stringify(registration(), null, 2)}\n`);
  else {
    if (!process.argv[2]) throw new Error('Pass extracted raw companion evidence JSON, or --registration');
    const result = await validateFile(process.argv[2]);
    if (process.argv[3]) await writeFile(process.argv[3], `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
