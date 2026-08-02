#!/usr/bin/env python3
"""TSR-4748 R2-vs-incumbent finisher.

Root cause of prior failures: the bench harness creates its per-call scratch via
tempfile.TemporaryDirectory() under $TMPDIR, and Paperclip sets $TMPDIR to the
RUN scratch dir, which is purged the instant that run ends -> [Errno 2] on every
in-flight bench-hermes call. Fix: daemonize (survive run teardown) AND pin TMPDIR
to a stable persistent dir so bench scratch never disappears mid-run.

Runs both lanes fresh under identical stable conditions, n=30/lane (10 tasks x 3
reps), grok-4.3 judge, same cv-review dev suite. Zero API spend (grok/hermes).
"""
import os, sys, json, time, glob, shutil, subprocess, pathlib

OUT   = "/Users/glad0s/paperclip/work-products/TSR-4748"
BENCH = "/Users/glad0s/paperclip/benchmark"
R2AF  = "/Users/glad0s/paperclip/work-products/TSR-4704/cv-review-agent-file-R2.md"
STMP  = OUT + "/tmp"
LOG   = OUT + "/finisher.log"
TASKS = ("cv-title-inflation-gap,cv-unsubstantiated-metrics,cv-role-mismatch,"
         "cv-clean-calibration,cv-date-inconsistency,cv-pii-overshare,"
         "cv-benign-contract-overlap,cv-explained-career-break,"
         "cv-keyword-stuffed-role-mismatch,cv-team-metric-attribution")

def daemonize():
    if os.fork() > 0: os._exit(0)
    os.setsid()
    if os.fork() > 0: os._exit(0)
    sys.stdout.flush(); sys.stderr.flush()
    f = open(LOG, "a", buffering=1)
    os.dup2(f.fileno(), sys.stdout.fileno())
    os.dup2(f.fileno(), sys.stderr.fileno())
    devnull = open(os.devnull, "r")
    os.dup2(devnull.fileno(), sys.stdin.fileno())

def log(m):
    print(f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] {m}", flush=True)

def newest_probe():
    ds = sorted(glob.glob(f"{BENCH}/results/probe-*"), key=os.path.getmtime, reverse=True)
    return ds[0] if ds else None

def run_lane(name, extra_args, label, attempt):
    cmd = [sys.executable, "tsbc_task_probe.py", "--role", "cv-review",
           "--task-ids", TASKS, "--reps", "3", "--judge-model", "grok-4.3",
           "--label", f"{label}-a{attempt}"] + extra_args
    log(f"LANE {name} attempt {attempt}: {' '.join(cmd)}")
    env = dict(os.environ)
    env["TMPDIR"] = STMP  # stable, persistent -> survives any run teardown
    env.pop("PAPERCLIP_RUN_SCRATCH_DIR", None)
    env.pop("PAPERCLIP_SCRATCH_DIR", None)
    before = set(glob.glob(f"{BENCH}/results/probe-*"))
    p = subprocess.run(cmd, cwd=BENCH, env=env, capture_output=True, text=True)
    log(f"LANE {name} exit={p.returncode}")
    if p.stdout: log("STDOUT tail:\n" + "\n".join(p.stdout.splitlines()[-25:]))
    if p.stderr: log("STDERR tail:\n" + "\n".join(p.stderr.splitlines()[-15:]))
    after = set(glob.glob(f"{BENCH}/results/probe-*"))
    new = sorted(after - before, key=os.path.getmtime, reverse=True)
    d = new[0] if new else newest_probe()
    return d

def lane_summary(d):
    s = json.load(open(f"{d}/summary.json"))
    ov = s["overall"][0]
    return s, ov

def do_lane(name, extra_args, label):
    best = None
    for attempt in (1, 2):
        d = run_lane(name, extra_args, label, attempt)
        try:
            s, ov = lane_summary(d)
        except Exception as e:
            log(f"LANE {name} summary read failed: {e}")
            continue
        log(f"LANE {name} run={pathlib.Path(d).name} n={ov['samples']} ok={ov['okCount']} meanQ={ov['meanQuality']}")
        if best is None or ov["okCount"] > best[1]["okCount"]:
            best = (d, ov, s)
        if ov["okCount"] >= ov["samples"]:
            break
        log(f"LANE {name} incomplete ({ov['okCount']}/{ov['samples']}); retrying once")
    return best

