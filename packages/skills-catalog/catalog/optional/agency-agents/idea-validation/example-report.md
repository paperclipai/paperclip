# Idea Validation — Example Report

> This file is referenced by SKILL.md. Use this format when producing a validation report.

## Validation: AI-Powered Code Review Bot

### The Idea
A GitHub bot that reviews PRs automatically, catches bugs, suggests improvements, and enforces team conventions.

### Problem Check
- **Is it real pain?** Yes. Code reviews are a bottleneck — PRs wait 4-24 hours for review at most companies.
- **How often?** Daily. Every PR needs review.
- **Spending today?** Teams spend ~20% of senior engineer time on reviews. Some pay for CodeClimate ($15/user/mo) or SonarQube.
- **Demand signals:** "automated code review" — 8.1K monthly searches. r/programming threads about slow PR reviews every month. Multiple HN posts about review fatigue.

### Market Check
- **TAM:** 28M developers worldwide x ~$10/mo = ~$3.4B
- **SAM:** 4M developers at companies with >10 devs (need formal review) x $10/mo = ~$480M
- **SOM:** 50K developers in first 2 years (realistic with PLG) x $10/mo = $6M ARR
- **Trend:** Growing. AI coding tools market expanding 40%+ YoY.

### Competitor Check
| Competitor | What they do | Funding | Weakness |
|-----------|-------------|---------|----------|
| CodeRabbit | AI PR review | $2.5M seed | Generic comments, high noise |
| Sourcery | Python-focused AI review | $5M | Python only, limited languages |
| SonarQube | Static analysis | Public | Rule-based, not AI, slow setup |
| GitHub Copilot | Code completion | Microsoft | Writes code, doesn't review PRs |

### Distribution Check
- **First 100 users:** GitHub Marketplace listing + Show HN + dev Twitter
- **Natural channel:** GitHub Marketplace is a built-in distribution channel
- **CAC estimate:** ~$0 for early users (PLG via marketplace)
- **Network effect:** Weak. Each install is independent.

### Build Check
- **MVP in 2 weeks?** Yes — GitHub webhook + LLM API + comment on PR
- **Hard part:** Reducing false positives. Bad suggestions = uninstall.
- **Legal:** No issues. Code stays in GitHub, model doesn't train on it.

### Verdict: TEST MORE

**Top 3 reasons:**
1. Real pain (review bottleneck is universal), strong search demand
2. Clear distribution channel (GitHub Marketplace)
3. BUT: crowded space, CodeRabbit has traction, differentiation unclear

**#1 risk:** False positive rate. If >30% of comments are noise, teams disable it after a week.

**Cheapest next step:** Build a minimal bot that reviews PRs for ONE thing well (e.g., just security issues). Ship to 10 teams. Measure: do they keep it on after 2 weeks?
