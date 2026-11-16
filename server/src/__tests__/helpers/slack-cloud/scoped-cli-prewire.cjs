// Controlled exact useful-process fixture: host instrumentation, current run token only.
const permitted = new Set([
  "PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME", "LANG", "LC_ALL", "CI", "NODE_ENV", "NODE_OPTIONS",
  "PAPERCLIP_API_URL", "PAPERCLIP_RUN_ID", "PAPERCLIP_AGENT_ID", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_API_KEY",
  "SLACK_FORM_FIXTURE_PEER_ORIGIN", "SLACK_GATE_PROCESS_LOG",
]);
// The approved controller passes empty NODE_OPTIONS and the exact preload as
// explicit argv. Refuse an earlier unreviewed preload instead of keeping its
// possibly already-installed DB/origin authority after environment reduction.
if (process.env.NODE_OPTIONS) throw Error("Unexpected useful-process preload before authority reduction");
for (const key of Object.keys(process.env)) if (!permitted.has(key)) delete process.env[key];
require("./quiet-prewire.cjs");
if (process.env.SLACK_GATE_GUARD_PID !== String(process.pid)) throw Error("Missing actual useful-process guard");
require("node:fs").appendFileSync(process.env.SLACK_GATE_PROCESS_LOG, JSON.stringify({
  phase: process.argv.length === 3 && process.argv[2] === "--version" ? "scoped-useful-version-preload" : "scoped-useful-process-preload", pid: process.pid, ppid: process.ppid,
  argv: process.argv, execArgv: process.execArgv, envNames: Object.keys(process.env).sort(),
}) + "\n");
