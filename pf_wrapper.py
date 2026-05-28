#!/usr/bin/env python3
"""
pf_wrapper.py — PaperclipForge CTO agent wrapper

The CTO implements GitHub issues for the paperclipai/paperclip open-source
project. It works in the fork at /home/isak/projects/paperclip, creates
feature branches, implements fixes, pushes branches, and opens PRs.

Model resolution:
  OPENCODE_MODEL env var is REQUIRED — set in Paperclip agent adapter_config.
  If not set, hard error. No fallbacks.

Always prints which model/provider was selected and WHY.
Never reuses stale _model_config.yaml — always writes fresh.
Captures token usage from mini-swe-agent output.
"""

import os, sys, json, re, subprocess, threading
from pathlib import Path
from datetime import datetime, timezone

# ── Constants ─────────────────────────────────────────────────────────────────
LMS_BASE      = os.environ.get("LMS_BASE", "http://192.168.0.7:1234")
CONTEXT_TOKENS = int(os.environ.get("PF_CONTEXT_K", "32")) * 1024  # default 32k
DEFAULT_CTX   = 131072
PF_ROOT       = "/home/isak/projects/paperclip"

# Infra files agents must NEVER modify — owned by Cowork/human only.
PROTECTED_PATHS = [
    f"{PF_ROOT}/pf_wrapper.py",
    f"{PF_ROOT}/mini_runner.py",
    f"{PF_ROOT}/mini_textbased.yaml",
    f"{PF_ROOT}/AGENTS.md",
]

# ── Logging ───────────────────────────────────────────────────────────────────
def log(msg=""):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[pf {ts}] {msg}", file=sys.stderr, flush=True)

def banner(title, lines):
    log(f"┌─ {title} {'─' * max(0, 50 - len(title))}")
    for line in lines:
        log(f"│  {line}")
    log("└" + "─" * 52)

# ── Infra file protection ─────────────────────────────────────────────────────
def protect_infra_files():
    import stat
    locked = []
    for path_str in PROTECTED_PATHS:
        p = Path(path_str)
        if p.exists():
            try:
                p.chmod(p.stat().st_mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))
                locked.append(path_str)
            except Exception as e:
                log(f"⚠ Could not lock {path_str}: {e}")
    if locked:
        log(f"🔒 Locked {len(locked)} infra files (read-only during agent run)")

def unprotect_infra_files():
    import stat
    for path_str in PROTECTED_PATHS:
        p = Path(path_str)
        if p.exists():
            try:
                p.chmod(p.stat().st_mode | stat.S_IWUSR)
            except Exception as e:
                log(f"⚠ Could not unlock {path_str}: {e}")

# ── Provider detection ────────────────────────────────────────────────────────
def detect_provider(model_name: str):
    if model_name.startswith("openrouter/"):
        return "openrouter", model_name[len("openrouter/"):]
    if model_name.startswith("anthropic/") or model_name.startswith("claude-"):
        return "anthropic", model_name
    if model_name.startswith("ollama/"):
        return "ollama", model_name[len("ollama/"):]
    if model_name.startswith("lmstudio/"):
        return "lmstudio", model_name[len("lmstudio/"):]
    return "lmstudio", model_name

# ── Model resolution ──────────────────────────────────────────────────────────
def resolve_model():
    env_model = os.environ.get("OPENCODE_MODEL", "").strip()
    if not env_model:
        raise RuntimeError(
            "OPENCODE_MODEL env var is not set. Set it in Paperclip agent adapter_config."
        )
    provider, clean = detect_provider(env_model)
    ctx = DEFAULT_CTX
    api_base = LMS_BASE + "/v1"
    api_key_env = None

    if provider == "openrouter":
        api_base = "https://openrouter.ai/api/v1"
        api_key_env = "OPENROUTER_API_KEY"
    elif provider == "anthropic":
        api_key_env = "ANTHROPIC_API_KEY"

    return dict(
        model=clean, provider=provider, context_length=ctx,
        api_base=api_base, api_key_env=api_key_env,
        source="OPENCODE_MODEL env var",
    )

# ── Config helpers ────────────────────────────────────────────────────────────
def build_litellm_model_str(model, provider):
    if provider in ("lmstudio", "openrouter"):
        return f"openai/{model}"
    return model

def get_api_key(provider, api_key_env):
    if provider == "lmstudio":
        return "lm-studio"
    if api_key_env:
        key = os.environ.get(api_key_env, "")
        if not key:
            log(f"⚠ {api_key_env} not set in environment!")
        return key
    return "none"

