def fallback_reply(message: str, context: dict | None = None) -> str:
    lowered = message.lower()
    context = context or {}
    prefix = "Certainly. "
    if any(x in lowered for x in ["morning", "briefing", "today"]):
        return (
            "Good morning. I have the executive cockpit standing by: priorities, risks, workload, "
            "and decisions requiring your attention. The machine is awake, which is more than can be said "
            "for most dashboards before coffee. Ask for the morning briefing and I will produce it."
        )
    if any(x in lowered for x in ["decision", "simulate", "forecast"]):
        return (
            "I recommend running this through the decision simulator: define the decision, horizon, assumptions, "
            "constraints, upside, downside, and trigger metrics. Guessing is occasionally fashionable; measurement is better."
        )
    if any(x in lowered for x in ["employee", "team", "burnout", "workload"]):
        return (
            "I will assess workload, impact, reliability, innovation, and collaboration, then recommend delegation or rebalancing. "
            "Humans are not batteries, despite what some calendars appear to believe."
        )
    if context.get("llm_error"):
        return (
            "The local language model is not responding, so I am operating in deterministic mode. "
            "Core CEO routines remain available: briefings, decision simulation, reputation scoring, and board packs."
        )
    return prefix + (
        "I can help with CEO briefings, strategic decisions, employee/agent oversight, executive communication, "
        "board preparation, and operational risk monitoring. Give me the objective and I will turn it into action."
    )
