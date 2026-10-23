import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const URL_ = process.env.AG_URL;
const METHOD = (process.env.AG_METHOD ?? "POST").toUpperCase();
const PLACEHOLDER = process.env.AG_PLACEHOLDER ?? "";
const NONCE = process.env.AG_NONCE ?? "";
const RESULT = process.env.AG_RESULT ?? "/tmp/agent-result.json";
const AGENTPID = process.env.AG_AGENTPID ?? "";
const BARRIER = process.env.AG_BARRIER ?? "";
const BARRIER_TIMEOUT = parseInt(process.env.AG_BARRIER_TIMEOUT_MS ?? "120000", 10);

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  if (AGENTPID) { writeFileSync(AGENTPID, String(process.pid)); }
  const out = {
    nonce: NONCE, url: URL_, method: METHOD,
    sent_authorization: `Bearer ${PLACEHOLDER}`,
    env_snapshot: { ...process.env },
    proc_self_environ_len: 0,
    verdict: null, error: null,
  };
  try {
    out.proc_self_environ_len = readFileSync("/proc/self/environ").length;
  } catch {}

  const ca = process.env.SSL_CERT_FILE ?? process.env.NODE_EXTRA_CA_CERTS ?? "";
  const args = [
    "-sS", "--max-time", "20", "--cacert", ca,
    "-X", METHOD,
    "-H", `authorization: Bearer ${PLACEHOLDER}`,
    "-H", `x-run-nonce: ${NONCE}`,
  ];
  if (METHOD !== "GET") args.push("-H", "content-type: application/json", "--data", JSON.stringify({ nonce: NONCE }));
  args.push(URL_);
  try {
    const body = execFileSync("curl", args, { encoding: "utf8" });
    out.verdict = JSON.parse(body);
  } catch (e) {
    out.error = String(e && e.stderr ? e.stderr : (e && e.message ? e.message : e));
  }

  writeFileSync(RESULT, JSON.stringify(out, null, 2));
  process.stdout.write(`agent wrote result for nonce=${NONCE}\n`);

  if (BARRIER) {
    const deadline = Date.now() + BARRIER_TIMEOUT;
    while (existsSync(BARRIER) && Date.now() < deadline) {
      await sleep(500);
    }
  }
}

main().catch((e) => { process.stderr.write(`agent fatal: ${e}\n`); process.exit(1); });
