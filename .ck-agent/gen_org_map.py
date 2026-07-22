#!/usr/bin/env python3
"""Regenerate ck-org-map.md from the LIVE agent records (incl. each agent's
tool allowlist), so managers delegate based on what an assignee can actually
do. Re-run after any allowlist change:  python3 ~/paperclip/.ck-agent/gen_org_map.py
"""
import json, urllib.request, pathlib

CO = "e651858f-b11b-4b43-aa43-20c1192d7e98"
OUT = pathlib.Path(__file__).parent / "skills" / "ck-org-map.md"

# One-line mission per unit; anything not listed still appears (title only).
BLURB = {
    "GOV-25": "coordinates the workforce, runs the weekly leadership meeting, sets priorities. The front door.",
    "GOV-11": "grades recent work products, routes fix tasks. The quality manager.",
    "REV-04": "researches ONE venue (CRM + its own website) → sourced dossier → hands to REV-06.",
    "REV-05": "finds/validates venue emails (own-site-verified only; never guesses).",
    "REV-06": "drafts ONE bespoke outreach email per venue FROM a dossier. Draft-only.",
    "REV-07": "classifies an inbound venue reply (interested/not-now/no/unclear/objection) + routes it.",
    "REV-08": "books/proposes meetings — the ONLY unit whose JOB is Alan's calendar.",
    "REV-09": "writes pipeline state as real Opportunity records (stage/amount).",
    "REV-10": "reports the CHF forecast (from the espo_forecast tool only, never computed by hand).",
    "REV-11": "surfaces overdue follow-ups.",
    "FIN-10": "the honest money picture.",
    "MKT-01": "finds NEW target venues.",
    "TOOLSMITH-01": "tool architect — when a needed TOOL doesn't exist, delegate the gap HERE; writes the spec + tests and asks Alan for the build decision. Never claims a tool into existence.",
}

with urllib.request.urlopen(f"http://127.0.0.1:3100/api/companies/{CO}/agents") as r:
    agents = json.load(r)

rows = []
for a in agents:
    ck = (a.get("metadata") or {}).get("ck_id")
    if not ck or a.get("status") == "archived" or ck not in BLURB:
        continue
    cfg = a.get("adapterConfig") or {}
    env = cfg.get("env") or {}
    tools = (env.get("CK_TOOLS") or {}).get("value", "")
    adapter = a.get("adapterType") or "unknown"
    model_env = env.get("CK_MODEL")
    if isinstance(model_env, dict):
        model_env = model_env.get("value")
    model = cfg.get("model") or model_env or "?"
    provider = {
        "ck_local": "DeepSeek",
        "claude_local": "Claude",
        "grok_local": "Grok",
        "codex_local": "Codex",
    }.get(adapter, adapter)
    brain = f"{provider} {model}"
    rows.append((ck, a.get("name", ck), tools, brain))
rows.sort()

unit_lines = []
for ck, name, tools, brain in rows:
    unit_lines.append(f"- **{name}** — {BLURB[ck]}\n  - brain: {brain} · tools: `{tools or '(none)'}`")

OUT.write_text(f"""# Skill: CK org map — who does what, WITH WHAT TOOLS, how to delegate
You work inside a managed company. Use this map to route work to the RIGHT unit and to know what
you may decide yourself. Never invent an agent name — only the short codes below exist.

## The goal (everything traces to it)
Place Tres Hermanos cigars in Swiss venues — first recurring B2B revenue. A task that doesn't move
this goal needs a reason to exist.

## Active units (delegate with `create_task`; short codes like "REV-06" are valid assignee ids)
Each unit lists its TOOLS — an agent can ONLY do what its tools allow. Check the tools BEFORE
delegating: if the work needs a tool the assignee doesn't have, it WILL fail silently or fake it.

{chr(10).join(unit_lines)}

## Delegation rules
- One task = one venue = one owner. Put ALL needed context in the task description (account_id,
  the dossier text, prior findings) — the assignee sees only what you give them plus the CRM.
- After delegating, VERIFY the task was created (the tool returns issue_id). If it returned an
  error, say so — never report a delegation that didn't verify.
- **TOOL-MATCH RULE (owner-corrected 2026-07-02):** before delegating, confirm from this map that
  the assignee HAS the tool the task needs (calendar → espo_create_meeting; CRM write →
  espo_set_email/espo_upsert_opportunity; web research → web_fetch; mail read → espo_read_emails;
  drive a real web page — login, JS site, fill/submit a form, contact-form-only venue →
  `browser_act`, held by REV-05 Contact-Finder and REV-04 Account-Researcher). If NO unit has the
  needed tool, do NOT delegate and do NOT improvise a substitute — escalate via `request_decision`:
  name the missing tool and ask Alan to have it built. Tools are implemented in the owner-approved
  coding session, not improvised by operating agents.

## What you may NOT decide (escalate instead, via request_decision or by flagging in your work product)
Outward sends to real venues · money/prices/contracts · retiring or hiring a unit · changing product
facts. These are the owner's (Alan's) calls. Draft and propose; never execute.
""")
print(f"wrote {OUT} — {len(rows)} units")
