#!/usr/bin/env python3
"""
benchlib.py — shared helpers for the Paperclip model benchmark (#15).

Pure stdlib (no pip deps — keeps it runnable on the shared Mac without the
ddgs/brave install friction noted elsewhere). Holds: paths, config loading,
suite loading/validation, JSON extraction, and a normalized run-result shape
that mirrors Paperclip's usage_json ({inputTokens, outputTokens, model, costUsd})
so downstream tooling (agent-scorecard, tiering #9) speaks the same dialect.
"""

import hashlib
import json
import os
import re
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
RESULTS_DIR = ROOT / "results"
CONFIG_PATH = ROOT / "config.json"
MODEL_HOLDS_PATH = ROOT / ".tsbc-model-holds.json"


# --------------------------------------------------------------------------
# config + suites
# --------------------------------------------------------------------------

def load_config(path=None):
    path = Path(path) if path else CONFIG_PATH
    with open(path) as f:
        cfg = json.load(f)
    # strip _comment keys recursively for cleanliness (they're docs, not data)
    return cfg


def min_success_rate_for_quality(cfg=None):
    cfg = cfg or load_config()
    try:
        raw = (cfg.get("recommendation", {}) or {}).get("min_success_rate_for_quality", 0.8)
        val = float(raw)
    except (TypeError, ValueError):
        val = 0.8
    return max(0.0, min(1.0, val))


def success_rate_meets_quality_floor(success_rate, cfg=None):
    return success_rate is not None and success_rate >= min_success_rate_for_quality(cfg)


def configured_reps(cfg=None):
    cfg = cfg or load_config()
    try:
        raw = (cfg.get("run", {}) or {}).get("reps", 3)
        val = int(raw)
    except (TypeError, ValueError):
        val = 3
    return max(1, val)


def min_reps_for_decision(cfg=None):
    cfg = cfg or load_config()
    try:
        raw = (cfg.get("recommendation", {}) or {}).get("min_reps_for_decision", 3)
        val = int(raw)
    except (TypeError, ValueError):
        val = 3
    return max(1, val)


def reps_meet_decision_floor(reps, cfg=None):
    try:
        reps_value = int(reps)
    except (TypeError, ValueError):
        reps_value = 1
    return reps_value >= min_reps_for_decision(cfg)


def incumbent_baseline_for_role(cfg, role):
    baselines = (cfg.get("incumbent_baselines", {}) or {})
    row = baselines.get(role)
    if not row:
        return None
    if row.get("required", True) is False:
        return None
    return row


def model_denylist(cfg=None):
    """Return permanent config-level model denials.

    Unlike .tsbc-model-holds.json, this is not time-bound. Use it for pins that
    have proven unsafe to benchmark until an explicit config edit removes them.
    """
    cfg = cfg or load_config()
    raw_entries = cfg.get("model_denylist", [])
    if not isinstance(raw_entries, list):
        return []
    entries = []
    for entry in raw_entries:
        if isinstance(entry, str):
            entries.append({"id": entry, "models": [entry], "_guard_type": "denylist"})
        elif isinstance(entry, dict):
            normalized = dict(entry)
            normalized.setdefault("_guard_type", "denylist")
            entries.append(normalized)
    return entries


