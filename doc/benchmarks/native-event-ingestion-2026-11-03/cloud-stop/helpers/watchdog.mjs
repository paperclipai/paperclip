import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository, ledgerPath, outputPath] = process.argv.slice(2);
process.once('message', async ({ key, deadlineAt }) => {
  const require = createRequire(join(repository, 'packages/plugins/sandbox-providers/daytona/package.json'));
  const { Daytona } = await import(pathToFileURL(require.resolve('@daytonaio/sdk')).href);
  const client = new Daytona({ apiKey: key, apiUrl: 'https://app.daytona.io/api' });
  let done = false;
  process.on('message', value => { if (value === 'disarm') { done = true; process.exit(0); } });
  process.send({ armed: true, deadlineAt });
  setTimeout(async () => {
    if (done) return;
    const results = [];
    let ledger;
    try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')); } catch { ledger = { resources: [] }; }
    for (const row of ledger.resources) {
      try {
        const sandbox = await client.get(row.providerLeaseId);
        const owned = Object.entries(row.expectedLabels).every(([key, value]) => sandbox.labels?.[key] === value);
        if (!owned) { results.push({ id: row.providerLeaseId, status: 'ownership_mismatch' }); continue; }
        await client.delete(sandbox, 90);
        results.push({ id: row.providerLeaseId, status: 'deleted' });
      } catch (error) { results.push({ id: row.providerLeaseId, status: Number(error?.status ?? error?.response?.status) === 404 ? 'already_absent' : 'cleanup_failed' }); }
    }
    await writeFile(outputPath, JSON.stringify({ firedAt: new Date().toISOString(), results }, null, 2));
    process.exit(results.some(row => row.status === 'cleanup_failed' || row.status === 'ownership_mismatch') ? 1 : 0);
  }, Math.max(1, deadlineAt - Date.now()));
});
