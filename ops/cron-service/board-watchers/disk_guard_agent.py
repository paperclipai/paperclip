#!/usr/bin/env python3
# disk_guard.py -- HELA-11412 (27.09.2026), HELA-12993 (29.09.2026): strict tier of the host disk guard.
#
# Called by ~/bin/disk-pressure-gc.sh (cron 5,35) under its flock; can also run standalone.
# --volume root (/, /dev/sda1; threshold 15, crit 10). Levers in order, stop at threshold + HYST_GB:
#     own crash reports (HELA-14308) -> run-scratch -> hardlink .venv -> hardlink node_modules
#     -> docker build cache unused 3 h (HELA-14308)
#     -> closed-card Docker images, with the reviewed rollout gates in gc_closed_card_images.py
#     -> closed-trees (idle 6 h) -> idle open-card trees (blocked/todo/backlog, idle 48 h, clean + pushed, Codex farm; HELA-11412 29.09).
#   HELA-11412 30.09 (Alpha's decision on d9e1910b), all idle 48 h:
#     closed-trees (idle 6 h) -> closed-card trees the strict GC keeps, archived first (gc_closed_trees_archive.py:
#     dirty -> patch/tgz, detached-unique -> backup branch, unpushed clone -> bundle; ~/tree-archive-<date>)
#     -> idle open Codex trees, now also linked worktrees on a named branch with local-only commits (the branch stays,
#     sha pinned by backup/tree-gc-<date>/<name>) -> idle open trees of the Claude farms (clean + pushed only).
#   Emergency tier (HELA-12993) when / is still below --emergency-gb (5) after them -- the 27.09 case, when the new
#   trees are live and the closed-card reserve is spent. Least harm first, stop once / is back at --crit-gb:
#     docker build cache unused 2 h -> closed-trees (idle 1 h) -> idle open-card trees (idle 24 h)
#     -> idle test DBs (gc_test_dbs.py, >= 2 h, card without live run, plain DROP)
#     -> deps (.venv, then node_modules) of cards not in_progress, idle >= 2 h (gc_deps_strict.py).
#   Off-schedule start (HELA-14308): the urgent helper starts the same scoped wrapper below 5 GB.
# --volume sdb (/mnt/HC_Volume_106646767; threshold 12, crit 8; HELA-12993). Levers in order:
#     archive Codex rollouts idle 14 d -> idle 7 d (zstd + sha256, archive_codex_sessions.py)
#     -> clean checkouts of closed cards in the sdb project farm, idle 24 h (gc_closed_trees_strict.py --farm sdb).
# Signal on HELA-12595 for every strict sweep:
#   * note      -- agent-side disk log only (no board write or wake);
#   * escalate  -- scoped reporter PATCHes {status: todo, comment}, which wakes
#                  the assignee (DevOps); at most once per 2 h, separate timer per volume.
# Levers never touch docker volumes, live worktrees, dirty trees or unpushed commits (see each script).
#
# Test hooks:
#   --dry-run                      levers without --apply, signal printed instead of posted
#   --free-override 8              pretend the volume has 8 GB free (drives threshold/emergency/escalation logic)
#   --force                        run the strict tier even when the volume is healthy (controlled trigger)
#   --emergency-limit N            cap each emergency lever at N items (controlled live run)
#   Quota-wall fallback is disabled until a service-scoped status route exists.
import argparse, datetime, fcntl, os, re, subprocess, sys, time

HOME = "/home/paperclip-user"
BIN = HOME + "/bin/closed-card-gc"
COMPANY = "ac917a45-e6ea-4696-a85c-991147084939"
SIGNAL_ISSUE = "f6775544-fb1c-4380-906c-66e4f5fb7028"  # HELA-12595, standing signal card (successor of HELA-1957)
SIGNAL_REF = "HELA-12595"
LOG = HOME + "/disk-guard.log"
HOST_LOG = HOME + "/host-gc.log"
STATE = HOME + "/.disk-guard-state"
LOCK = "/tmp/disk-pressure-gc.lock"
HYST_GB = 5
ESCALATE_GAP_S = 2 * 3600
LOG_MAX = 16 * 2**20
IMAGES_APPLY_FROM = "2026-10-02T03:00:00Z"  # HELA-13428: image cleanup remains dry before this instant
VOLUMES = {
    "root": {"path": "/", "label": "`/`", "threshold": ("STRICT_GB", 15), "crit": ("GUARD_CRIT_GB", 10),
             "state": "last-escalation"},
    "sdb": {"path": "/mnt/HC_Volume_106646767", "label": "sdb (`/mnt/HC_Volume_106646767`)",
            "threshold": ("SDB_STRICT_GB", 12), "crit": ("SDB_CRIT_GB", 8), "state": "last-escalation-sdb"},
}