def write_fresh_config(workspace: Path, model_str, api_base, api_key, ctx):
    cfg_path = workspace / "_model_config.yaml"
    if cfg_path.exists():
        old = cfg_path.read_text()[:120].replace("\n", " ").strip()
        log(f"Removing stale _model_config.yaml — was: {old!r}")
        cfg_path.unlink()
    content = (
        f"model:\n"
        f"  model_name: {model_str}\n"
        f"  model_class: litellm_textbased\n"
        f"  model_kwargs:\n"
        f"    api_base: {api_base}\n"
        f"    api_key: {api_key}\n"
        f"    max_tokens: {min(ctx, 65536)}\n"
        f"    drop_params: true\n"
        f"    request_timeout: 300\n"
        f"  cost_tracking: ignore_errors\n"
    )
    cfg_path.write_text(content)
    log(f"Wrote fresh _model_config.yaml")
    return cfg_path

# ── Token parsing ─────────────────────────────────────────────────────────────
def parse_tokens(text: str) -> dict:
    stats = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "peak_input": 0, "calls": 0}
    for line in text.splitlines():
        m = re.match(
            r'\[TOKENS\]\s+input=(\d+)\s+output=(\d+)\s+peak_input=(\d+)\s+calls=(\d+)',
            line.strip()
        )
        if m:
            stats["prompt_tokens"]     = int(m.group(1))
            stats["completion_tokens"] = int(m.group(2))
            stats["peak_input"]        = int(m.group(3))
            stats["calls"]             = int(m.group(4))
            stats["total_tokens"]      = stats["prompt_tokens"] + stats["completion_tokens"]
            return stats
    patterns = [
        (r"prompt[_\s]tokens[:\s='\"]+(\d+)",     "prompt_tokens"),
        (r"input[_\s]tokens[:\s='\"]+(\d+)",      "prompt_tokens"),
        (r"completion[_\s]tokens[:\s='\"]+(\d+)", "completion_tokens"),
        (r"output[_\s]tokens[:\s='\"]+(\d+)",     "completion_tokens"),
        (r"total[_\s]tokens[:\s='\"]+(\d+)",      "total_tokens"),
    ]
    for pattern, key in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            val = int(match.group(1))
            if val > stats[key]:
                stats[key] = val
    if stats["total_tokens"] == 0:
        stats["total_tokens"] = stats["prompt_tokens"] + stats["completion_tokens"]
    return stats

PROVIDER_PRICES = {
    "lmstudio":  (0.0,        0.0),
    "anthropic": (0.000003,   0.000015),
    "openrouter":(0.000001,   0.000002),
    "ollama":    (0.0,        0.0),
}

def estimate_cost(provider, tokens) -> float:
    in_p, out_p = PROVIDER_PRICES.get(provider, (0.0, 0.0))
    return round(tokens["prompt_tokens"] * in_p + tokens["completion_tokens"] * out_p, 6)

# ── Paperclip progress comment helpers ───────────────────────────────────────
_PG_ENV = {**os.environ, "PGPASSWORD": "paperclip"}
_PG_CMD = ["psql", "-h", "127.0.0.1", "-p", "54329", "-U", "paperclip", "paperclip"]

def _get_company_id(issue_id=None):
    try:
        if issue_id:
            r = subprocess.run(
                _PG_CMD + ["-tAc", "SELECT company_id FROM issues WHERE id = '" + issue_id + "' LIMIT 1"],
                capture_output=True, text=True, timeout=5, env=_PG_ENV,
            )
            val = r.stdout.strip()
            if val and r.returncode == 0:
                return val
        r = subprocess.run(
            _PG_CMD + ["-tAc", "SELECT id FROM companies ORDER BY created_at LIMIT 1"],
            capture_output=True, text=True, timeout=5, env=_PG_ENV,
        )
        val = r.stdout.strip()
        return val if val and r.returncode == 0 else None
    except Exception:
        return None

def _post_comment(issue_id: str, company_id: str, body: str) -> bool:
    sql = (
        f"INSERT INTO issue_comments (id, company_id, issue_id, body) "
        f"VALUES (gen_random_uuid(), '{company_id}', '{issue_id}', "
        f"$PFBODY${body}$PFBODY$);"
    )
    try:
        r = subprocess.run(
            _PG_CMD + ["-c", sql],
            capture_output=True, text=True, timeout=6, env=_PG_ENV,
        )
        return r.returncode == 0
    except Exception as exc:
        log(f"⚠ Comment post failed: {exc}")
        return False

