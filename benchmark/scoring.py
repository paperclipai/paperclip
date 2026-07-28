#!/usr/bin/env python3
"""
scoring.py — turn a model's raw output for a task into a quality score in [0,1].

Two layers:
  1. deterministic checks  — objective, cheap, no LLM. Each check returns pass/fail
     (1.0/0.0); deterministic score = weighted mean. Ground-truth tasks (intake,
     classification) lean entirely on these.
  2. LLM-judge             — a single blind judge model scores subjective criteria
     (correctness/clarity/etc.) in [0,1]. Blind = never told which model wrote the
     output, applied uniformly to all contestants, so rankings stay fair.

Task quality = blend(deterministic, judge) per config scoring weights, collapsing
to whichever layer the task actually defines.
"""

import json

import benchlib
from adapters import run_model


# --------------------------------------------------------------------------
# deterministic checks
# --------------------------------------------------------------------------

def run_deterministic(output, checks):
    """Return (score_0_1, details[]). Empty checks -> (None, [])."""
    if not checks:
        return None, []
    details = []
    total_w = 0.0
    earned = 0.0
    parsed_json = None  # lazily parse once if any json check needs it
    for chk in checks:
        w = float(chk.get("weight", 1))
        total_w += w
        if chk.get("type", "").startswith("json") and parsed_json is None:
            parsed_json = benchlib.extract_json(output)
        ok = _eval_check(output, chk, parsed_json)
        earned += w if ok else 0.0
        details.append({"check": chk.get("type"), "ok": ok,
                        "weight": w, "spec": _spec_summary(chk)})
    score = earned / total_w if total_w else None
    return score, details


def _eval_check(output, chk, parsed_json):
    t = chk.get("type")
    text = output or ""
    if t == "contains":
        v = chk["value"]
        return (v.lower() in text.lower()) if chk.get("ci", True) else (v in text)
    if t == "not_contains":
        v = chk["value"]
        present = (v.lower() in text.lower()) if chk.get("ci", True) else (v in text)
        return not present
    if t == "contains_any":
        vals = chk["values"]
        hay = text.lower() if chk.get("ci", True) else text
        return any((v.lower() if chk.get("ci", True) else v) in hay for v in vals)
    if t == "contains_all":
        vals = chk["values"]
        hay = text.lower() if chk.get("ci", True) else text
        return all((v.lower() if chk.get("ci", True) else v) in hay for v in vals)
    if t == "regex":
        import re
        flags = re.IGNORECASE if chk.get("ci", True) else 0
        if chk.get("dotall"):
            flags |= re.DOTALL
        return re.search(chk["pattern"], text, flags) is not None
    if t == "not_regex":
        import re
        flags = re.IGNORECASE if chk.get("ci", True) else 0
        return re.search(chk["pattern"], text, flags) is None
    if t == "max_words":
        return benchlib.word_count(text) <= int(chk["value"])
    if t == "min_words":
        return benchlib.word_count(text) >= int(chk["value"])
    if t == "max_chars":
        return len(text) <= int(chk["value"])
    if t == "min_chars":
        return len(text) >= int(chk["value"])
    if t == "json_valid":
        return parsed_json is not None
    if t == "json_path_equals":
        found, val = benchlib.dotted_get(parsed_json, chk["path"]) if parsed_json is not None else (False, None)
        if not found:
            return False
        return _norm(val) == _norm(chk["value"])
    if t == "json_path_in":
        found, val = benchlib.dotted_get(parsed_json, chk["path"]) if parsed_json is not None else (False, None)
        if not found:
            return False
        return _norm(val) in [_norm(x) for x in chk["values"]]
    if t == "json_path_exists":
        found, _ = benchlib.dotted_get(parsed_json, chk["path"]) if parsed_json is not None else (False, None)
        return found
    if t == "json_path_len_equals":
        found, val = benchlib.dotted_get(parsed_json, chk["path"]) if parsed_json is not None else (False, None)
        if not found or not isinstance(val, (list, str)):
            return False
        return len(val) == int(chk["value"])
    if t == "json_path_max_chars":
        found, val = benchlib.dotted_get(parsed_json, chk["path"]) if parsed_json is not None else (False, None)
        if not found or not isinstance(val, str):
            return False
        return len(val) <= int(chk["value"])
    if t == "json_path_min_chars":
        found, val = benchlib.dotted_get(parsed_json, chk["path"]) if parsed_json is not None else (False, None)
        if not found or not isinstance(val, str):
            return False
        return len(val) >= int(chk["value"])
    # unknown check type fails closed
    return False


def _norm(v):
    if isinstance(v, str):
        return v.strip().lower()
    return v


def _spec_summary(chk):
    keys = ("value", "values", "pattern", "path")
    return {k: chk[k] for k in keys if k in chk}


# --------------------------------------------------------------------------
# LLM judge
# --------------------------------------------------------------------------