ap = argparse.ArgumentParser()
ap.add_argument("--volume", choices=sorted(VOLUMES), default="root")
ap.add_argument("--threshold-gb", type=float, default=None)
ap.add_argument("--crit-gb", type=float, default=None)
ap.add_argument("--emergency-gb", type=float, default=float(os.environ.get("EMERG_GB", 5)))
ap.add_argument("--emergency-limit", type=int, default=0)
ap.add_argument("--dry-run", action="store_true", default=os.environ.get("DRY_RUN") == "1")
ap.add_argument("--free-override", "--root-free-override", dest="free_override", type=float, default=None)
ap.add_argument("--force", action="store_true")
args = ap.parse_args()
URGENT = os.environ.get("DISK_GUARD_TRIGGER") == "urgent"
VOL = VOLUMES[args.volume]
if args.threshold_gb is None:
    args.threshold_gb = float(os.environ.get(VOL["threshold"][0], VOL["threshold"][1]))
if args.crit_gb is None:
    args.crit_gb = float(os.environ.get(VOL["crit"][0], VOL["crit"][1]))
TAG = "" if args.volume == "root" else f"[{args.volume}] "


def ts():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg):
    msg = TAG + msg
    # a dry run must leave no trace in the forensic logs (same rule as disk-alert.sh)
    if args.dry_run:
        print(msg)
        return
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > LOG_MAX:
            keep = open(LOG, errors="replace").read().splitlines()[-2000:]
            with open(LOG, "w") as f:  # truncate in place: cron holds the path open in O_APPEND
                f.write("\n".join(keep) + "\n")
        with open(LOG, "a") as f:
            f.write(f"[{ts()}] {msg}\n")
    except OSError:
        pass
    print(msg)


def real_free_gb():
    s = os.statvfs(VOL["path"])
    return round(s.f_bavail * s.f_frsize / 1e9, 1)


def free_gb():
    return args.free_override if args.free_override is not None else real_free_gb()


if os.environ.get("DISK_GUARD_LOCKED") != "1":
    lk = open(LOCK, "w")
    try:
        fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another sweep holds the lock, skipping")
        sys.exit(0)

start = free_gb()
if start >= args.threshold_gb and not args.force:
    sys.exit(0)

mode = "DRY-RUN" if args.dry_run else "apply"
log(f"strict tier: {VOL['path']} free {start}G < {args.threshold_gb}G (force={args.force}, {mode}"
    f"{', off-schedule: / below 5G' if URGENT else ''})")
apply = [] if args.dry_run else ["--apply"]
py = sys.executable
# Idle OPEN cards' trees (HELA-11412, 29.09; founder 27.09 "... закрытых карт и простаивающих"): Codex farm only (Claude
# clones stay), blocked/todo/backlog (in_review keeps its tree for the reviewer), clean, HEAD in a remote ref, no ignored
# evidence, not named by a Paperclip workspace. Manifest to recreate a tree: ~/open-idle-trees-removed.tsv.
OPEN_TREES = ["--statuses", "blocked,todo,backlog", "--only-root", HOME + "/helloprint-codex", "--require-pushed",
              "--skip-evidence", "--budget", "600", "--manifest", HOME + "/open-idle-trees-removed.tsv"]
# 30.09 (Alpha on d9e1910b), strict tier only, idle 48 h: Claude farms clean + pushed; Codex local-only commits on a
# named branch (--local-branch-ok); dirty/detached/unpushed closed-card trees after archiving them.
CLAUDE_TREES = ["--exclude-root" if a == "--only-root" else a for a in OPEN_TREES]
ARCHIVE = ["--archive", HOME + "/tree-archive-" + time.strftime("%Y-%m-%d", time.gmtime()), "--save-cap-mb", "200",
           "--budget", "600"]
IMAGES_ON = time.time() >= datetime.datetime.fromisoformat(IMAGES_APPLY_FROM.replace("Z", "+00:00")).timestamp()
IMAGES = ("closed-card-images", apply) if IMAGES_ON else ("closed-card-images-dry", [])
if args.volume == "sdb":
    LEVERS = [
        ("codex-sessions-14d", [py, BIN + "/archive_codex_sessions.py", "--days", "14", "--budget", "900"] + apply, 1000),
        ("codex-sessions-7d", [py, BIN + "/archive_codex_sessions.py", "--days", "7", "--budget", "900"] + apply, 1000),
        ("closed-trees-sdb", [py, BIN + "/gc_closed_trees_strict.py", "--farm", "sdb", "--idle-h", "24", "--budget", "600"] + apply, 900),
    ]