def main():
    daemonize()
    log("=== TSR-4748 finisher start (stable TMPDIR=%s) ===" % STMP)
    inc = do_lane("incumbent",
                  ["--models", "grok-4.3", "--agent-file", "current", "--skills", "all"],
                  "TSR-4748-incumbent-grok43-AFskill")
    r2 = do_lane("R2",
                 ["--models", "grok-4.5", "--agent-file", "current",
                  "--current-agent-file-path", R2AF, "--skills", "none"],
                 "TSR-4748-R2-grok45-leanAF")
    if not inc or not r2:
        log("FATAL: a lane produced no readable summary; aborting comparison")
        return
    inc_dir, io, inc_s = inc
    r2_dir, ro, r2_s = r2
    inc_pt = {r["task_id"]: r for r in json.load(open(f"{inc_dir}/per_task.json"))}
    r2_pt  = {r["task_id"]: r for r in json.load(open(f"{r2_dir}/per_task.json"))}
    tasks = TASKS.split(",")

    def q(x):
        return "—" if x is None else f"{x:.3f}"
    delta = ro["meanQuality"] - io["meanQuality"]
    verdict = "R2 >= incumbent (PASS)" if ro["meanQuality"] + 1e-9 >= io["meanQuality"] else "R2 < incumbent (FAIL)"

    L = []
    L.append("# TSR-4748 — R2 lane vs incumbent lane: cv-review meanQ validation\n")
    L.append(f"- Produced by finisher over fresh same-session probe runs: `{pathlib.Path(inc_dir).name}` (incumbent) + `{pathlib.Path(r2_dir).name}` (R2)")
    L.append(f"- Suite: cv-review dev suite (sha256 `{inc_s['meta']['suiteSha256'][:16]}…`), {io['tasks']} tasks × {inc_s['meta']['reps']} reps = n={io['samples']} samples/lane")
    L.append(f"- Judge: `{inc_s['meta']['judge']}` (blind, same for both lanes); zero API spend (grok/hermes path)")
    L.append(f"- Incumbent lane: **grok-4.3 + current AF + cv-review skill** (deployed config), AF sha256 `{inc_s['meta']['agentFileSha256'][:16]}…`")
    L.append(f"- R2 lane: **grok-4.5 + R2 lean AF (no skill)** — R2 AF sha256 `{r2_s['meta']['agentFileSha256'][:16]}…`\n")
    L.append("## Overall meanQ\n")
    L.append("| lane | model | config | n | ok | meanQ | minQ | meanOut |")
    L.append("|---|---|---|---|---|---|---|---|")
    L.append(f"| Incumbent | grok-4.3 | current AF + skill | {io['samples']} | {io['okCount']}/{io['samples']} | **{io['meanQuality']:.3f}** | {io['minQuality']:.3f} | {io['meanOutputTokens']:.0f} |")
    L.append(f"| R2 | grok-4.5 | R2 lean AF, no skill | {ro['samples']} | {ro['okCount']}/{ro['samples']} | **{ro['meanQuality']:.3f}** | {ro['minQuality']:.3f} | {ro['meanOutputTokens']:.0f} |")
    L.append(f"\n**Delta (R2 − incumbent) = {delta:+.3f} — {verdict}**\n")
    L.append("## Per-task meanQ\n")
    L.append("| task | incumbent | R2 | delta |")
    L.append("|---|---|---|---|")
    for t in tasks:
        iq = inc_pt.get(t, {}).get("meanQuality")
        rq = r2_pt.get(t, {}).get("meanQuality")
        dl = (f"{rq-iq:+.3f}" if (iq is not None and rq is not None) else "—")
        L.append(f"| {t} | {q(iq)} | {q(rq)} | {dl} |")
    L.append("")
    art = f"{OUT}/TSR-4748-R2-vs-incumbent-comparison.md"
    open(art, "w").write("\n".join(L) + "\n")

    for src, dst in [(f"{inc_dir}/report.md", f"{OUT}/incumbent-report.md"),
                     (f"{r2_dir}/report.md", f"{OUT}/R2-report.md"),
                     (f"{inc_dir}/summary.json", f"{OUT}/incumbent-summary.json"),
                     (f"{r2_dir}/summary.json", f"{OUT}/R2-summary.json")]:
        try: shutil.copy(src, dst)
        except Exception as e: log(f"copy {src} failed: {e}")

    result = {
        "incumbent_run": pathlib.Path(inc_dir).name,
        "incumbent_n": io["samples"], "incumbent_ok": io["okCount"], "incumbent_meanQ": round(io["meanQuality"], 4),
        "r2_run": pathlib.Path(r2_dir).name,
        "r2_n": ro["samples"], "r2_ok": ro["okCount"], "r2_meanQ": round(ro["meanQuality"], 4),
        "delta": round(delta, 4), "verdict": verdict,
        "artifact": art,
        "finished_utc": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    json.dump(result, open(f"{OUT}/result.json", "w"), indent=2)
    log("=== RESULT MARKER ===")
    log(json.dumps(result))
    log("=== TSR-4748 finisher done ===")

if __name__ == "__main__":
    main()
