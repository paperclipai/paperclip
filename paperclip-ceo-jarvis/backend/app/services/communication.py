def executive_message(audience: str, objective: str, facts: list[str], tone: str) -> str:
    fact_block = "\n".join(f"- {fact}" for fact in facts) if facts else "- No additional facts provided."
    return f"""Subject: {objective}

Hello,

I want to give you a clear update on {objective.lower()}.

Key facts:
{fact_block}

Here is the direction: we will keep the work focused, measurable, and accountable. The next step is to confirm ownership, define the success metric, and remove anything that does not support the outcome.

Please reply with blockers, risks, or dependencies by the next working checkpoint.

Regards,
Paperclip CEO Office

Tone target: {tone}
Audience: {audience}
""".strip()