else:
    LEVERS = [
        ("var-crash-own-uid", [py, BIN + "/gc_var_crash.py", "--min-idle-min", "30"] + apply, 120),
        ("run-scratch", [py, BIN + "/gc_run_scratch.py"] + apply, 300),
        ("hardlink-venv", [py, BIN + "/hardlink_deps.py", "--target", ".venv"] + apply, 900),
        ("hardlink-node_modules", [py, BIN + "/hardlink_deps.py", "--target", "node_modules"] + apply, 900),
        ("build-cache-3h", [py, BIN + "/gc_build_cache.py", "--unused-h", "3"] + apply, 300),
        (IMAGES[0], [py, BIN + "/gc_closed_card_images.py", "--idle-h", "6"] + IMAGES[1], 600),
        ("closed-trees", [py, BIN + "/gc_closed_trees_strict.py", "--idle-h", "6", "--budget", "600"] + apply, 900),
        ("closed-trees-archive-48h", [py, BIN + "/gc_closed_trees_archive.py"] + ARCHIVE + ["--idle-h", "48"] + apply, 900),
        ("idle-open-trees-48h", [py, BIN + "/gc_closed_trees_strict.py"] + OPEN_TREES + ["--local-branch-ok", "--idle-h", "48"]
         + apply, 900),
        ("idle-claude-trees-48h", [py, BIN + "/gc_closed_trees_strict.py"] + CLAUDE_TREES + ["--idle-h", "48"] + apply, 900),
    ]
lim = ["--limit", str(args.emergency_limit)] if args.emergency_limit else []
EMERGENCY = [
    ("emerg-build-cache-2h", [py, BIN + "/gc_build_cache.py", "--unused-h", "2"] + apply, 300),
    ("emerg-closed-trees-1h", [py, BIN + "/gc_closed_trees_strict.py", "--idle-h", "1", "--budget", "600"] + apply, 900),
    ("emerg-idle-open-trees-24h", [py, BIN + "/gc_closed_trees_strict.py"] + OPEN_TREES + ["--idle-h", "24"] + apply, 900),
    ("emerg-test-dbs", [py, BIN + "/gc_test_dbs.py", "--min-age-h", "2"] + lim + apply, 300),
    ("emerg-deps-venv", [py, BIN + "/gc_deps_strict.py", "--target", ".venv", "--exclude-statuses", "in_progress",
                         "--idle-h", "2"] + lim + apply, 600),
    ("emerg-deps-node_modules", [py, BIN + "/gc_deps_strict.py", "--target", "node_modules", "--exclude-statuses",
                                 "in_progress", "--idle-h", "2"] + lim + apply, 600),
] if args.volume == "root" else []
SAFE_COUNT = re.compile(r"^(selected|removed|archived|test DBs):\s*(\d+)\s*$")
rows = []


