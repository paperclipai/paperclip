#!/usr/bin/env python3
"""
adapters.py — one function per model CLI lane. Each takes a prompt + the model's
config row and returns benchlib.empty_result()-shaped dict (output + normalized
token usage + wall time). All run in a fresh, empty temp CWD so the local repo's
CLAUDE.md / AGENTS.md / rules don't leak in — we want the base model, not the
local agent harness (#16 measures the harness; #15 measures the model).

Lanes:
  claude  ->  claude -p ... --output-format json     (usage in JSON)
  codex   ->  codex exec ... --json -o last.txt       (cumulative usage in JSONL events)
  gemini  ->  gemini -p ... -o json                   (usage in stats block)
  grok    ->  grok --prompt-file ... --output-format streaming-json
  hermes  ->  hermes -z ...                            (text only; tokens via sessions export)
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import benchlib

# hermes attributes token usage by diffing the shared session store before/after a
# run. Concurrent hermes runs (grok-4.3 + grok-4.20 share this CLI and run the SAME
# prompt) would race and cross-attribute sessions. Serialize the snapshot+run so each
# hermes session is unambiguously the one just created, then match by recorded model.
_HERMES_LOCK = threading.Lock()

# codex (ChatGPT-OAuth) rate-limits concurrent requests against the single shared
# token (and the live Paperclip fleet competes for it too): parallel `codex exec`
# calls hang until the timeout. Serialize them — serial codex calls return in seconds.
_CODEX_LOCK = threading.Lock()

# agy is a heavy 142MB binary; cap concurrent antigravity calls on the shared Mac.
_AGY_SEM = threading.BoundedSemaphore(2)


def run_model(prompt, model_row, adapters_cfg, timeout_sec):
    """Dispatch to the right adapter by model_row['adapter']."""
    guard = benchlib.first_model_guard(model_row)
    if guard:
        r = benchlib.empty_result()
        r["model"] = model_row.get("id") or model_row.get("model_arg")
        r["error"] = (
            f"model blocked by TSBC model guard {guard.get('id', 'model-guard')}"
            + (f" until {guard.get('until')}" if guard.get("until") else "")
        )
        r["skipped"] = True
        r["skipReason"] = "model_guard"
        return _attach_request_metadata(r, model_row)
    adapter = model_row["adapter"]
    extra = list((adapters_cfg.get(adapter) or {}).get("extra_args", []))
    effort = benchlib.model_effort_label(model_row)
    if effort != "cli_default" and adapter == "claude":
        extra += ["--effort", effort]
    # per-model reasoning effort (matches how Paperclip's codex adapter runs spark:
    # `-c model_reasoning_effort="high"`).
    if effort != "cli_default" and adapter == "codex":
        extra += ["-c", f'model_reasoning_effort="{effort}"']
    if effort != "cli_default" and adapter == "grok":
        extra += ["--reasoning-effort", effort]
    fn = {
        "claude": _run_claude,
        "codex": _run_codex,
        "gemini": _run_gemini,
        "grok": _run_grok,
        "hermes": _run_hermes,
        "antigravity": _run_antigravity,
    }.get(adapter)
    if fn is None:
        r = benchlib.empty_result()
        r["error"] = f"unknown adapter {adapter!r}"
        return _attach_request_metadata(r, model_row)
    return _attach_request_metadata(
        fn(prompt, model_row.get("model_arg"), extra, timeout_sec, effort=effort),
        model_row,
    )


def _attach_request_metadata(result, model_row):
    result["requestedModelId"] = model_row.get("id")
    result["requestedModelArg"] = model_row.get("model_arg")
    result["benchAdapterType"] = model_row.get("adapter")
    result.setdefault("servedModelVerified", False)
    result.setdefault("servedModelMismatch", False)
    return result


# --------------------------------------------------------------------------

def _exec(cmd, timeout_sec, cwd, stdin=None, env=None):
    """Run argv (no shell), return (returncode, stdout, stderr, wall_ms, timed_out)."""
    run_env = {**os.environ, **env} if env else None
    t0 = time.time()
    try:
        proc = subprocess.run(
            cmd, cwd=cwd, input=stdin, capture_output=True, text=True,
            timeout=timeout_sec, env=run_env,
        )
        wall = int((time.time() - t0) * 1000)
        return proc.returncode, proc.stdout, proc.stderr, wall, False
    except subprocess.TimeoutExpired as e:
        wall = int((time.time() - t0) * 1000)
        out = e.stdout or ""
        err = e.stderr or ""
        if isinstance(out, bytes):
            out = out.decode("utf-8", "replace")
        if isinstance(err, bytes):
            err = err.decode("utf-8", "replace")
        return None, out, err, wall, True


def _tail(s, n=600):
    s = (s or "").strip()
    return s[-n:] if len(s) > n else s


# --------------------------------------------------------------------------
# claude
# --------------------------------------------------------------------------

def _run_claude(prompt, model_arg, extra, timeout_sec, effort=None):
    r = benchlib.empty_result()
    with tempfile.TemporaryDirectory(prefix="bench-claude-") as cwd:
        # Pass the prompt on STDIN, not as a `-p <arg>`: the claude CLI exits 1 on large
        # prompt arguments (~2k+ chars), which silently failed every with-skills/agent-file
        # cell. STDIN handles any size and keeps the prompt out of the logged argv.
        cmd = ["claude", "-p", "--output-format", "json"]
        if model_arg:
            cmd += ["--model", model_arg]
        cmd += list(extra)
        r["cmd"] = cmd[:4] + (["--model", model_arg] if model_arg else [])
        rc, out, err, wall, timed_out = _exec(cmd, timeout_sec, cwd, stdin=prompt)
        r["wallMs"] = wall
        r["stderrTail"] = _tail(err)
        if timed_out:
            r["error"] = "timeout"
            return r
        j = benchlib._try_json(out.strip()) or benchlib.extract_json(out)
        if not isinstance(j, dict):
            r["error"] = f"claude: unparseable output (rc={rc})"
            r["output"] = out[:2000]
            return r
        r["output"] = j.get("result") or ""
        if j.get("is_error"):
            r["error"] = f"claude reported error: {str(j.get('result'))[:200]}"
        usage = j.get("usage") or {}
        inp = usage.get("input_tokens")
        cache = (usage.get("cache_read_input_tokens") or 0) + (usage.get("cache_creation_input_tokens") or 0)
        outp = usage.get("output_tokens")
        r["inputTokens"] = (inp or 0) + cache if (inp is not None or cache) else None
        r["cacheTokens"] = cache or None
        r["outputTokens"] = outp
        if r["inputTokens"] is not None or outp is not None:
            r["totalTokens"] = (r["inputTokens"] or 0) + (outp or 0)
        r["costUsd"] = j.get("total_cost_usd")
        mu = j.get("modelUsage") or {}
        reported_model = j.get("model")
        served_verified = bool(reported_model)
        if not reported_model:
            # Claude can emit auxiliary modelUsage entries (for example a tiny
            # Haiku meter) alongside the requested model while leaving the
            # top-level `model` field blank. Prefer the explicitly requested
            # model when it is present in modelUsage instead of taking the
            # first map key.
            if model_arg and model_arg in mu:
                reported_model = model_arg
                served_verified = True
            elif len(mu) == 1:
                reported_model = next(iter(mu))
                served_verified = True
        r["model"] = reported_model or model_arg
        r["servedModelVerified"] = served_verified
        r["ok"] = bool(r["output"]) and not r["error"]
        return r


# --------------------------------------------------------------------------
# codex
# --------------------------------------------------------------------------

def _run_codex(prompt, model_arg, extra, timeout_sec, effort=None):
    r = benchlib.empty_result()
    with tempfile.TemporaryDirectory(prefix="bench-codex-") as cwd:
        last = Path(cwd) / "_last.txt"
        # Pass the prompt on STDIN (`exec -` reads instructions from stdin), not as a positional
        # argv. With-skills/agent-file prompts wrap blocks in "--- BEGIN ... ---" markers; codex's
        # clap parser reads the leading "--" as an unknown flag and exits rc=2 BEFORE the model runs
        # (verified 2026-06-22 — this, not an agentic-derail, was the "codex hard-fails on large
        # prompts" signal). stdin sidesteps arg-parsing entirely and keeps the prompt out of argv.
        cmd = ["codex", "exec", "-", "--json", "-o", str(last)]
        if model_arg:
            cmd += ["-m", model_arg]
        cmd += list(extra)
        r["cmd"] = ["codex", "exec", "-", "--json"] + (["-m", model_arg] if model_arg else [])
        with _CODEX_LOCK:  # serialize: concurrent ChatGPT-OAuth codex calls hang
            rc, out, err, wall, timed_out = _exec(cmd, timeout_sec, cwd, stdin=prompt)
        r["wallMs"] = wall
        r["stderrTail"] = _tail(err)
        # final message: prefer -o file, else last agent_message event on stdout
        if last.exists():
            r["output"] = last.read_text(errors="replace").strip()
        # parse JSONL events for output (fallback) + cumulative token usage
        events = []
        for line in out.splitlines():
            line = line.strip()
            if not line:
                continue
            ev = benchlib._try_json(line)
            if ev is not None:
                events.append(ev)
        if not r["output"]:
            r["output"] = _codex_last_message(events)
        # cumulative usage: take the LAST token node found across events
        nodes = []
        for ev in events:
            nodes += benchlib.find_token_nodes(ev)
        if nodes:
            n = nodes[-1]
            r["inputTokens"] = n["input"]
            r["outputTokens"] = n["output"]
            r["totalTokens"] = n["total"] or ((n["input"] or 0) + (n["output"] or 0)) or None
        reported_model = _codex_model(events)
        r["model"] = reported_model or model_arg
        r["servedModelVerified"] = bool(reported_model)
        if timed_out:
            r["error"] = "timeout"
        elif rc not in (0, None) and not r["output"]:
            r["error"] = f"codex: rc={rc}"
        r["ok"] = bool(r["output"]) and not r["error"]
        return r


def _codex_last_message(events):
    msg = ""
    for ev in events:
        t = str(ev.get("type", "")).lower()
        if "message" in t or t.endswith("completed"):
            for key in ("message", "text", "content", "last_agent_message"):
                v = ev.get(key)
                if isinstance(v, str) and v.strip():
                    msg = v.strip()
            item = ev.get("item")
            if isinstance(item, dict):
                for key in ("text", "message", "content"):
                    v = item.get(key)
                    if isinstance(v, str) and v.strip():
                        msg = v.strip()
    return msg


def _codex_model(events):
    for ev in events:
        for key in ("model", "model_slug"):
            v = ev.get(key)
            if isinstance(v, str) and v:
                return v
        info = ev.get("info") or ev.get("session") or {}
        if isinstance(info, dict):
            for key in ("model", "model_slug"):
                v = info.get(key)
                if isinstance(v, str) and v:
                    return v
    return None


# --------------------------------------------------------------------------
# antigravity (agy) — Google's supported replacement for the retired gemini CLI
# --------------------------------------------------------------------------

_AGY_SELF_REPORT_PROMPT = "State your exact model name and version number, nothing else."
_MODEL_MODIFIER_TOKENS = {
    "low",
    "medium",
    "med",
    "high",
    "thinking",
    "reasoning",
    "non",
    "version",
    "model",
}


def _model_identity_tokens(value):
    tokens = re.findall(r"[a-z]+|\d+[a-z]?", str(value or "").lower())
    return [token for token in tokens if token not in _MODEL_MODIFIER_TOKENS]


def _served_model_matches_pin(pin, served_model):
    pin_tokens = set(_model_identity_tokens(pin))
    served_tokens = set(_model_identity_tokens(served_model))
    if not pin_tokens or not served_tokens:
        return False
    return pin_tokens.issubset(served_tokens) or served_tokens.issubset(pin_tokens)


def _parse_agy_json_response(stdout):
    parsed = benchlib._try_json((stdout or "").strip()) or benchlib.extract_json(stdout)
    if not isinstance(parsed, dict):
        return None, None, None, None
    response = (
        parsed.get("response")
        or parsed.get("result")
        or parsed.get("text")
        or parsed.get("output")
        or ""
    )
    usage = parsed.get("usage") or {}
    inp = usage.get("input_tokens") or usage.get("prompt_tokens") or usage.get("input")
    outp = usage.get("output_tokens") or usage.get("completion_tokens") or usage.get("output")
    return str(response or "").strip(), inp, outp, parsed


def _run_antigravity_self_report(model_arg, timeout_sec, cwd):
    r = {
        "ok": False,
        "servedModel": None,
        "inputTokens": None,
        "outputTokens": None,
        "wallMs": None,
        "error": None,
        "stderrTail": None,
        "raw": None,
    }
    cmd = ["agy", "--print", _AGY_SELF_REPORT_PROMPT, "--output-format", "json"]
    if model_arg:
        cmd += ["--model", model_arg]
    probe_timeout = max(30, min(int(timeout_sec or 120), 180))
    rc, out, err, wall, timed_out = _exec(cmd, probe_timeout, cwd)
    r["wallMs"] = wall
    r["stderrTail"] = _tail(err)
    if timed_out:
        r["error"] = "timeout"
        return r
    served, inp, outp, raw = _parse_agy_json_response(out)
    r["raw"] = raw
    r["inputTokens"] = inp
    r["outputTokens"] = outp
    if not served:
        agy_error = ""
        if isinstance(raw, dict):
            agy_error = str(raw.get("error") or raw.get("status") or "").strip()
        if agy_error:
            r["error"] = f"agy self-report: {agy_error} (rc={rc})"
        else:
            r["error"] = f"agy self-report: unparseable output (rc={rc})"
        return r
    r["servedModel"] = served
    if rc not in (0, None):
        r["error"] = f"agy self-report: rc={rc}: {_tail(err, 160)}"
        return r
    r["ok"] = True
    return r


def _run_antigravity(prompt, model_arg, extra, timeout_sec, effort=None):
    """Antigravity (`agy`) CLI. Selects a model by its display-name string, e.g.
    'Gemini 3.5 Flash (Medium)'. Print mode returns plain text only (no usage JSON),
    so tokens are ESTIMATED and flagged. Runs in a neutralized temp CWD. agy is a heavy
    142MB binary; cap concurrency on the shared Mac via _AGY_SEM."""
    r = benchlib.empty_result()
    with _AGY_SEM, tempfile.TemporaryDirectory(prefix="bench-agy-") as cwd:
        probe = _run_antigravity_self_report(model_arg, timeout_sec, cwd)
        r["servedModelSelfReport"] = probe.get("servedModel")
        r["servedModelVerified"] = False
        r["selfReportWallMs"] = probe.get("wallMs")
        r["selfReportInputTokens"] = probe.get("inputTokens")
        r["selfReportOutputTokens"] = probe.get("outputTokens")
        if not probe.get("ok"):
            detail = probe.get("error") or "agy self-report failed"
            r["error"] = detail
            r["failureReason"] = "served_model_unverified"
            r["stderrTail"] = probe.get("stderrTail")
            r["wallMs"] = probe.get("wallMs")
            if antigravity_is_quota_error(detail + " " + (probe.get("stderrTail") or "")):
                r["quotaError"] = True
                r["failureReason"] = "quota"
            return r
        served_model = probe.get("servedModel")
        r["model"] = served_model
        if not _served_model_matches_pin(model_arg, served_model):
            r["error"] = f"served_model_mismatch: requested {model_arg}, self-reported {served_model}"
            r["failureReason"] = "served_model_mismatch"
            r["servedModelMismatch"] = True
            r["wallMs"] = probe.get("wallMs")
            return r
        r["servedModelVerified"] = True
        cmd = ["agy", "-p", prompt]
        if model_arg:
            cmd += ["--model", model_arg]
        cmd += list(extra)
        r["cmd"] = ["agy", "-p", "<prompt>"] + (["--model", model_arg] if model_arg else [])
        rc, out, err, wall, timed_out = _exec(cmd, timeout_sec, cwd)
        r["taskWallMs"] = wall
        r["wallMs"] = (probe.get("wallMs") or 0) + wall
        r["stderrTail"] = _tail(err)
        r["output"] = (out or "").strip()
        if timed_out:
            r["error"] = "timeout"
        elif rc not in (0, None) and not r["output"]:
            r["error"] = f"agy: rc={rc}: {_tail(err, 160)}"
        if r["error"] and antigravity_is_quota_error((err or "") + (out or "")):
            r["quotaError"] = True
            r["failureReason"] = "quota"
        r["model"] = served_model
        # agy print mode emits no usage JSON -> estimate tokens (flagged)
        r["inputTokens"] = benchlib.estimate_tokens(prompt)
        r["outputTokens"] = benchlib.estimate_tokens(r["output"])
        r["tokensEstimated"] = True
        r["totalTokens"] = (r["inputTokens"] or 0) + (r["outputTokens"] or 0) or None
        r["ok"] = bool(r["output"]) and not r["error"]
        return r


# agy quota/auth-failure signatures — when these show up the lane is rate-limited or the
# weekly Gemini quota is spent, so the caller should STOP rather than keep burning attempts.
_AGY_QUOTA_RE = re.compile(
    r"quota|rate[ _-]?limit|ineligible\s*tier|ineligibletier|resource[ _-]?exhausted|"
    r"too many requests|429|unauthenticated|unauthorized|permission denied|\b401\b|\b403\b",
    re.IGNORECASE,
)


def antigravity_is_quota_error(text):
    """True if agy stderr/stdout looks like a quota/rate-limit/auth failure (lane should pause)."""
    return bool(_AGY_QUOTA_RE.search(text or ""))


def run_antigravity_agentic(prompt, model_arg, extra, timeout_sec, cwd, skip_permissions=True):
    """Antigravity AGENTIC frame — the production-faithful path (mirrors the live
    antigravity_local adapter, packages/adapters/antigravity-local/src/server/execute.ts).

    Unlike _run_antigravity (single-shot, fresh empty cwd, no tools), this runs agy in a
    PREPARED `cwd` where the caller has already staged the role's skills as files under
    .paperclip/skills/<name>/, and passes --dangerously-skip-permissions so unattended
    tool use does not block on the headless permission gate. The prompt is SMALL (agent-file
    + a 'skills are in .paperclip/skills' note + the task), so the agent reads the skill files
    on demand instead of being fed ~65k chars of concatenated skill bodies — which is what
    hangs agy print mode. Tokens are estimated (print mode emits no usage JSON) and flagged.

    Sets r['quotaError']=True when the failure looks like a quota/rate-limit/auth problem, so
    the orchestrator can halt the lane instead of hammering a spent weekly Gemini quota."""
    r = benchlib.empty_result()
    with _AGY_SEM:
        probe = _run_antigravity_self_report(model_arg, timeout_sec, cwd)
        r["servedModelSelfReport"] = probe.get("servedModel")
        r["servedModelVerified"] = False
        r["selfReportWallMs"] = probe.get("wallMs")
        r["selfReportInputTokens"] = probe.get("inputTokens")
        r["selfReportOutputTokens"] = probe.get("outputTokens")
        if not probe.get("ok"):
            detail = probe.get("error") or "agy self-report failed"
            r["error"] = detail
            r["failureReason"] = "served_model_unverified"
            r["stderrTail"] = probe.get("stderrTail")
            r["wallMs"] = probe.get("wallMs")
            if antigravity_is_quota_error(detail + " " + (probe.get("stderrTail") or "")):
                r["quotaError"] = True
                r["failureReason"] = "quota"
            return r
        served_model = probe.get("servedModel")
        r["model"] = served_model
        if not _served_model_matches_pin(model_arg, served_model):
            r["error"] = f"served_model_mismatch: requested {model_arg}, self-reported {served_model}"
            r["failureReason"] = "served_model_mismatch"
            r["servedModelMismatch"] = True
            r["wallMs"] = probe.get("wallMs")
            return r
        r["servedModelVerified"] = True
        cmd = ["agy", "-p", prompt]
        if model_arg:
            cmd += ["--model", model_arg]
        if skip_permissions:
            cmd += ["--dangerously-skip-permissions"]
        cmd += list(extra)
        r["cmd"] = (["agy", "-p", "<prompt>"]
                    + (["--dangerously-skip-permissions"] if skip_permissions else [])
                    + (["--model", model_arg] if model_arg else []))
        rc, out, err, wall, timed_out = _exec(cmd, timeout_sec, cwd)
        r["taskWallMs"] = wall
        r["wallMs"] = (probe.get("wallMs") or 0) + wall
        r["stderrTail"] = _tail(err)
        r["output"] = (out or "").strip()
        if timed_out:
            r["error"] = "timeout"
        elif rc not in (0, None) and not r["output"]:
            r["error"] = f"agy: rc={rc}: {_tail(err, 160)}"
        if r["error"] and antigravity_is_quota_error((err or "") + (out or "")):
            r["quotaError"] = True
            r["failureReason"] = "quota"
        r["model"] = served_model
        r["inputTokens"] = benchlib.estimate_tokens(prompt)
        r["outputTokens"] = benchlib.estimate_tokens(r["output"])
        r["tokensEstimated"] = True
        r["totalTokens"] = (r["inputTokens"] or 0) + (r["outputTokens"] or 0) or None
        r["ok"] = bool(r["output"]) and not r["error"]
        return r


# --------------------------------------------------------------------------
# gemini
# --------------------------------------------------------------------------

def _run_gemini(prompt, model_arg, extra, timeout_sec, effort=None):
    r = benchlib.empty_result()
    with tempfile.TemporaryDirectory(prefix="bench-gemini-") as cwd:
        cmd = ["gemini", "-p", prompt, "-o", "json"]
        if model_arg:
            cmd += ["-m", model_arg]
        cmd += list(extra)
        r["cmd"] = ["gemini", "-p", "<prompt>", "-o", "json"] + (["-m", model_arg] if model_arg else [])
        # neutralized temp CWD is "untrusted" -> gemini refuses headless without this
        rc, out, err, wall, timed_out = _exec(
            cmd, timeout_sec, cwd, env={"GEMINI_CLI_TRUST_WORKSPACE": "true"})
        r["wallMs"] = wall
        r["stderrTail"] = _tail(err)
        if timed_out:
            r["error"] = "timeout"
            return r
        j = benchlib._try_json(out.strip()) or benchlib.extract_json(out)
        if not isinstance(j, dict):
            r["error"] = f"gemini: unparseable output (rc={rc})"
            r["output"] = out[:2000]
            return r
        r["output"] = (j.get("response") or j.get("text") or "").strip()
        model_name, inp, outp, tot = _gemini_usage(j.get("stats") or {})
        r["model"] = model_name or model_arg
        r["servedModelVerified"] = bool(model_name)
        r["inputTokens"] = inp
        r["outputTokens"] = outp
        r["totalTokens"] = tot
        r["ok"] = bool(r["output"])
        if not r["output"]:
            r["error"] = "gemini: empty response"
        return r


def _gemini_usage(stats):
    """
    gemini -o json nests stats.models.<name>.tokens with EXACT fields:
      input/prompt, candidates, thoughts, total, cached, tool.
    The same block is duplicated under roles.main.tokens, so read it directly
    (do NOT walk+sum, which double-counts). output = total - input (candidates +
    thoughts), which captures reasoning tokens too.
    """
    models = stats.get("models")
    if not isinstance(models, dict) or not models:
        return None, None, None, None
    # pick the model that actually did work (max total tokens)
    def _tot(v):
        return ((v or {}).get("tokens") or {}).get("total") or 0
    name = max(models, key=lambda k: _tot(models[k]))
    tokens = (models[name] or {}).get("tokens") or {}
    inp = tokens.get("input") if tokens.get("input") is not None else tokens.get("prompt")
    tot = tokens.get("total")
    if tot is None:
        cand = tokens.get("candidates") or 0
        th = tokens.get("thoughts") or 0
        tot = (inp or 0) + cand + th if inp is not None else None
    outp = (tot - inp) if (tot is not None and inp is not None) else tokens.get("candidates")
    return name, inp, outp, tot


# --------------------------------------------------------------------------
# grok (direct Grok Build / grok.com CLI)
# --------------------------------------------------------------------------

def _grok_error_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("message", "error", "detail", "code"):
            text = value.get(key)
            if isinstance(text, str) and text.strip():
                return text
        try:
            return json.dumps(value)
        except Exception:
            return ""
    return ""


def _parse_grok_jsonl(stdout):
    text_parts = []
    error_message = None
    stop_reason = None
    request_id = None
    session_id = None
    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        event = benchlib._try_json(line)
        if not isinstance(event, dict):
            continue
        event_type = str(event.get("type") or "").strip()
        if event_type == "text":
            data = event.get("data")
            if isinstance(data, str) and data:
                text_parts.append(data)
            continue
        if event_type == "end":
            stop_reason = str(event.get("stopReason") or stop_reason or "").strip() or stop_reason
            request_id = str(event.get("requestId") or request_id or "").strip() or request_id
            session_id = str(event.get("sessionId") or session_id or "").strip() or session_id
            continue
        if event_type == "error":
            text = _grok_error_text(
                event.get("error") or event.get("message") or event.get("detail") or event.get("data")
            ).strip()
            if text:
                error_message = text
    return {
        "summary": "".join(text_parts).strip(),
        "errorMessage": error_message,
        "stopReason": stop_reason,
        "requestId": request_id,
        "sessionId": session_id,
    }


def _run_grok(prompt, model_arg, extra, timeout_sec, effort=None):
    r = benchlib.empty_result()
    with tempfile.TemporaryDirectory(prefix="bench-grok-") as cwd:
        prompt_path = Path(cwd) / "prompt.txt"
        prompt_path.write_text(prompt)
        cmd = ["grok", "--prompt-file", str(prompt_path), "--output-format", "streaming-json"]
        if model_arg:
            cmd += ["--model", model_arg]
        cmd += list(extra)
        r["cmd"] = ["grok", "--prompt-file", "<prompt-file>", "--output-format", "streaming-json"] + (
            ["--model", model_arg] if model_arg else []
        )
        rc, out, err, wall, timed_out = _exec(cmd, timeout_sec, cwd)
        parsed = _parse_grok_jsonl(out or "")
        r["wallMs"] = wall
        r["stderrTail"] = _tail(err)
        r["output"] = parsed["summary"]
        r["model"] = model_arg
        r["servedModelVerified"] = False
        r["inputTokens"] = benchlib.estimate_tokens(prompt)
        r["outputTokens"] = benchlib.estimate_tokens(r["output"])
        r["totalTokens"] = (r["inputTokens"] or 0) + (r["outputTokens"] or 0) or None
        r["tokensEstimated"] = True
        stop_reason = str(parsed.get("stopReason") or "").strip()
        parsed_error = str(parsed.get("errorMessage") or "").strip()
        if timed_out:
            r["error"] = "timeout"
        elif parsed_error and stop_reason != "EndTurn":
            r["error"] = parsed_error
        elif rc not in (0, None) and not r["output"]:
            r["error"] = parsed_error or _tail(err, n=240) or f"grok: rc={rc}"
        r["ok"] = bool(r["output"]) and not r["error"]
        return r


# --------------------------------------------------------------------------
# hermes (grok via xAI OAuth)
# --------------------------------------------------------------------------

_SESS_ID_RE = re.compile(r"\b(\d{8}_\d{6}_[0-9a-f]{4,})\b")
_HERMES_REASONING_RE = re.compile(r"(^\s*reasoning_effort:\s*).*$", re.MULTILINE)


def _hermes_session_ids(env=None):
    try:
        proc = subprocess.run(["hermes", "sessions", "list"],
                              capture_output=True, text=True, timeout=30,
                              env={**os.environ, **env} if env else None)
    except Exception:
        return []
    return _SESS_ID_RE.findall(proc.stdout)


def _prepare_hermes_home(reasoning_effort):
    src = Path.home() / ".hermes"
    tmp_home = tempfile.TemporaryDirectory(prefix="bench-hermes-home-")
    dst = Path(tmp_home.name)
    for name in ("config.yaml", "auth.json", ".env"):
        src_path = src / name
        if src_path.exists():
            shutil.copy2(src_path, dst / name)
    auth_dir = src / "auth"
    if auth_dir.exists():
        shutil.copytree(auth_dir, dst / "auth")
    cfg_path = dst / "config.yaml"
    cfg = cfg_path.read_text()
    patched, n = _HERMES_REASONING_RE.subn(rf"\1{reasoning_effort}", cfg, count=1)
    if n != 1:
        marker = "agent:\n"
        if marker not in cfg:
            tmp_home.cleanup()
            raise RuntimeError("could not locate Hermes agent config block for reasoning_effort override")
        patched = cfg.replace(marker, marker + f"  reasoning_effort: {reasoning_effort}\n", 1)
    cfg_path.write_text(patched)
    return tmp_home


def _run_hermes(prompt, model_arg, extra, timeout_sec, effort=None):
    r = benchlib.empty_result()
    hermes_home = None
    env = None
    if effort and effort != "cli_default":
        hermes_home = _prepare_hermes_home(effort)
        env = {"HERMES_HOME": hermes_home.name}
    # serialize snapshot+run so the new-session diff is unambiguous (see _HERMES_LOCK)
    try:
        with _HERMES_LOCK:
            before = set(_hermes_session_ids(env))
            with tempfile.TemporaryDirectory(prefix="bench-hermes-") as cwd:
                cmd = ["hermes", "-z", prompt]
                if model_arg:
                    cmd += ["-m", model_arg]
                cmd += list(extra)
                r["cmd"] = ["hermes", "-z", "<prompt>"] + (["-m", model_arg] if model_arg else [])
                rc, out, err, wall, timed_out = _exec(cmd, timeout_sec, cwd, env=env)
                r["wallMs"] = wall
                r["stderrTail"] = _tail(err)
                r["output"] = (out or "").strip()
                if timed_out:
                    r["error"] = "timeout"
                elif rc not in (0, None) and not r["output"]:
                    r["error"] = f"hermes: rc={rc}"
            after = _hermes_session_ids(env)
            new_ids = sorted([s for s in after if s not in before], reverse=True)  # newest first

        # identify the run's session (export can happen outside the lock — id is fixed now)
        sess_model = inp = outp = None
        fallback = None
        for sid in new_ids:
            m, i, o = _hermes_export_session(sid, env=env)
            if fallback is None and (i is not None or o is not None):
                fallback = (m, i, o)
            if model_arg and m and _model_matches(model_arg, m):
                sess_model, inp, outp = m, i, o
                break
        if inp is None and outp is None and fallback:  # no model match -> best new session
            sess_model, inp, outp = fallback

        r["model"] = sess_model or model_arg
        r["servedModelVerified"] = bool(sess_model)
        if inp is None and outp is None:
            # last resort: estimate so cross-lane efficiency still has a number (flagged)
            r["inputTokens"] = benchlib.estimate_tokens(prompt)
            r["outputTokens"] = benchlib.estimate_tokens(r["output"])
            r["tokensEstimated"] = True
        else:
            r["inputTokens"] = inp
            r["outputTokens"] = outp
        r["totalTokens"] = (r["inputTokens"] or 0) + (r["outputTokens"] or 0) or None
        r["ok"] = bool(r["output"]) and not r["error"]
        return r
    finally:
        if hermes_home is not None:
            hermes_home.cleanup()


def _model_matches(want, got):
    """grok-4.20-0309-reasoning recorded as 'grok-4.20-...' etc. Match on the family stem."""
    want = str(want).lower()
    got = str(got).lower()
    if want == got or want in got or got in want:
        return True
    stem = want.split("-0309")[0]  # grok-4.20-0309-reasoning -> grok-4.20
    return stem in got


def _hermes_export_session(sess_id, env=None):
    """Export one session as JSONL; return (model_seen, input_tokens, output_tokens)."""
    try:
        proc = subprocess.run(
            ["hermes", "sessions", "export", "--session-id", sess_id, "-"],
            capture_output=True, text=True, timeout=60,
            env={**os.environ, **env} if env else None,
        )
    except Exception:
        return None, None, None
    total_in = total_out = 0
    found = False
    model_seen = None
    for line in proc.stdout.splitlines():
        ev = benchlib._try_json(line.strip())
        if ev is None:
            continue
        if model_seen is None:
            model_seen = _find_model(ev)
        for n in benchlib.find_token_nodes(ev):
            if n["input"] is not None:
                total_in += n["input"]
                found = True
            if n["output"] is not None:
                total_out += n["output"]
                found = True
    if not found:
        return model_seen, None, None
    return model_seen, (total_in or None), (total_out or None)


def _find_model(obj):
    """Pull a model string out of a session event (looks for grok-* / known model keys)."""
    found = []

    def visit(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if str(k).lower() in ("model", "model_name", "model_id", "modelslug") and isinstance(v, str):
                    found.append(v)
                visit(v)
        elif isinstance(node, list):
            for v in node:
                visit(v)

    visit(obj)
    for m in found:
        if "grok" in m.lower():
            return m
    return found[0] if found else None
