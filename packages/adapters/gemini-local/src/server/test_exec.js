const { runAdapterExecutionTargetProcess } = require('@paperclipai/adapter-utils/execution-target');
const { parseGeminiJsonl } = require('./parse.js');

async function test() {
  const probe = await runAdapterExecutionTargetProcess(
    'test',
    null,
    'agy',
    ['--print', 'Respond with hello.'],
    { cwd: process.cwd(), env: process.env, timeoutSec: 60, graceSec: 5, onLog: () => {} }
  );
  console.log('EXIT CODE:', probe.exitCode);
  console.log('STDOUT R:', JSON.stringify(probe.stdout));
  console.log('STDERR R:', JSON.stringify(probe.stderr));
  const parsed = parseGeminiJsonl(probe.stdout);
  console.log('SUMMARY:', JSON.stringify(parsed.summary));
}
test().catch(console.error);