JUDGE_INSTRUCTIONS = """You are an exacting, impartial evaluation judge scoring ONE candidate \
answer to a task. You do NOT know which AI model produced it; judge only the answer's quality.

Score EACH criterion on a continuous 0.0–1.0 scale. CALIBRATE STRICTLY — use the full range and \
DISCRIMINATE between answers; do not default to high scores:
- 1.0  = flawless: nothing a domain expert would change. RARE — reserve it.
- 0.85 = strong, but a careful reviewer would note a small gap, imprecision, or missed nuance.
- 0.6  = adequate: meets the bar but clearly improvable, generic, or partially incomplete.
- 0.3  = weak: significant omission, vagueness, or partial error.
- 0.0  = absent, wrong, or off-task.
If two answers differ in quality they MUST get different scores. Penalize: ignored constraints, \
generic filler, factual/logic errors, missed edge cases, and padding. Reward precision and \
correctness, not length. Base scores ONLY on the stated criteria.

Return ONLY a JSON object, no prose, of the form:
{"scores": {"<criterion>": <0..1>, ...}, "rationale": "<one short specific sentence naming the deciding factor>"}
"""


def judge_output(task, output, judge_cfg, adapters_cfg, timeout_sec):
    """
    Score subjective criteria with the judge model. Returns (score_0_1, detail).
    No criteria -> (None, None).
    """
    criteria = (task.get("rubric", {}).get("judge", {}) or {}).get("criteria")
    if not criteria:
        return None, None
    crit_lines = "\n".join(
        f'- {c["name"]} (weight {c.get("weight", 1)}): {c.get("guidance", "")}'
        for c in criteria
    )
    prompt = (
        JUDGE_INSTRUCTIONS
        + "\n\n=== TASK GIVEN TO THE CANDIDATE ===\n"
        + task["prompt"].strip()
        + "\n\n=== CRITERIA TO SCORE ===\n" + crit_lines
        + "\n\n=== CANDIDATE ANSWER ===\n"
        + (output or "(empty answer)").strip()
        + "\n\n=== END ===\nReturn the JSON now."
    )
    judge_row = {"adapter": judge_cfg["adapter"], "model_arg": judge_cfg.get("model_arg")}
    res = run_model(prompt, judge_row, adapters_cfg, timeout_sec)
    parsed = benchlib.extract_json(res.get("output"))
    if not isinstance(parsed, dict) or "scores" not in parsed:
        return None, {"error": "judge: unparseable", "raw": (res.get("output") or "")[:500],
                      "judgeError": res.get("error")}
    scores = parsed.get("scores", {})
    total_w = 0.0
    earned = 0.0
    per = {}
    for c in criteria:
        name = c["name"]
        w = float(c.get("weight", 1))
        total_w += w
        raw = scores.get(name)
        val = _clamp01(raw)
        per[name] = val
        earned += w * (val if val is not None else 0.0)
    score = earned / total_w if total_w else None
    detail = {"perCriterion": per, "rationale": parsed.get("rationale"),
              "judgeModel": res.get("model") or judge_cfg.get("id")}
    return score, detail


def _clamp01(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, f))


# --------------------------------------------------------------------------
# blend
# --------------------------------------------------------------------------

def blend_quality(det_score, judge_score, scoring_cfg):
    """Collapse the two layers to a single [0,1] quality per config weights."""
    dw = float(scoring_cfg.get("deterministic_weight", 0.5))
    jw = float(scoring_cfg.get("judge_weight", 0.5))
    if det_score is not None and judge_score is not None:
        if dw + jw == 0:
            return (det_score + judge_score) / 2
        return (dw * det_score + jw * judge_score) / (dw + jw)
    if det_score is not None:
        return det_score
    if judge_score is not None:
        return judge_score
    return None


def score_run(task, raw_result, cfg, adapters_cfg, judge_timeout):
    """
    Full scoring for one (task, model) run. Returns a dict merged into the run record.
    Skips the judge entirely if the model produced no usable output.
    """
    if raw_result.get("skipped") or raw_result.get("servedModelMismatch"):
        return {
            "deterministicScore": None,
            "deterministicDetails": [],
            "judgeScore": None,
            "judgeDetail": None,
            "quality": None,
            "qualityPer1kTokens": None,
        }
    output = raw_result.get("output") or ""
    if not raw_result.get("ok") and not output.strip():
        return {
            "deterministicScore": None,
            "deterministicDetails": [],
            "judgeScore": None,
            "judgeDetail": None,
            "quality": None,
            "qualityPer1kTokens": None,
        }
    checks = task.get("rubric", {}).get("deterministic", [])
    det_score, det_details = run_deterministic(output, checks)

    judge_score, judge_detail = None, None
    if raw_result.get("ok") and output.strip():
        judge_score, judge_detail = judge_output(
            task, output, cfg["judge"], adapters_cfg, judge_timeout
        )

    quality = blend_quality(det_score, judge_score, cfg["scoring"])
    tot = raw_result.get("totalTokens")
    qpk = (quality / (tot / 1000.0)) if (quality is not None and tot) else None

    return {
        "deterministicScore": det_score,
        "deterministicDetails": det_details,
        "judgeScore": judge_score,
        "judgeDetail": judge_detail,
        "quality": quality,
        "qualityPer1kTokens": qpk,
    }
