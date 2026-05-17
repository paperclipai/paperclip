# Deterministic First, AI Second: Why Aviation Software Needs a Safety-First AI Philosophy

**By CrewBrief Operations** · May 2026 · 7 min read

---

Every tech demo this year has the same rhythm: a cursor blinks, a prompt is typed, and an LLM produces something that looks right. In most industries, "looks right" is good enough for a demo. In aviation, it's the beginning of a liability chain.

We built CrewBrief in the middle of the AI gold rush, and we made a deliberate choice that runs against the prevailing wind: **deterministic first, AI second.** The rule is simple — any calculation that could affect flight safety must be handled by hardcoded, auditable, unit-tested rules. AI is permitted only for formatting, summarization, and parsing messy unstructured data. The system must never guess a missing aviation value.

This isn't Luddism. It's a direct response to a property of large language models that makes them unsuitable for safety-critical computation: they are calibrated to produce *plausible* outputs, not *correct* ones.

## The Plausibility Trap

Consider a fuel calculation. An LLM given a block fuel of 18,200 lbs, a taxi burn of 400 lbs, an enroute burn of 12,100 lbs, and a minimum landing fuel of 4,200 lbs might compute:

- Trip fuel = 18,200 - 4,200 = 14,000 lbs
- Reserve = 14,000 - 12,100 - 400 = 1,500 lbs

These numbers are all in the right ballpark. They look like aviation. A tired pilot scanning the output might approve them. But are they correct against the aircraft-specific fuel policy? Does the reserve meet regulatory minimums? Does the CG fall within the certified envelope at that loading? An LLM doesn't know — it produces the *shape* of a correct answer without the guarantees.

Worse, LLMs are non-deterministic. The same input can produce different outputs on successive calls. A flight release approved at 0600 might not pass the same check at 0615, with no data change explaining the discrepancy. That's unacceptable in an operational context where reproducibility is a regulatory expectation.

## What Deterministic Gets You

Hardcoded rules have properties that AI cannot match:

1. **Auditability.** Every fuel uplift calculation can be traced to a specific function, with specific inputs, producing a specific output. The reasoning is not latent in a weight matrix — it's in plain text, reviewable by any qualified pilot or engineer.

2. **Testability.** A rule like "minimum landing fuel for a Gulfstream G-V is 4,200 lbs" can be unit-tested, integration-tested, and regression-tested. There is no "well, it passed on these 100 cases but failed on the 101st" — the rule is either correct for all cases or it isn't.

3. **Determinism.** Same input always produces same output. This matters for operational consistency, for regulatory compliance, and for crew trust. A pilot who sees a fuel number at brief time should be able to rely on it being reproducible.

4. **Composability.** Deterministic rules compose without surprises. The FRAT engine's fatigue score feeds into the readiness gate, which feeds into the operations dashboard. Each layer is independently verifiable.

## Where AI Actually Helps

We are not anti-AI. We use LLMs extensively in CrewBrief — but only in roles where plausibility is acceptable or even desirable:

- **Formatting.** Converting structured briefing data into polished HTML, tailored to flight crew versus cabin crew audiences. If the font size is slightly off on one rendering, it's an annoyance, not a safety event.

- **Summarization.** Condensing a 47-page NOTAM package into the 3 most relevant items for today's sector. If an item ranked 4th instead of 3rd, the pilot still has the full source to consult.

- **Parsing.** Extracting structured data from inbound emails — itineraries, flight plans, weight-and-balance sheets. These documents vary wildly in format, and a deterministic parser would require endless maintenance. Here, AI's tolerance for variation is a feature.

The boundary is clear: if the output could cause someone to make a different decision about whether an aircraft is safe to fly, it must be deterministic. Everything else is fair game.

## The Regulatory Argument

We expect that as AI-assisted aviation tools proliferate, regulators will increasingly ask: *how do you know your system is correct?*

A deterministic architecture provides a straightforward answer: here is the function, here are the tests, here is the input, here is the output. An AI-first architecture must answer: we trained on 10,000 certified flight releases and held out 2,000 for validation, achieving 97.4% accuracy at the token level.

One of these answers closes the conversation. The other opens a discovery.

## The Broader Lesson

The "deterministic first, AI second" principle extends beyond aviation. Any domain with asymmetric consequences — where a wrong answer does far more damage than a right answer does good — should consider the same boundary. Medical dosing, maritime navigation, industrial control, financial settlement. In each case, the cost of a plausible wrong answer is catastrophically higher than the cost of a slightly less polished right one.

AI is remarkably good at the tasks we've assigned it: parsing, formatting, summarizing. It is remarkably bad at the tasks we've deliberately kept from it: calculation, validation, risk scoring. We believe that distinction — the line between the *shape* of correctness and correctness itself — is the most important design decision an aviation software team can make.

CrewBrief will never guess a fuel number. It will never guess a CG position. It will never guess whether a flight is safe to release. It will, however, produce the best-formatted briefing in the industry, summarize your NOTAMs intelligently, and ingest your emails no matter how creatively your dispatch team formats them.

Deterministic where it matters. AI where it helps. That's the philosophy.

---

*CrewBrief is a briefing automation platform for Part 91/135 operators. [Join the beta waitlist](https://crewbrief.avva.aero).*