def _start_progress_poster(issue_id: str, company_id: str,
                            lines_ref: list, done_event: threading.Event,
                            interval_sec: int = 60):
    last_pos = [0]
    post_num = [0]

    def _run():
        while not done_event.wait(timeout=interval_sec):
            _flush(final=False)
        _flush(final=True)

    def _flush(final: bool):
        chunk = lines_ref[last_pos[0]:]
        last_pos[0] = len(lines_ref)
        interesting = [
            l.rstrip() for l in chunk
            if l.strip() and not _BENIGN_PATTERNS.search(l)
        ]
        if not interesting and not final:
            return
        post_num[0] += 1
        if final and not interesting:
            return
        header = "✅ **Agent complete**" if final else f"🔄 **Agent progress** (update #{post_num[0]})"
        snippet = "\n".join(interesting[-25:])
        body = f"{header}\n```\n{snippet}\n```"
        ok = _post_comment(issue_id, company_id, body)
        if not ok:
            log(f"⚠ Progress comment #{post_num[0]} failed (non-fatal)")

    t = threading.Thread(target=_run, name="progress-poster", daemon=True)
    t.start()
    return t

# ── Failure detection ─────────────────────────────────────────────────────────
_BENIGN_PATTERNS = re.compile(
    r"(successfully registered|mcp.*init|iso8601|\[pf\s+\d+:\d+:\d+\]"
    r"|INFO|DEBUG|building agent config|wrote fresh|removing stale)",
    re.IGNORECASE,
)
_ERROR_PATTERNS = re.compile(
    r"(traceback|exception|importerror|modulenotfounderror|syntaxerror"
    r"|adapter.?failed|command not found|action was not executed)",
    re.IGNORECASE,
)

def detect_silent_failure(text: str) -> bool:
    if "action was not executed" in text.lower():
        return True
    for line in text.splitlines():
        if _BENIGN_PATTERNS.search(line):
            continue
        if _ERROR_PATTERNS.search(line):
            return True
    return False

def filter_stderr(stderr: str) -> str:
    filtered = []
    for line in stderr.splitlines():
        if not _BENIGN_PATTERNS.search(line):
            filtered.append(line)
        elif line.startswith("[pf"):
            filtered.append(line)
    return "\n".join(filtered)