def run_lever(name, cmd, tmo):
    b = real_free_gb()
    t = time.time()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=tmo)
        rc = str(r.returncode)
        out = (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        rc, out = "timeout", ""
    a = real_free_gb()
    # Helper stdout/stderr can contain arbitrary paths or credentials. Retain
    # only numeric counters in the ordinary log and the issue signal.
    counts = [match.groups() for line in out.splitlines()
              if (match := SAFE_COUNT.fullmatch(line.strip()))]
    brief = "; ".join(f"{label}: {count}" for label, count in counts)[:400]
    if rc not in ("0", "timeout") and not brief:
        brief = "helper failed; output withheld"
    rows.append((name, rc, round(a - b, 1), brief))
    log(f"  {name}: rc={rc} {int(time.time() - t)}s free {b}G -> {a}G | {brief}")


for name, cmd, tmo in LEVERS:
    if not args.dry_run and not args.force and real_free_gb() >= args.threshold_gb + HYST_GB:
        rows.append((name, "skipped", 0.0, "reserve restored"))
        continue
    run_lever(name, cmd, tmo)

# Emergency tier: judged on the (possibly overridden) level after the regular levers. With --free-override the
# override stands for "the levers did not help", so the tier runs; per-lever stop is on the real level (crit).
emerg_level = free_gb() if args.free_override is not None else real_free_gb()
if EMERGENCY and (emerg_level < args.emergency_gb or (args.force and args.free_override is not None
                                                     and args.free_override < args.emergency_gb)):
    log(f"emergency tier: {VOL['path']} free {emerg_level}G < {args.emergency_gb}G after regular levers")
    for name, cmd, tmo in EMERGENCY:
        if not args.dry_run and args.free_override is None and real_free_gb() >= args.crit_gb:
            rows.append((name, "skipped", 0.0, f"back at {args.crit_gb:g}G"))
            continue
        run_lever(name, cmd, tmo)
emergency_ran = any(n.startswith("emerg-") for n, *_ in rows)

end = real_free_gb()
end_eff = free_gb() if args.free_override is not None else end
table = "\n".join(f"| {n} | {rc} | {d:+.1f} | {b.replace('|', '/')} |" for n, rc, d, b in rows)
host = (f"[{ts()}] disk-guard{'-' + args.volume if args.volume != 'root' else ''}: {VOL['path']} {start}G -> {end}G "
        f"({mode}{', off-schedule' if URGENT else ''}); " + ", ".join(f"{n}={rc}:{d:+.1f}G" for n, rc, d, _ in rows))
if not args.dry_run:
    try:
        with open(HOST_LOG, "a") as f:
            f.write(host + "\n")
    except OSError:
        pass


escalate = end_eff < args.crit_gb
os.makedirs(STATE, exist_ok=True)
last_f = os.path.join(STATE, VOL["state"])
try:
    last = float(open(last_f).read().strip())
except Exception:
    last = 0.0
if escalate and time.time() - last < ESCALATE_GAP_S and not args.dry_run:
    log(f"escalation suppressed: previous one {int((time.time() - last) / 60)} min ago (gap {ESCALATE_GAP_S // 60} min)")
    escalate = False

head = ("🚨 **Эскалация дискового сторожа**" if escalate else "🟡 **Срабатывание дискового сторожа**")
if URGENT:
    head += " (внеплановый запуск: на `/` было меньше 5 ГБ, [HELA-14308](/HELA/issues/HELA-14308))"
body = (f"{head} — {VOL['label']} свободно было **{start} ГБ** (порог {args.threshold_gb:g}), после строгих рычагов"
        f"{' и аварийной ступени' if emergency_ran else ''} **{end} ГБ**"
        f"{' (замер подменён тест-хуком: ' + str(end_eff) + ' ГБ)' if args.free_override is not None else ''}.\n\n"
        f"| рычаг | rc | ГБ | итог |\n| --- | --- | ---: | --- |\n{table}\n\n")
if escalate:
    if args.volume == "sdb":
        body += (f"После всех рычагов на sdb меньше {args.crit_gb:g} ГБ. **DevOps**: разобрать по чек-листу этой карты: ряд "
                 f"`disk:`/`sdb:` в `~/farm-artifact-gc.log` (кто рос), `du` по `companies`/`projects`/`run-logs`; ~14 ГБ sdb "
                 f"в root-каталогах агенту недоступны — вопрос отдельной картой на ребре к орк 22 (HELA-12458); "
                 f"ёмкость не докупается, founder'у про диск не писать. Затем вернуть "
                 f"карту в `backlog`.\n\n")
    else:
        body += (f"После всех рычагов на `/` меньше {args.crit_gb:g} ГБ: резерв закрытых карт исчерпан. **DevOps**: разобрать по "
                 f"чек-листу в описании этой карты (кто пишет; ёмкость не докупается, founder'у про диск не писать; правила уборки — "
                 f"вопрос отдельной картой на ребре к орк 22, HELA-12458), затем вернуть карту в `backlog`.\n\n")
body += (f"Журнал: `~/disk-guard.log`, `~/host-gc.log`. Режим: {mode}.\n\n"
         f"— disk-guard (хост-крон DevOps, [HELA-11412](/HELA/issues/HELA-11412), [HELA-12993](/HELA/issues/HELA-12993)); "
         f"машина, не человек{', узкий сервисный ключ' if escalate else ', локальный журнал без вейка'}.")

if args.dry_run:
    print("---- would post (" + ("escalate" if escalate else "note") + ") ----\n" + body)
    sys.exit(0)


def report():
    result = subprocess.run(
        ["/usr/bin/python3", "/opt/paperclip-cron/disk_client.py", "escalate"],
        capture_output=True, text=True, timeout=40,
    )
    return result.returncode == 0


def local_note(_text):
    return True, "local disk log only"


def api_escalate(_text):
    if not report():
        raise RuntimeError("disk reporter rejected escalation")
    return True


if escalate:
    try:
        api_escalate(body)
        open(last_f, "w").write(str(time.time()))
        log(f"signal: escalated on {SIGNAL_REF} (status todo + comment, scoped reporter)")
    except Exception as e:
        ok, err = local_note(body + f"\n\n⚠️ Эскалация через API не прошла ({type(e).__name__}); вейка нет.")
        log(f"signal: ESCALATION FAILED ({type(e).__name__}); local note ok={ok} {err}")
        log(body)
else:
    ok, err = local_note(body)
    log(f"signal: local note for {SIGNAL_REF} ok={ok} {err}")
    log(body)