def _listify(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _model_identity_values(model_row):
    values = set()
    for key in ("id", "model_id", "model_arg"):
        value = str(model_row.get(key) or "").strip().lower()
        if value:
            values.add(value)
    model_arg = str(model_row.get("model_arg") or "").strip().lower()
    effort = model_effort_label(model_row).strip().lower()
    if model_arg and effort and effort != "cli_default":
        values.add(f"{model_arg}-{effort}")
    return values


def _model_matches_guard(model_row, guard):
    values = _model_identity_values(model_row)
    adapter = str(model_row.get("adapter") or "").lower()
    lane = str(model_row.get("lane") or "").lower()

    if guard.get("adapter") and adapter == str(guard["adapter"]).lower():
        return True
    if guard.get("lane") and lane == str(guard["lane"]).lower():
        return True

    prefixes = [str(p).lower() for p in _listify(guard.get("prefix")) + _listify(guard.get("prefixes")) if p]
    if prefixes and any(any(value.startswith(prefix) for value in values) for prefix in prefixes):
        return True

    guarded_models = []
    for key in ("models", "model_args", "ids"):
        guarded_models.extend(str(m).strip().lower() for m in _listify(guard.get(key)) if m)
    return bool(guarded_models and any(value in guarded_models for value in values))


def _parse_datetime(value):
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def active_model_holds(now=None):
    """Return active TSBC model holds from .tsbc-model-holds.json.

    Holds are operational guardrails, not benchmark data. They let TSBC park a
    model family temporarily without deleting the normal benchmark config.
    """
    now = now or datetime.now(timezone.utc)
    try:
        with open(MODEL_HOLDS_PATH) as f:
            data = json.load(f)
    except FileNotFoundError:
        return []
    except Exception:
        return []
    holds = data.get("holds", data if isinstance(data, list) else [])
    active = []
    for hold in holds:
        if not isinstance(hold, dict):
            continue
        until = _parse_datetime(hold.get("until"))
        if until is not None and now >= until:
            continue
        normalized = dict(hold)
        normalized.setdefault("_guard_type", "hold")
        active.append(normalized)
    return active


def _model_matches_hold(model_row, hold):
    adapter = str(model_row.get("adapter") or "").lower()
    lane = str(model_row.get("lane") or "").lower()
    family = str(hold.get("family") or "").lower()
    values = _model_identity_values(model_row)
    if family == "claude" and (
        adapter == "claude"
        or lane == "claude"
        or any(value.startswith("claude") for value in values)
    ):
        return True
    return _model_matches_guard(model_row, hold)


def first_model_deny(model_row, cfg=None):
    for deny in model_denylist(cfg):
        if _model_matches_guard(model_row, deny):
            return deny
    return None


def first_active_model_hold(model_row):
    for hold in active_model_holds():
        if _model_matches_hold(model_row, hold):
            return hold
    return None


def first_model_guard(model_row, cfg=None):
    return first_model_deny(model_row, cfg) or first_active_model_hold(model_row)


def filter_models_for_active_holds(models, cfg=None):
    kept = []
    skipped = []
    for model in models:
        guard = first_model_guard(model, cfg)
        if guard:
            skipped.append((model, guard))
        else:
            kept.append(model)
    return kept, skipped


def format_model_hold_skip(skipped):
    if not skipped:
        return ""
    by_hold = {}
    for model, hold in skipped:
        key = (hold.get("id") or hold.get("reason") or "model-hold", hold.get("until"), hold.get("reason"))
        by_hold.setdefault(key, []).append(model.get("id") or model.get("model_id") or "?")
    lines = []
    for (hold_id, until, reason), model_ids in by_hold.items():
        bits = [f"TSBC model guard {hold_id}: skipped {', '.join(model_ids)}"]
        if until:
            bits.append(f"until {until}")
        if reason:
            bits.append(str(reason))
        lines.append(" - ".join(bits))
    return "\n".join(lines)


def load_suite(role):
    """Load and lightly validate one role's suite.json."""
    suite_path = ROOT / role / "suite.json"
    if not suite_path.exists():
        raise FileNotFoundError(f"no suite for role {role!r}: {suite_path}")
    with open(suite_path) as f:
        suite = json.load(f)
    suite.setdefault("role", role)
    tasks = suite.get("tasks", [])
    seen = set()
    for t in tasks:
        for req in ("id", "prompt"):
            if req not in t:
                raise ValueError(f"{role} suite: task missing {req!r}: {t.get('id', t)}")
        if t["id"] in seen:
            raise ValueError(f"{role} suite: duplicate task id {t['id']!r}")
        seen.add(t["id"])
        t.setdefault("rubric", {})
    return suite


def load_all_suites(roles):
    return {role: load_suite(role) for role in roles}


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def file_sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def model_effort_label(model_row):
    effort = str(model_row.get("effort") or model_row.get("reasoning_effort") or "").strip()
    return effort or "cli_default"


# --------------------------------------------------------------------------
# normalized run result
# --------------------------------------------------------------------------

def empty_result():
    """The canonical shape every adapter returns. Mirrors Paperclip usage_json."""
    return {
        "ok": False,
        "output": "",
        "model": None,          # actual model string reported by the CLI, if any
        "inputTokens": None,
        "outputTokens": None,
        "totalTokens": None,
        "cacheTokens": None,
        "costUsd": None,
        "tokensEstimated": False,
        "wallMs": None,
        "error": None,
        "cmd": None,
        "stderrTail": None,
    }


# --------------------------------------------------------------------------
# JSON / token extraction helpers
# --------------------------------------------------------------------------

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def extract_json(text):
    """
    Best-effort pull of a JSON object/array out of free-form model text.
    Tries: whole string, fenced ```json block, first balanced {...} or [...].
    Returns the parsed object or None.
    """
    if text is None:
        return None
    text = text.strip()
    # 1. whole thing
    obj = _try_json(text)
    if obj is not None:
        return obj
    # 2. fenced block
    m = _FENCE_RE.search(text)
    if m:
        obj = _try_json(m.group(1).strip())
        if obj is not None:
            return obj
    # 3. first balanced object/array
    for opener, closer in (("{", "}"), ("[", "]")):
        snippet = _balanced(text, opener, closer)
        if snippet:
            obj = _try_json(snippet)
            if obj is not None:
                return obj
    return None


def _try_json(s):
    try:
        return json.loads(s)
    except Exception:
        return None


def _balanced(text, opener, closer):
    start = text.find(opener)
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == opener:
            depth += 1
        elif c == closer:
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


# token-count key aliases seen across CLIs / providers
_INPUT_KEYS = {"input_tokens", "inputtokens", "prompt_tokens", "prompttokencount",
               "prompt_token_count", "input"}
_OUTPUT_KEYS = {"output_tokens", "outputtokens", "completion_tokens",
                "candidatestokencount", "candidates_token_count", "output"}
_TOTAL_KEYS = {"total_tokens", "totaltokens", "totaltokencount", "total_token_count"}


def find_token_nodes(obj):
    """
    Walk an arbitrary parsed JSON structure and yield dicts that look like a
    usage block, normalized to {'input':int|None,'output':int|None,'total':int|None}.
    Used by adapters whose CLIs bury token counts in nested event JSON.
    """
    out = []

    def visit(node):
        if isinstance(node, dict):
            lowered = {str(k).lower(): v for k, v in node.items()}
            inp = _first_int(lowered, _INPUT_KEYS)
            outp = _first_int(lowered, _OUTPUT_KEYS)
            tot = _first_int(lowered, _TOTAL_KEYS)
            if inp is not None or outp is not None or tot is not None:
                out.append({"input": inp, "output": outp, "total": tot})
            for v in node.values():
                visit(v)
        elif isinstance(node, list):
            for v in node:
                visit(v)

    visit(obj)
    return out


def _first_int(lowered, keys):
    for k in keys:
        if k in lowered:
            try:
                return int(lowered[k])
            except (TypeError, ValueError):
                continue
    return None


def estimate_tokens(text):
    """Rough fallback when a CLI exposes no usage. ~4 chars/token."""
    if not text:
        return 0
    return max(1, len(text) // 4)


def word_count(text):
    return len(re.findall(r"\S+", text or ""))


def dotted_get(obj, path):
    """obj['a']['b'][0] via 'a.b.0'. Returns (found, value)."""
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict):
            if part not in cur:
                return False, None
            cur = cur[part]
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return False, None
        else:
            return False, None
    return True, cur


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")
