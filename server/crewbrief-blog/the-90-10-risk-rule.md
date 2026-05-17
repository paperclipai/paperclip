---
title: "The 90/10 Risk Rule: How Automated FRATs Can Reduce Pilot Burden Without Reducing Safety"
description: "System pre-fills 90% of risk factors from ops data — pilot confirms or adjusts the remaining 10%. The operational sweet spot for FRAT implementation."
slug: the-90-10-risk-rule
tags: [FRAT, risk-assessment, automation, pilot-workflow, 90-10-rule]
keywords: [90/10 risk rule, automated FRAT pre-fill, pilot risk assessment burden, FRAT implementation, aviation risk scoring]
date: 2026-06-23
author: CrewBrief Operations
readingTime: 9 min
canonical: https://crewbrief.avva.aero/blog/the-90-10-risk-rule
ogImage: /blog/img/og-90-10-rule.png
---

# The 90/10 Risk Rule: How Automated FRATs Can Reduce Pilot Burden Without Reducing Safety

**By CrewBrief Operations** · May 2026 · 7 min read

---

The Flight Risk Assessment Tool (FRAT) is one of the most important safety innovations in modern Part 135 operations. It's also one of the most hated.

Every pilot knows the drill: 25 questions, repeated before every sector. Fatigue level? Same as it was six hours ago. Weather risk? Same airport you've flown into 40 times this year. Crew experience? Same crew. By the third sector of the day, the FRAT becomes an exercise in muscle memory — clicks without cognition. The tool designed to catch risk becomes a checkbox ritual.

The problem isn't the FRAT concept. It's the implementation. A FRAT that requires a pilot to manually enter the same data on every iteration is a FRAT that trains pilots to stop thinking about the answers.

## The Automation Paradox

Aviation has a complicated relationship with automation. On one hand, automation reduces pilot workload and eliminates sources of human error. On the other hand, automation can induce complacency — the pilot out of the loop, monitoring rather than engaging.

FRATs today suffer from the opposite problem: *insufficient* automation. They demand manual data entry for items that are already available in the operational systems — scheduling, weather, crew records — and in doing so, they condition pilots to treat the instrument as busywork rather than a safety tool.

The solution is not to eliminate the human. It's to automate the parts that don't require human judgment and ask the pilot only what only the pilot can answer.

## The 90/10 Principle

In designing CrewBrief's automated FRAT engine, we established a simple target: **the system should self-fill 90-95% of risk factors from available data, asking the pilot to confirm or adjust only the remaining 5-10%.**

What can be automated:

| Factor | Data Source | Automation |
|---|---|---|
| Pilot duty day | Schedule system | Computed from sign-on time |
| Rest period | Schedule system | Calculated from previous duty end |
| Airport familiarity | Operations history | Count of visits to destination in last 90 days |
| Weather conditions | Live METAR/TAF | Scored against airport minimums |
| Aircraft type currency | Crew records | Last 90 days on type |
| Time of day | Scheduled departure | Dawn/dusk/night classification |
| Runway conditions | NOTAMs | Active runway, known hazards |
| Crew pairing | Schedule system | Previous sectors together |

What still requires pilot input:

- Subjective fatigue self-assessment
- Personal stressors (medical, family, financial)
- Any factor the pilot believes the system has mis-scored

The distinction is critical. Objective, measurable factors — duty time, weather, currency — should never require manual re-entry. Subjective factors — *how do you feel right now?* — can only come from the pilot.

## Preserving Human Accountability

The most common objection to FRAT automation is that it undermines accountability. If the system scores a risk as LOW, won't the pilot simply accept that score without thinking?

This objection misunderstands the goal. The goal is not to replace pilot judgment. It's to *focus* that judgment on the factors that actually benefit from it.

A pilot asked to manually enter "duty day length" and "rest period" for the fifth time today is not exercising judgment. They are copying data from one system into another — something computers do better than humans.

A pilot asked to confirm a pre-filled FRAT and explicitly adjust the one factor the system can't assess — "I'm more tired than the duty clock suggests because I slept poorly last night" — is exercising real judgment. The automation has cleared away the noise so the signal is visible.

This is the same principle as the electronic checklist. Studies have shown that well-designed electronic checklists improve compliance and reduce error not because they replace the pilot but because they organize the task such that the pilot can focus on the items that require actual decision-making.

## Scoring Transparency

For automation to preserve trust, the scoring must be transparent. A pilot who sees a RISK SCORE: 14 with no explanation has no basis to evaluate whether that score is correct.

In CrewBrief's FRAT, every factor's contribution to the score is visible and explorable:
- Weather risk: 4 points (crosswind 18 kts, alert threshold: 15 kts)
- Fatigue risk: 3 points (duty day 10h, threshold: 8h)
- Airport risk: 1 point (familiar, visited 12 times in 90 days)
- Total: 8 points — MODERATE RISK, ready gate requires confirmation

The pilot can inspect any factor, see the raw data that produced the score, and override if their situational awareness suggests a different assessment. The override is logged, creating an audit trail for the SMS program.

This transparency serves two purposes. First, it builds trust — pilots can verify that the system is scoring correctly. Second, it educates — over time, pilots develop a more sophisticated understanding of how different factors contribute to overall risk.

## The Ready Gate Integration

The FRAT doesn't exist in isolation. Its output feeds directly into the readiness gate — the final operational checkpoint before engine start.

In CrewBrief's architecture, the readiness gate comprises 9 configurable checks:
1. Operations release received and reviewed
2. Weather review completed
3. NOTAM delta review completed
4. Fuel confirmed against release
5. JetInsight preflight completed
6. FRAT completed and below threshold (or confirmed at MODERATE+)
7. Cabin crew briefed (where applicable)
8. Passenger documentation confirmed
9. International clearance confirmed (where applicable)

The FRAT is not a standalone form to fill and forget. It is one component of an integrated readiness workflow. A pilot completes the FRAT, the score feeds into the readiness calculation, and the system blocks READY status if any gate condition is not met.

## Measuring What Matters

The standard argument against FRAT automation is that it might reduce safety. This is an eminently testable hypothesis. The appropriate metrics are:

- **FRAT completion rate.** Does automation increase or decrease the proportion of flights with a completed FRAT? (Initial data suggests completion rates above 95%, compared to industry estimates of 60-80% for manual FRATs.)
- **Override rate.** How often do pilots override automated scores? A non-zero rate suggests the automation is not replacing judgment — it's informing it.
- **Time to complete.** Is the FRAT taking 30 seconds instead of 3 minutes? That saved time goes back into pre-flight preparation.
- **Relationship to outcomes.** Do automated FRATs correlate with safety events differently than manual FRATs? This is a longer-term question requiring more data.

## The Bottom Line

A FRAT that takes 3 minutes to fill every sector is a FRAT that pilots will rush through, skip, or resent. A FRAT that takes 30 seconds and asks only the questions that require human judgment is a FRAT that pilots will engage with meaningfully.

The 90/10 principle — automate the computable, ask the uncomputable — applies far beyond FRATs. It's a design philosophy for any safety tool that sits between operational data and human decision-making. Compute what you can. Ask what you must. Trust the pilot for the rest.

---

*CrewBrief's automated FRAT is available now for beta operators. [Join the waitlist](https://crewbrief.avva.aero).*