# ── Models subcommand ─────────────────────────────────────────────────────────
def handle_models_subcommand():
    import urllib.request
    lms_base = os.environ.get("LMS_BASE", "http://192.168.0.7:1234")
    try:
        with urllib.request.urlopen(f"{lms_base}/api/v0/models", timeout=5) as resp:
            data = json.loads(resp.read())
            for m in data.get("data", []):
                mid = m.get("id", "")
                if mid:
                    print(f"lmstudio/{mid}")
    except Exception:
        env_model = os.environ.get("OPENCODE_MODEL", "").strip()
        if not env_model:
            log("ERROR: LM Studio unreachable and OPENCODE_MODEL not set")
            sys.exit(1)
        print(env_model)
    sys.exit(0)

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    if len(sys.argv) > 1 and sys.argv[1] == "models":
        handle_models_subcommand()

    task = os.environ.get("OPENCODE_TASK", "")
    workspace = Path(PF_ROOT)

    log("=" * 52)
    log("pf_wrapper — PaperclipForge CTO")
    log(f"Workspace: {workspace}")

    try:
        cfg = resolve_model()
    except RuntimeError as e:
        log(f"FATAL: {e}")
        sys.exit(1)

    model_str = build_litellm_model_str(cfg["model"], cfg["provider"])
    api_key   = get_api_key(cfg["provider"], cfg.get("api_key_env"))

    banner("MODEL SELECTION", [
        f"Model:    {cfg['model']}",
        f"Provider: {cfg['provider']}",
        f"Context:  {cfg['context_length']}",
        f"Source:   {cfg['source']}",
        f"API base: {cfg['api_base']}",
        f"LiteLLM:  {model_str}",
    ])

    write_fresh_config(workspace, model_str, cfg["api_base"], api_key, cfg["context_length"])

    # Use venv Python (minisweagent installed there); fall back to system Python
    _venv_py = "/home/isak/lmeh/.venv/bin/python3"
    _python = _venv_py if Path(_venv_py).exists() else sys.executable

    # Runner and config live alongside this wrapper in PF_ROOT
    _runner    = str(workspace / "mini_runner.py")
    _cfg_yaml  = str(workspace / "mini_textbased.yaml")
    _cfg_args  = ["--config", _cfg_yaml] if Path(_cfg_yaml).exists() else []

    cmd = [_python, _runner,
           *_cfg_args,
           "--config", str(workspace / "_model_config.yaml"),
           "--yolo", "--exit-immediately"]
    if task:
        cmd.extend(["--task", task])

    log(f"Exec: {' '.join(cmd[:6])} ...")
    protect_infra_files()

    _env = {**os.environ,
            "MSWEA_CONFIGURED": "true",
            "MSWEA_SILENT_STARTUP": "1",
            "LITELLM_LOCAL_MODEL_COST_MAP": "true",
            "LITELLM_LOG": "ERROR"}
    _TIMEOUT_SEC = int(os.environ.get("PF_WRAPPER_TIMEOUT", "1800"))

    # Progress posting setup
    _issue_id = None
    _company_id = None
    # Paperclip passes task/issue ID via PAPERCLIP_TASK_ID env var.
    # Fall back to .paperclip_task_id file for any other callers.
    _issue_id = os.environ.get("PAPERCLIP_TASK_ID", "").strip() or None
    if not _issue_id:
        _task_id_file = workspace / ".paperclip_task_id"
        if _task_id_file.exists():
            _issue_id = _task_id_file.read_text().strip() or None
    if _issue_id:
        _company_id = _get_company_id(_issue_id)
        if _company_id:
            log(f"Progress comments → issue {_issue_id[:8]}… (company {_company_id[:8]}…)")
        else:
            log("⚠ Could not get company_id — progress comments disabled")
            _issue_id = None

    # Streaming subprocess
    _stdout_lines: list[str] = []
    _stderr_lines: list[str] = []
    _all_lines:   list[str] = []
    _stream_lock = threading.Lock()

    def _reader(stream, lines, passthrough=False):
        try:
            for line in stream:
                with _stream_lock:
                    lines.append(line)
                    _all_lines.append(line)
                if passthrough:
                    print(line, end="", flush=True)
        except Exception:
            pass

    proc = subprocess.Popen(
        cmd, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=str(workspace), env=_env,
    )

    _t_out = threading.Thread(target=_reader, args=(proc.stdout, _stdout_lines), kwargs={"passthrough": True}, daemon=True)
    _t_err = threading.Thread(target=_reader, args=(proc.stderr, _stderr_lines), daemon=True)
    _t_out.start()
    _t_err.start()

    _done_event = threading.Event()
    _poster_thread = None
    if _issue_id and _company_id:
        _poster_thread = _start_progress_poster(
            _issue_id, _company_id, _all_lines, _done_event, interval_sec=60
        )

    _timed_out = False
    try:
        proc.wait(timeout=_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        _timed_out = True
        log(f"FATAL: agent timed out after {_TIMEOUT_SEC}s — sending SIGKILL")
        proc.kill()
        proc.wait()

    # Join readers FIRST so all output is in _all_lines before final flush
    _t_out.join(timeout=5)
    _t_err.join(timeout=5)
    _done_event.set()  # now trigger final flush with complete output
    if _poster_thread:
        _poster_thread.join(timeout=15)  # extra headroom for final comment post

    unprotect_infra_files()

    class _Result:
        returncode = proc.returncode if not _timed_out else 124
        stdout = "".join(_stdout_lines)
        stderr = "".join(_stderr_lines) + (
            f"\nwrapper: subprocess timed out after {_TIMEOUT_SEC}s\n" if _timed_out else ""
        )

    result = _Result()
    combined = result.stdout + "\n" + result.stderr

    tokens = parse_tokens(combined)
    cost   = estimate_cost(cfg["provider"], tokens)
    peak_ctx_pct = round(tokens["peak_input"] / CONTEXT_TOKENS * 100, 1) if CONTEXT_TOKENS > 0 else 0.0

    silent_fail = detect_silent_failure(combined)
    exit_code = result.returncode
    if silent_fail and exit_code == 0:
        log("⚠ Silent failure detected — exit 0→1")
        exit_code = 1

    banner("RUN SUMMARY", [
        f"Model:             {cfg['model']}",
        f"Provider:          {cfg['provider']}",
        f"Exit code:         {exit_code}{' (overridden)' if silent_fail else ''}",
        f"Silent failure:    {silent_fail}",
        f"Prompt tokens:     {tokens['prompt_tokens']:,}",
        f"Completion tokens: {tokens['completion_tokens']:,}",
        f"Total tokens:      {tokens['total_tokens']:,}",
        f"Peak context:      {tokens['peak_input']:,} ({peak_ctx_pct:.1f}% of {CONTEXT_TOKENS//1024}k)",
        f"API calls:         {tokens['calls']}",
        f"Est. cost:         ${cost:.6f} ({cfg['provider']})",
    ])

    if _issue_id and _company_id:
        _final_body = (
            f"{'✅' if exit_code == 0 else '❌'} **Run complete** (exit {exit_code})\n\n"
            f"| Metric | Value |\n|---|---|\n"
            f"| Input tokens | {tokens['prompt_tokens']:,} |\n"
            f"| Output tokens | {tokens['completion_tokens']:,} |\n"
            f"| Peak context | {tokens['peak_input']:,} ({peak_ctx_pct:.1f}% of {CONTEXT_TOKENS//1024}k) |\n"
            f"| API calls | {tokens['calls']} |\n"
            f"| Silent failure | {silent_fail} |"
        )
        _post_comment(_issue_id, _company_id, _final_body)

    # stdout already streamed in real-time via _reader(passthrough=True)
    if result.stderr:
        print(filter_stderr(result.stderr), end="", file=sys.stderr)

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
