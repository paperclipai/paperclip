from __future__ import annotations


def generate_content(kind: str, topic: str, audience: str, facts: list[str], tone: str) -> dict:
    fact_block = "\n".join(f"- {fact}" for fact in facts) if facts else "- No supporting facts supplied yet. Add evidence before publishing."
    if kind == "pitch_deck":
        artifact = f"""# Pitch Deck Scaffold: {topic}

1. Problem — what pain exists and who feels it.
2. Existing alternatives — why current options disappoint.
3. Solution — Paperclip/JARVIS approach in one sentence.
4. Product demo — core workflow and user outcome.
5. Market — target segment, timing window, distribution path.
6. Business model — pricing, margins, expansion.
7. Traction — proof, usage, revenue, pilots.
8. Moat — data, workflow lock-in, local-first trust, agent orchestration.
9. Roadmap — 30/60/90 day milestones.
10. Ask — decision, funding, partnership, or approval needed.

Facts to include:
{fact_block}
"""
    elif kind == "press_release":
        artifact = f"""FOR IMMEDIATE RELEASE

Paperclip Announces {topic}

Paperclip today announced {topic}, a focused step toward practical, self-hostable AI operations for builders and executive teams.

Key facts:
{fact_block}

The company will prioritize measurable outcomes, transparent governance, and open-source friendly deployment paths.

For media and partnership inquiries, contact the Paperclip CEO Office.
"""
    elif kind == "investor_update":
        artifact = f"""Subject: Investor Update — {topic}

Hello,

Here is the concise update on {topic}.

Highlights:
{fact_block}

Current focus:
- Convert progress into measurable adoption.
- Keep burn low through open-source and self-hosted infrastructure.
- Maintain approval gates for high-impact automation.

Risks:
- Execution bandwidth and integration complexity.
- Signal quality before scaling.

Next checkpoint:
- Confirm one priority metric and one accountable owner.

Regards,
Paperclip CEO Office
"""
    elif kind == "team_update":
        artifact = f"""Subject: Team Update — {topic}

Team,

We are focusing on {topic}. The goal is clear execution without hidden scope.

Known facts:
{fact_block}

What changes now:
- One owner per priority.
- One measurable outcome per workstream.
- Blockers raised early, not theatrically at the end.

Thank you — disciplined execution wins.
"""
    else:
        artifact = f"""# Blog Draft: {topic}

## Why this matters
{topic} matters because AI operations are moving from isolated chats into always-on, governed workflows.

## What we built
Paperclip is building a CEO-grade assistant that combines briefings, decision simulation, agent orchestration, audit trails, and self-hosted deployment.

## Evidence and facts
{fact_block}

## The practical lesson
The correct assistant is not unlimited. It is authorized, observable, useful, and willing to push back when the plan is nonsense.
"""
    return {"kind": kind, "topic": topic, "audience": audience, "tone": tone, "artifact": artifact.strip(), "publish_warning": "Review factual claims and approval status before publishing."}
