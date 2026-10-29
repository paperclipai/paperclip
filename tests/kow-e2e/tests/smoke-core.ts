import { provision } from "../harness/provision.ts";
import { randomBytes } from "node:crypto";
import { rmSync, existsSync } from "node:fs";
import { ssh, readManifest, procAlive, readProcStartTime, manifestPath, newNonce } from "../harness/lib.ts";

function assert(cond: boolean, label: string, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) process.exitCode = 1;
  return cond;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RUNROOT = "/opt/pkst";

function qemuDead(qemuPid: number, qemuStartTime: number): boolean {
  if (!procAlive(qemuPid)) return true;
  const liveStart = readProcStartTime(qemuPid);
  return !(qemuStartTime > 0 && liveStart !== null && liveStart === qemuStartTime);
}

async function main() {
  const nonce = newNonce();
  try {
    const ctx = await provision(nonce);
    const sx = (cmd: string) => ssh(ctx.port, ctx.keyPath, ctx.knownHosts, "tester", cmd);

    sx(`bash ${ctx.assetDir}/run-agent.sh ${ctx.nonce} '${ctx.placeholder}' ${RUNROOT} POST https://vault-echo.test:8443/echo smoke >/dev/null 2>&1`);

    const fixtureFp = sx(`cat ${RUNROOT}/pub/fixture.fp`).stdout.trim();
    const recvFp = sx(
      `sudo grep -F ${ctx.nonce} ${RUNROOT}/upstream/received.log 2>/dev/null ` +
      `| tail -1 | grep -oE '"token_sha256_12":"[0-9a-f]{12}"' | cut -d'"' -f4`,
    ).stdout.trim();
    assert(/^[0-9a-f]{12}$/.test(recvFp) && recvFp === fixtureFp, "A1 swap-on-the-wire", `recvFp=${recvFp} fixtureFp=${fixtureFp}`);

    const fixLen = parseInt(
      sx(`sudo awk '/TEST_API_KEY:/{print length($2); exit}' ${RUNROOT}/kowd/static-secrets.yaml`).stdout.trim(),
      10,
    );
    assert(fixLen >= 32, "A0 fixture hygiene (>=32 chars)", `len=${fixLen}`);

    const ev = sx(`sudo bash ${ctx.assetDir}/collect-evidence.sh ${ctx.nonce} ${RUNROOT} smoke`);
    assert(ev.code === 0, "A2a evidence collection succeeded", `rc=${ev.code} ${ev.stderr.trim()}`);
    let e: Record<string, unknown> = {};
    try { e = JSON.parse(ev.stdout.trim()); } catch { e = {}; }
    assert(
      e.pid_found === true && e.proc_alive === true && e.result_found === true &&
      typeof e.result_bytes === "number" && e.result_bytes > 0 &&
      e.result_readable === true && e.result_nonce_ok === true &&
      e.agent_identity_ok === true &&
      e.env_readable === true && e.cmdline_readable === true && e.log_readable === true &&
      e.env_hits === 0 && e.cmdline_hits === 0 && e.result_hits === 0 && e.log_hits === 0,
      "A2a no-leak to agent channels + agent identity + result nonce",
      ev.stdout.trim(),
    );

    const au = sx(`sudo bash ${ctx.assetDir}/count-audit.sh ${RUNROOT} TEST_API_KEY vault-echo.test /echo POST`);
    assert(au.code === 0, "A3 audit parse (no malformed lines)", `rc=${au.code} ${au.stdout.trim()} ${au.stderr.trim()}`);
    let a: Record<string, unknown> = {};
    try { a = JSON.parse(au.stdout.trim()); } catch { a = {}; }
    assert(a.matching === 1, "A3 exactly one allowed inject_decision for the binding", au.stdout.trim());
    assert(a.unexpected === 0, "A3 no other allowed inject_decision", au.stdout.trim());

    const a7 = sx(
      `sudo -u agent bash -c 'cat ${RUNROOT}/kowd/static-secrets.yaml >/dev/null 2>&1; echo secret_rc=$?; ` +
      `cat ${RUNROOT}/upstream/received.log >/dev/null 2>&1; echo log_rc=$?'`,
    );
    const a7SecretRc = parseInt((a7.stdout.match(/secret_rc=(\d+)/) || [])[1] ?? "-1", 10);
    const a7LogRc = parseInt((a7.stdout.match(/log_rc=(\d+)/) || [])[1] ?? "-1", 10);
    assert(
      a7SecretRc > 0 && a7LogRc > 0,
      "A7 agent cannot read the credential or raw-header log at rest",
      `secret_rc=${a7SecretRc} log_rc=${a7LogRc} (nonzero=denied required; rc=0 means READABLE=FAIL) raw="${a7.stdout.trim()}"`,
    );

    const nonce5 = "r" + randomBytes(9).toString("hex");
    sx(`bash ${ctx.assetDir}/run-agent.sh ${nonce5} '${ctx.placeholder}' ${RUNROOT} POST https://vault-echo.test:8443/other control >/dev/null 2>&1`);

    const placeholderFp = sx(`printf '%s' '${ctx.placeholder}' | sha256sum | cut -c1-12`).stdout.trim();
    const controlAgg = sx(
      `sudo grep -F ${nonce5} ${RUNROOT}/upstream/received.log 2>/dev/null ` +
      `| awk -v fix='${fixtureFp}' -v ph='${placeholderFp}' ` +
      `'{ total++; fp=""; ` +
      `if (match($0, /"token_sha256_12":"[0-9a-f]*"/)) { s=substr($0, RSTART, RLENGTH); ` +
      `sub(/^"token_sha256_12":"/, "", s); sub(/"$/, "", s); fp=s } ` +
      `if (fp=="") emp++; else if (fp==fix) f++; else if (fp==ph) p++; else o++ } ` +
      `END { printf "%d %d %d %d %d\\n", total+0, f+0, p+0, o+0, emp+0 }'`,
    ).stdout.trim();
    const [a5Total, a5Fixture, a5Placeholder, a5Other, a5Empty] =
      controlAgg.split(/\s+/).map((n) => parseInt(n, 10));
    assert(
      a5Total >= 1 && a5Fixture === 0 && a5Placeholder === a5Total && a5Other === 0 && a5Empty === 0,
      "A5 negative control: EVERY unbound-path line carried placeholder fp (no fixture, no empty/other)",
      `total=${a5Total} fixture=${a5Fixture} placeholder=${a5Placeholder} other=${a5Other} empty=${a5Empty} ` +
        `placeholderFp=${placeholderFp} fixtureFp=${fixtureFp} raw="${controlAgg}"`,
    );

    const au5 = sx(`sudo bash ${ctx.assetDir}/count-audit.sh ${RUNROOT} TEST_API_KEY vault-echo.test /echo POST`);
    assert(au5.code === 0, "A5 audit parse after control (no malformed lines)", `rc=${au5.code} ${au5.stdout.trim()} ${au5.stderr.trim()}`);
    let a5: Record<string, unknown> = {};
    try { a5 = JSON.parse(au5.stdout.trim()); } catch { a5 = {}; }
    assert(a5.matching === 1, "A5 bound-injection count unchanged by control", au5.stdout.trim());
    assert(a5.unexpected === 0, "A5 no allowed inject_decision for the unbound destination", au5.stdout.trim());

    sx(`sudo rm -f ${RUNROOT}/agent/barrier-smoke ${RUNROOT}/agent/barrier-control`);
  } finally {
    const m = readManifest(nonce);
    if (m) {
      const liveStart = readProcStartTime(m.qemuPid);
      const identityMatches = m.qemuStartTime > 0 && liveStart !== null && liveStart === m.qemuStartTime;
      const wasAlive = procAlive(m.qemuPid);
      if (wasAlive && identityMatches) {
        try { process.kill(m.qemuPid, "SIGKILL"); } catch {}
        const deadline = Date.now() + 5000;
        while (!qemuDead(m.qemuPid, m.qemuStartTime) && Date.now() < deadline) { await sleep(100); }
      }
      const dead = qemuDead(m.qemuPid, m.qemuStartTime);
      const problems: string[] = [];
      if (wasAlive && identityMatches && !dead) {
        problems.push(`qemu pid ${m.qemuPid} survived SIGKILL`);
      }
      if (dead) {
        for (const p of [m.overlayPath, m.runDir, manifestPath(nonce)]) {
          try { rmSync(p, { recursive: true, force: true }); } catch {}
          if (existsSync(p)) { problems.push(`cleanup left ${p}`); }
        }
      }
      if (problems.length === 0) {
        console.log(`teardown: guest ${nonce} ${wasAlive && identityMatches ? "killed + swept" : "swept (qemu already gone / pid identity changed)"}`);
      } else {
        console.log(`teardown: guest ${nonce} INCOMPLETE`);
        assert(false, "A6 clean teardown", problems.join("; "));
      }
    } else {
      console.log(`teardown: guest ${nonce} no manifest found`);
    }
  }
}

main().catch((e) => { console.error("smoke-core fatal:", e.message); process.exit(1); });
